/**
 * 助理简报：把会话画像压成「今天该知道的事」，并存快照。
 *
 * 简报是规则拼装出来的（不调模型）：结论必须能指回具体会话，避免"看起来很懂"。
 * 结构固定成这样，画布上按块渲染：
 *   { date, generatedAt, window, totals, sections: [{ key, title, tone, lines: [{text, tone}] }] }
 */

import fs from 'node:fs';
import path from 'node:path';
import { fmtTokens } from './pricing.mjs';

const MAX_ITEMS = 6;

/** 本地日期键：2026-11-15 */
export function dateKey(ms = Date.now()) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function hoursBetween(a, b) {
  return Math.max(0, Math.round(((b - a) / 3_600_000) * 10) / 10);
}

/** 把一串工具名压成一句人话。 */
function progressLine(portrait) {
  const tools = portrait.recentTools ?? [];
  if (!tools.length) return '还没有工具动作';
  const uniq = [...new Set(tools)];
  const labels = uniq.slice(-3).map((t) => {
    if (t === 'bash') return '跑命令';
    if (t === 'read') return '读文件';
    if (t === 'write' || t === 'edit' || t === 'apply_patch') return '改代码';
    if (t === 'grep' || t === 'glob') return '搜代码';
    if (t === 'web_search' || t === 'web_fetch') return '查资料';
    if (t === 'todo_write') return '更新任务清单';
    if (t === 'subagent' || t === 'subagent_fork') return '派子任务';
    if (t === 'present') return '交付文件';
    return t;
  });
  return `最近：${labels.join(' → ')}`;
}

function todoLine(portrait) {
  const list = portrait.todos ?? [];
  if (!list.length) return null;
  const done = list.filter((t) => t.status === 'completed').length;
  const open = list.filter((t) => t.status !== 'completed');
  if (!open.length) return `待办 ${done}/${list.length} 全清`;
  const first = open[0].content.slice(0, 26);
  return `待办 ${done}/${list.length} · 还差「${first}${open[0].content.length > 26 ? '…' : ''}」`;
}

function itemLines(portrait) {
  const lines = [];
  if (portrait.goal?.objective) lines.push({ text: `目标：${portrait.goal.objective.slice(0, 60)}`, tone: 'muted' });
  lines.push({ text: progressLine(portrait), tone: 'muted' });
  const t = todoLine(portrait);
  if (t) lines.push({ text: t, tone: 'muted' });
  if (portrait.usage?.totalTokens) {
    lines.push({ text: `消耗 ${fmtTokens(portrait.usage.totalTokens)} tokens`, tone: 'muted' });
  }
  if (portrait.deliverables?.length) lines.push({ text: `产出 ${portrait.deliverables.length} 个文件`, tone: 'ok' });
  return lines;
}

/**
 * 生成一份简报。
 *
 * @param {object[]} portraits collectPortraits 的结果
 * @param {object} opts { sinceMs, now, scanInfo }
 */
export function composeBrief(portraits, { sinceMs, now = Date.now(), scanInfo = {}, cumulative = null } = {}) {
  // 子代理线程（worker）不算"你的任务"，不计入卡面与本期消耗
  const list = (portraits ?? []).filter((p) => !p.isSubagent);
  const active = list.filter((p) => p.activeInWindow || p.running || p.waiting);
  const done = list.filter((p) => p.status === 'done' || p.goal?.status === 'done');
  const failed = list.filter((p) => p.status === 'failed');
  const waiting = list.filter((p) => p.status === 'waiting');
  const stalled = list.filter((p) => p.status === 'stalled');
  const doing = list.filter((p) => p.status === 'running' || p.status === 'active');

  const tokenTotals = list.reduce((acc, p) => {
    acc.input += p.usage?.inputTokens ?? 0;
    acc.output += p.usage?.outputTokens ?? 0;
    acc.cached += p.usage?.cacheReadTokens ?? 0;
    if (p.usage?.estimated) acc.estimated = true;
    return acc;
  }, { input: 0, output: 0, cached: 0 });

  const todosOpen = list.reduce((n, p) => n + (p.todos ?? []).filter((t) => t.status !== 'completed').length, 0);
  const deliverables = list.reduce((n, p) => n + (p.deliverables?.length ?? 0), 0);
  const goalsDone = list.filter((p) => p.goal?.status === 'done').length;

  const totals = {
    sessions: list.length,
    active: active.length,
    doing: doing.length,
    done: done.length,
    failed: failed.length,
    waiting: waiting.length,
    stalled: stalled.length,
    todosOpen,
    deliverables,
    goalsDone,
    tokens: tokenTotals,
    hours: hoursBetween(sinceMs, now),
  };

  const sections = [];

  // 1) 一句话
  const headline = [
    `活跃 ${active.length} 个任务`,
    doing.length ? `推进中 ${doing.length}` : null,
    done.length ? `已完成 ${done.length}` : null,
    (failed.length + waiting.length + stalled.length)
      ? `需要你出手 ${failed.length + waiting.length + stalled.length}`
      : '没有卡住的',
    `消耗 ${fmtTokens(tokenTotals.input + tokenTotals.output + tokenTotals.cached)} tokens`,
  ].filter(Boolean).join(' · ');
  sections.push({
    key: 'headline',
    title: `过去 ${hoursBetween(sinceMs, now)} 小时`,
    tone: 'normal',
    lines: [{ text: headline, tone: 'strong' }],
  });

  // 2) 需要你出手（放最前面，这是助理的核心价值）
  const attention = [];
  for (const p of waiting) {
    attention.push({
      sessionId: p.sessionId,
      title: p.title,
      lines: [{ text: '在等你回答/审批', tone: 'warn' }, ...itemLines(p).slice(0, 2)],
    });
  }
  for (const p of failed) {
    attention.push({
      sessionId: p.sessionId,
      title: p.title,
      lines: [{ text: p.failure ?? '上次回合失败', tone: 'bad' }, ...itemLines(p).slice(0, 2)],
    });
  }
  for (const p of stalled) {
    attention.push({
      sessionId: p.sessionId,
      title: p.title,
      lines: [
        { text: `${p.idleDays} 天没动，还有 ${p.todosOpen} 项没做完`, tone: 'warn' },
        ...itemLines(p).slice(1, 3),
      ],
    });
  }
  if (attention.length) {
    sections.push({ key: 'attention', title: `需要你出手 · ${attention.length}`, tone: 'warn', items: attention.slice(0, MAX_ITEMS) });
  }

  // 3) 在推进
  if (doing.length) {
    sections.push({
      key: 'doing',
      title: `在推进 · ${doing.length}`,
      tone: 'ok',
      items: doing.slice(0, MAX_ITEMS).map((p) => ({ sessionId: p.sessionId, title: p.title, lines: itemLines(p) })),
    });
  }

  // 4) 已完成
  if (done.length) {
    sections.push({
      key: 'done',
      title: `已完成 · ${done.length}`,
      tone: 'ok',
      items: done.slice(0, MAX_ITEMS).map((p) => ({
        sessionId: p.sessionId,
        title: p.title,
        lines: [
          p.goal?.objective ? { text: `目标：${p.goal.objective.slice(0, 56)}`, tone: 'muted' } : { text: '任务清单已全部完成', tone: 'muted' },
          ...(p.deliverables?.length ? [{ text: `产出 ${p.deliverables.length} 个文件`, tone: 'ok' }] : []),
        ],
      })),
    });
  }

  // 5) 消耗
  const byWorkspace = new Map();
  for (const p of list) {
    if (!p.usage?.totalTokens) continue;
    const key = p.workspace || '未归类';
    const cur = byWorkspace.get(key) ?? { tokens: 0 };
    cur.tokens += p.usage.totalTokens;
    byWorkspace.set(key, cur);
  }
  const costLines = [
    { text: `输入 ${fmtTokens(tokenTotals.input + tokenTotals.cached)}（命中 ${fmtTokens(tokenTotals.cached)}）· 输出 ${fmtTokens(tokenTotals.output)}`, tone: 'muted' },
  ];
  for (const [ws, v] of [...byWorkspace.entries()].sort((a, b) => b[1].tokens - a[1].tokens).slice(0, 4)) {
    costLines.push({ text: `${ws}：${fmtTokens(v.tokens)} tokens`, tone: 'muted' });
  }
  if (scanInfo.truncated) costLines.push({ text: '（扫描超时，未覆盖全部会话）', tone: 'muted' });
  sections.push({ key: 'cost', title: 'token 用量', tone: 'normal', lines: costLines });

  // 5.5) 长期累计（不受快照保留期影响）
  if (cumulative) {
    const lines = [
      { text: `累计 ${fmtTokens(cumulative.tokens)} tokens`, tone: 'strong' },
      { text: `共 ${cumulative.sessions} 个线程 · 覆盖 ${cumulative.days} 天${cumulative.firstDay ? `（${cumulative.firstDay} 起）` : ''}`, tone: 'muted' },
    ];
    sections.push({ key: 'cumulative', title: '长期累计', tone: 'normal', lines });
  }

  return {
    date: dateKey(now),
    generatedAt: now,
    window: { sinceMs, untilMs: now, hours: hoursBetween(sinceMs, now) },
    totals,
    sections,
  };
}

/** 简报在画布便签上的纯文本形态（Agent 工具/命令行也用这个）。 */
export function briefText(brief) {
  const out = [`助理简报 · ${brief.date}`, ''];
  for (const s of brief.sections ?? []) {
    out.push(`【${s.title}】`);
    for (const line of s.lines ?? []) out.push(`· ${line.text}`);
    for (const item of s.items ?? []) {
      out.push(`· ${item.title}`);
      for (const line of item.lines ?? []) out.push(`    ${line.text}`);
    }
    out.push('');
  }
  return out.join('\n').trim();
}

/* ── 快照存取 ─────────────────────────────────────────── */

function briefDir(dataDir) {
  return path.join(dataDir, 'briefs');
}

/** 存一份快照，并按保留天数清理旧文件。 */
export function saveBrief(dataDir, brief, { retentionDays = 90, now = Date.now() } = {}) {
  const dir = briefDir(dataDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${brief.date}.json`);
  const json = JSON.stringify(brief, null, 2);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${json}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  const pruned = pruneBriefs(dataDir, { retentionDays, now });
  return { file, pruned };
}

/** 删除超过保留期的快照，返回删除数量。 */
export function pruneBriefs(dataDir, { retentionDays = 90, now = Date.now() } = {}) {
  const dir = briefDir(dataDir);
  let removed = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  const cutoff = now - retentionDays * 86_400_000;
  for (const name of names) {
    const m = /^(\d{4}-\d{2}-\d{2})\.json$/.exec(name);
    if (!m) continue;
    const t = Date.parse(`${m[1]}T00:00:00`);
    if (!Number.isFinite(t) || t >= cutoff) continue;
    try {
      fs.unlinkSync(path.join(dir, name));
      removed += 1;
    } catch { /* 删不掉就算了 */ }
  }
  return removed;
}

/** 列出历史快照（新的在前）。 */
export function listBriefs(dataDir, { limit = 30 } = {}) {
  const dir = briefDir(dataDir);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().reverse();
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.slice(0, limit)) {
    try {
      out.push(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
    } catch { /* 坏文件跳过 */ }
  }
  return out;
}

/** 读某一天（默认列出的第一天）。 */
export function readBrief(dataDir, date) {
  const file = path.join(briefDir(dataDir), `${date}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
