/**
 * 直接读 DSH 的会话日志（只读）。
 *
 * 为什么不用 sessionQuery：`readSurface` 只给「当前上下文」，被压缩掉的历史看不到，
 * 而长期累计需要全量历史；`readSession` 虽然全，但对上百个会话太慢。
 * 这里自己读 `session.v4.jsonl.zstd`：
 *   · 按 zstd 帧切分后逐帧解压（Node 的 zstd 解压只吃一帧）
 *   · 按 `size:mtimeMs` 签名做增量，没变就用上次的摘要，不重复解析
 *   · 解析失败的行走容错计数，不让整个会话失败
 *
 * 只读，不写 `~/.dsh/sessions`。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 找所有 zstd 帧起点（帧魔数可能出现多次；解不开时会向后合并，见 decodeFrames）。 */
function frameStarts(buf) {
  const starts = [];
  let i = buf.indexOf(MAGIC, 0);
  while (i >= 0) {
    starts.push(i);
    i = buf.indexOf(MAGIC, i + MAGIC.length);
  }
  return starts;
}

/**
 * 多帧 zstd → 文本。
 * 遇到「切错了」的段（魔数恰好出现在压缩数据里）会向后合并重试。
 */
export function decodeFrames(buf) {
  if (typeof zlib?.zstdDecompressSync !== 'function') {
    // 静默失败会产出「空摘要」并被缓存，宁可显式报错让调用方跳过
    throw new Error('当前运行时不支持 zstd 解压（需要 Node 22.15+ / Electron 44+）');
  }
  const starts = frameStarts(buf);
  if (!starts.length) return '';
  const parts = [];
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i];
    let ok = false;
    // 最多向后合并 4 帧再放弃
    for (let j = i; j < Math.min(starts.length, i + 5); j += 1) {
      const to = j + 1 < starts.length ? starts[j + 1] : buf.length;
      try {
        const out = zlib.zstdDecompressSync(buf.subarray(from, to));
        parts.push(out);
        i = j;
        ok = true;
        break;
      } catch {
        // 继续合并下一段
      }
    }
    if (!ok) {
      // 这一帧确实解不开：跳过，记一行空，别影响其它帧
      parts.push(Buffer.from('\n'));
    }
  }
  return Buffer.concat(parts).toString('utf8');
}

/** 解压并逐行解析成事件对象（坏行跳过并计数）。 */
export function decodeSessionFile(file) {
  const buf = fs.readFileSync(file);
  const text = decodeFrames(buf);
  const events = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    const raw = line.trim();
    if (!raw) continue;
    try {
      events.push(JSON.parse(raw));
    } catch {
      bad += 1;
    }
  }
  return { events, badLines: bad, bytes: buf.length };
}

/** DSH 数据根目录。 */
export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 列出所有会话日志文件。
 * 目录结构不完全统一，所以直接按两层目录去找 <sessionId>/session.v4.jsonl.zstd。
 */
export function listSessionLogs(home = dshHome()) {
  const root = path.join(home, 'sessions');
  const out = [];
  let projects = [];
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }
  for (const project of projects) {
    const projectDir = path.join(root, project.name);
    let entries = [];
    try {
      entries = fs.readdirSync(projectDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(projectDir, entry.name, 'session.v4.jsonl.zstd');
      try {
        const st = fs.statSync(file);
        out.push({
          sessionId: entry.name,
          projectKey: project.name,
          file,
          sig: `${st.size}:${Math.round(st.mtimeMs)}`,
          size: st.size,
          mtimeMs: st.mtimeMs,
        });
      } catch {
        // 不是会话目录
      }
    }
  }
  return out;
}

/** 读工作区注册表：sessionId → { id, title, path }。 */
export function readWorkspaces(home = dshHome()) {
  const map = new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'workspace.json'), 'utf8'));
    const table = raw?.tables?.workspaces ?? {};
    for (const [id, ws] of Object.entries(table)) {
      const title = String(ws?.title || (ws?.path ? String(ws.path).split('/').filter(Boolean).pop() : ''));
      for (const sid of ws?.sessionIds ?? []) map.set(String(sid), { id, title, path: ws?.path ?? '' });
    }
  } catch {
    // 没有注册表就按目录名兜底
  }
  return map;
}

/** 读投影缓存里的 DSH Session Goal（比从日志里找 create_goal 更权威）。 */
export function readCachedGoal(home, sessionId) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(home, 'storages', 'session_projcache', 'sessions', `${sessionId}.json`), 'utf8'));
    const goal = raw?.record?.rows?.goal?.val?.current;
    if (!goal) return null;
    const objective = String(goal.objective ?? goal.text ?? goal.title ?? '').trim();
    if (!objective) return null;
    return { objective: objective.slice(0, 500), status: goal.status ? String(goal.status) : 'active' };
  } catch {
    return null;
  }
}

/* ── 摘要提取 ─────────────────────────────────────────── */

function safeJson(raw) {
  if (!raw) return null;
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
}

function parseTodos(raw) {
  const args = safeJson(raw);
  const list = Array.isArray(args?.todos) ? args.todos : null;
  if (!list) return null;
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const content = String(item.content ?? '').trim();
    if (!content) continue;
    const status = item.status === 'completed' || item.status === 'in_progress' ? item.status : 'pending';
    out.push({ content: content.slice(0, 300), status });
  }
  return out.length ? out : null;
}

function dayOf(time) {
  return new Date(Number(time) || Date.now()).toLocaleDateString('sv-SE'); // YYYY-MM-DD（本地时区）
}

/**
 * 从事件流里提炼「摘要」。这是缓存的单位：文件签名不变就复用。
 *
 * @param {object[]} events
 * @param {{ costOf: (usage:object, model:string, time:number) => {usd:number, known:boolean} }} deps
 */
export function digestEvents(events, { costOf }) {
  const d = {
    sessionId: '',
    cwd: '',
    createdAt: 0,
    title: '',
    goal: null,
    todos: null,
    todosAt: 0,
    deliverables: [],
    lastTools: [],
    turns: 0,
    userMessages: 0,
    lastTurnEnd: null,
    lastActivity: 0,
    usageByDay: {},
    usageTotals: { input: 0, output: 0, cached: 0, usd: 0, estimated: false },
    badLines: 0,
  };

  for (const event of events ?? []) {
    const type = event?.type;
    const time = Number(event?.time) || 0;
    if (time > d.lastActivity) d.lastActivity = time;

    if (type === 'session') {
      // 头事件：类型字段就叫 session，带真实 id / cwd / createdAt
      const data = event ?? {};
      if (data.id) d.sessionId = String(data.id);
      if (data.cwd) d.cwd = String(data.cwd);
      if (data.createdAt) d.createdAt = Number(data.createdAt);
      continue;
    }

    if (type === 'session/title') {
      const title = String(event?.data?.title ?? '').trim();
      if (title && !title.startsWith('/')) d.title = title.slice(0, 120);
      continue;
    }
    if (type === 'turn/start') { d.turns += 1; continue; }
    if (type === 'turn/end') { d.lastTurnEnd = { reason: event?.data?.reason ?? null, time }; continue; }
    if (type === 'user/message') { d.userMessages += 1; continue; }

    if (type === 'deliverables/presented') {
      for (const f of event?.data?.files ?? []) {
        const p = typeof f === 'string' ? f : f?.path;
        if (p && !d.deliverables.includes(p)) d.deliverables.push(String(p));
      }
      continue;
    }

    if (type === 'todo/write') {
      const todos = parseTodos(event?.data?.todos ?? event?.data);
      if (todos) { d.todos = todos; d.todosAt = time; }
      continue;
    }

    if (type === 'assistant/message') {
      const msg = event?.data?.message;
      const usage = event?.data?.usage;
      if (usage) {
        const model = msg?.source?.model ?? '';
        const cost = costOf(usage, model, time);
        const day = dayOf(time);
        const bucket = d.usageByDay[day] ?? { input: 0, output: 0, cached: 0, usd: 0 };
        const input = Number(usage.inputTokens) || 0;
        const output = Number(usage.outputTokens) || 0;
        const cached = Number(usage.cacheReadTokens) || 0;
        bucket.input += input;
        bucket.output += output;
        bucket.cached += cached;
        bucket.usd += cost.usd;
        d.usageByDay[day] = bucket;
        d.usageTotals.input += input;
        d.usageTotals.output += output;
        d.usageTotals.cached += cached;
        d.usageTotals.usd += cost.usd;
        if (cost.known === false) d.usageTotals.estimated = true;
      }
      for (const block of msg?.content ?? []) {
        if (block?.type !== 'tool-call') continue;
        const name = String(block.name ?? '');
        if (!name) continue;
        d.lastTools.push(name);
        if (d.lastTools.length > 40) d.lastTools.shift();

        if (name === 'todo_write') {
          const todos = parseTodos(block.arguments);
          if (todos) { d.todos = todos; d.todosAt = time; }
        } else if (name === 'create_goal') {
          const args = safeJson(block.arguments);
          if (args?.objective) d.goal = { objective: String(args.objective).slice(0, 500), status: 'active' };
        } else if (name === 'update_goal') {
          const args = safeJson(block.arguments);
          if (args?.action && d.goal) {
            d.goal.status = args.action === 'complete' ? 'done' : args.action === 'blocked' ? 'blocked' : 'active';
          }
        } else if (name === 'present') {
          const args = safeJson(block.arguments);
          for (const f of args?.files ?? []) {
            const p = f?.path;
            if (p && !d.deliverables.includes(p)) d.deliverables.push(String(p));
          }
        }
      }
    }
  }

  d.deliverables = d.deliverables.slice(0, 12);
  d.usageTotals.totalTokens = d.usageTotals.input + d.usageTotals.output + d.usageTotals.cached;
  return d;
}

/* ── 摘要缓存（按文件签名增量） ───────────────────────── */

const CACHE_FILE = 'session-digests.json';
/** 摘要格式版本：不兼容时整份缓存作废（例如解压失败曾写入空摘要）。 */
const DIGEST_CACHE_VERSION = 2;

export function loadDigestCache(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dataDir, CACHE_FILE), 'utf8'));
    if (raw && raw.version === DIGEST_CACHE_VERSION && raw.sessions && typeof raw.sessions === 'object') {
      return { version: DIGEST_CACHE_VERSION, sessions: raw.sessions };
    }
  } catch {
    // 没有缓存就是空
  }
  return { version: DIGEST_CACHE_VERSION, sessions: {} };
}

export function saveDigestCache(dataDir, cache) {
  try {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const file = path.join(dataDir, CACHE_FILE);
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(cache)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // 缓存写不进去不影响主流程
  }
}
