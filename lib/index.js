/* dsh-secretary host bundle — 由 build-client.mjs 生成，勿手改 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const boardMod = (() => {
/**
 * DSH 助理 —— 数据层（纯函数，不碰 IO）。
 *
 * 便签模型：
 *   { id, text, done, x, y, color, createdAt, updatedAt, doneAt,
 *     updates: [{ id, text, at }],                  ← 自己记的进展
 *     todos:   [{ content, status }],               ← 从会话导入的待办清单
 *     source:  { kind:'session', id, title, workspace, updatedAt, syncedAt } | null,
 *     kind:    'note' | 'brief',                    ← brief = 助理生成的简报卡
 *     cancelled: true,                              ← 放弃的任务：不计入没做完，重拉也不会复活
 *     review: { at, seq } | null,                   ← 线程刚跑完一轮，等你验收
 *     stages: [{ at, items }],                      ← 同一线程里的连续任务（每个阶段的清单）
 *     goal: string | null,                          ← 这个线程的任务目标（优先取 DSH Goal）
 *     deliverables: string[],                       ← 产出文件路径
 *     brief:   { date, totals, sections } | null }
 *
 * x / y 是画布坐标（像素）。新建便签由调用方指定位置，这里只做兜底。
 */

const COLORS = ['yellow', 'pink', 'green', 'blue', 'purple', 'orange'];

const DEFAULT_BOARD = { version: 1, notes: [] };

function newId(prefix = 'n') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 限额只用来兜住"异常大的输入"，不是业务裁剪：
 * 超限时**明确报错**（HTTP 400 + 原因），不再静默截断丢掉用户内容。
 */
const LIMITS = {
  text: 100_000,       // 单张便签正文
  update: 20_000,      // 一条进展
  updates: 2_000,      // 每张便签的进展条数
  todo: 2_000,         // 一条待办
  todos: 500,          // 每张便签的待办条数
  deliverables: 50,    // 产出文件
  goal: 5_000,         // 任务目标
  history: 100,        // 单卡变更历史（只保留最近，超出丢最旧并标记）
};

/** 超限就抛错；不裁剪。 */
function requireText(value, max, label) {
  const text = String(value ?? '');
  if (text.length > max) {
    throw new Error(`${label}超过上限（${text.length} / ${max} 字）`);
  }
  return text;
}

/** 读历史数据时的兜底：只挡明显异常的（1MB 以上），不按业务上限裁。 */
const HARD_CAP = 1_000_000;

function clampRaw(value) {
  return String(value ?? '').slice(0, HARD_CAP);
}

/** 把磁盘上读到的任意东西修成合法 board。 */
function normalizeBoard(raw) {
  const board = { version: 1, notes: [] };
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.notes)) return board;
  for (const n of raw.notes) {
    if (!n || typeof n !== 'object') continue;
    const id = typeof n.id === 'string' && n.id ? n.id : newId();
    const note = {
      id,
      text: clampRaw(n.text),
      done: n.done === true,
      x: Number.isFinite(Number(n.x)) ? Number(n.x) : 40,
      y: Number.isFinite(Number(n.y)) ? Number(n.y) : 40,
      color: COLORS.includes(n.color) ? n.color : COLORS[0],
      createdAt: Number(n.createdAt) || Date.now(),
      updatedAt: Number(n.updatedAt) || Number(n.createdAt) || Date.now(),
      doneAt: Number(n.doneAt) || null,
      updates: [],
      todos: [],
      source: null,
      kind: n.kind === 'brief' ? 'brief' : 'note',
      cancelled: n.cancelled === true,
      stages: Array.isArray(n.stages)
        ? n.stages.filter((st) => st && Array.isArray(st.items) && st.items.length).slice(-20).map((st) => ({
          at: Number(st.at) || 0,
          items: st.items.slice(0, 50).map((it) => ({
            content: clampRaw(it?.content).slice(0, 300),
            status: it?.status === 'completed' || it?.status === 'in_progress' ? it.status : 'pending',
          })),
        }))
        : [],
      goal: typeof n.goal === 'string' && n.goal.trim() ? n.goal.slice(0, 500) : null,
      deliverables: Array.isArray(n.deliverables)
        ? n.deliverables.filter((d) => typeof d === 'string' && d).slice(0, 12)
        : [],
      review: n.review && typeof n.review === 'object'
        ? { at: Number(n.review.at) || Date.now(), seq: Number(n.review.seq) || 0 }
        : null,
      history: [],
      historyTruncated: false,
      brief: null,
    };
    if (Array.isArray(n.history)) {
      for (const h of n.history) {
        if (!h || typeof h !== 'object') continue;
        const kind = String(h.kind ?? '').slice(0, 40);
        if (!kind) continue;
        note.history.push({ at: Number(h.at) || 0, kind, text: clampRaw(h.text).slice(0, 500) });
        if (note.history.length >= LIMITS.history) { note.historyTruncated = true; break; }
      }
    }
    if (n.kind === 'brief' && n.brief && typeof n.brief === 'object' && Array.isArray(n.brief.sections)) {
      note.brief = {
        date: String(n.brief.date ?? ''),
        generatedAt: Number(n.brief.generatedAt) || 0,
        window: n.brief.window ?? null,
        totals: n.brief.totals ?? null,
        sections: n.brief.sections.slice(0, 12),
      };
    }
    if (Array.isArray(n.todos)) {
      for (const t of n.todos) {
        if (!t || typeof t !== 'object') continue;
        const content = clampRaw(t.content).trim();
        if (!content) continue;
        const status = t.status === 'completed' || t.status === 'in_progress' ? t.status : 'pending';
        note.todos.push({ content, status });
        if (note.todos.length >= LIMITS.todos) break;
      }
    }
    if (n.source && typeof n.source === 'object' && n.source.kind === 'session' && n.source.id) {
      note.source = {
        kind: 'session',
        id: String(n.source.id),
        title: clampRaw(n.source.title),
        workspace: clampRaw(n.source.workspace),
        updatedAt: Number(n.source.updatedAt) || 0,
        syncedAt: Number(n.source.syncedAt) || 0,
      };
    }
    if (Array.isArray(n.updates)) {
      for (const u of n.updates) {
        if (!u || typeof u !== 'object') continue;
        const text = clampRaw(u.text).trim();
        if (!text) continue;
        note.updates.push({ id: typeof u.id === 'string' && u.id ? u.id : newId('u'), text, at: Number(u.at) || Date.now() });
        if (note.updates.length >= LIMITS.updates) break;
      }
    }
    board.notes.push(note);
  }
  return board;
}

/**
 * 追加一条变更历史（只保留最近 N 条，超出丢最旧并打标记）。
 * 目的：单卡改了什么、什么时候改的，事后可追。
 */
function pushHistory(note, kind, text, now = Date.now()) {
  if (!note.history) note.history = [];
  note.history.push({ at: now, kind: String(kind).slice(0, 40), text: String(text ?? '').slice(0, 500) });
  if (note.history.length > LIMITS.history) {
    note.history.splice(0, note.history.length - LIMITS.history);
    note.historyTruncated = true;
  }
  return note;
}

/** 看板统计：总数 / 已完成 / 未完成。 */
function stats(board) {
  // 简报卡不是待办；已放弃的也不算「没做完」
  const tasks = board.notes.filter((n) => n.kind !== 'brief' && !n.cancelled);
  let done = 0;
  for (const n of tasks) if (n.done) done += 1;
  const cancelled = board.notes.filter((n) => n.kind !== 'brief' && n.cancelled).length;
  return {
    total: tasks.length,
    done,
    open: tasks.length - done,
    cancelled,
    briefs: board.notes.filter((n) => n.kind === 'brief').length,
  };
}

function findNote(board, id) {
  return board.notes.find((n) => n.id === id) ?? null;
}

/** 新增便签。位置没给就自动排到画布左上。 */
function addNote(board, input = {}, now = Date.now()) {
  const text = requireText(input.text, LIMITS.text, '便签正文').trim();
  if (!text) throw new Error('便签内容不能为空');
  const count = board.notes.length;
  const note = {
    id: newId(),
    text,
    done: false,
    x: Number.isFinite(Number(input.x)) ? Number(input.x) : 40 + (count % 6) * 200,
    y: Number.isFinite(Number(input.y)) ? Number(input.y) : 40 + Math.floor(count / 6) * 160,
    color: COLORS.includes(input.color) ? input.color : COLORS[count % COLORS.length],
    createdAt: now,
    updatedAt: now,
    doneAt: null,
    updates: [],
    todos: Array.isArray(input.todos) ? input.todos.slice(0, 50) : [],
    source: input.source ?? null,
  };
  board.notes.push(note);
  pushHistory(note, 'created', text, now);
  return note;
}

/** 勾选 / 取消勾选。done 时间跟着变。 */
function setDone(board, id, done, now = Date.now()) {
  const note = findNote(board, id);
  if (!note) throw new Error(`便签不存在：${id}`);
  note.done = done === true;
  note.doneAt = note.done ? now : null;
  if (note.done) note.review = null;
  note.updatedAt = now;
  pushHistory(note, note.done ? 'done' : 'undone', note.text.slice(0, 80), now);
  return note;
}

/** 改正文 / 颜色 / 位置。只改传入的字段。 */
function updateNote(board, id, patch = {}, now = Date.now()) {
  const note = findNote(board, id);
  if (!note) throw new Error(`便签不存在：${id}`);
  if (patch.text !== undefined) {
    const text = requireText(patch.text, LIMITS.text, '便签正文').trim();
    if (!text) throw new Error('便签内容不能为空');
    if (text !== note.text) pushHistory(note, 'text', `改为：${text.slice(0, 60)}`, now);
    note.text = text;
  }
  if (patch.color !== undefined && COLORS.includes(patch.color)) note.color = patch.color;
  if (patch.x !== undefined && Number.isFinite(Number(patch.x))) note.x = Number(patch.x);
  if (patch.y !== undefined && Number.isFinite(Number(patch.y))) note.y = Number(patch.y);
  if (patch.done !== undefined) {
    note.done = patch.done === true;
    note.doneAt = note.done ? (note.doneAt ?? now) : null;
  }
  if (patch.cancelled !== undefined) {
    const next = patch.cancelled === true;
    if (next !== note.cancelled) pushHistory(note, next ? 'cancelled' : 'restored', note.text.slice(0, 60), now);
    note.cancelled = next;
    if (note.cancelled) note.doneAt = null;
  }
  if (patch.review !== undefined) {
    note.review = patch.review && typeof patch.review === 'object'
      ? { at: Number(patch.review.at) || now, seq: Number(patch.review.seq) || 0 }
      : null;
  }
  note.updatedAt = now;
  return note;
}

/** 追加一条进展。 */
function addUpdate(board, id, text, now = Date.now()) {
  const note = findNote(board, id);
  if (!note) throw new Error(`便签不存在：${id}`);
  const body = requireText(text, LIMITS.update, '进展内容').trim();
  if (!body) throw new Error('进展内容不能为空');
  const update = { id: newId('u'), text: body, at: now };
  note.updates.push(update);
  pushHistory(note, 'progress', body.slice(0, 120), now);
  if (note.updates.length > LIMITS.updates) {
    throw new Error(`进展太多（${note.updates.length} 条，上限 ${LIMITS.updates}）`);
  }
  note.updatedAt = now;
  return update;
}

/** 删一条进展。 */
function removeUpdate(board, id, updateId) {
  const note = findNote(board, id);
  if (!note) throw new Error(`便签不存在：${id}`);
  const before = note.updates.length;
  note.updates = note.updates.filter((u) => u.id !== updateId);
  if (note.updates.length === before) throw new Error(`进展不存在：${updateId}`);
  note.updatedAt = Date.now();
  return note;
}

/** 删便签。 */
function removeNote(board, id) {
  const idx = board.notes.findIndex((n) => n.id === id);
  if (idx < 0) throw new Error(`便签不存在：${id}`);
  const [removed] = board.notes.splice(idx, 1);
  return removed;
}

/**
 * 把扫到的会话清单同步进看板：一个会话一张卡，卡里挂它自己的待办。
 *
 * 去重与覆盖规则（宁可不更新，也不覆盖你手改的内容）：
 *   · 没有来源相同的卡 → 新建
 *   · 有卡、且你自上次同步后没动过它（updatedAt <= source.syncedAt）→ 刷新标题/清单/完成状态
 *   · 有卡、但你动过（改了字、勾了、记了进展）→ 跳过，计入 skipped
 *
 * @param {{sessionId:string,title:string,workspace?:string,updatedAt?:number,
 *          todos:{content:string,status:string}[]}[]} snapshots
 */
/** 排布常量：和浏览器端保持一致（一行 11 张，224×172）。 */
const GRID = { cols: 9, margin: 40, stepX: 264, stepY: 216, width: 248, height: 200 };

/** 找一个不和已有便签相交的网格空位。 */
function nextFreeSlot(board) {
  const { cols, margin, stepX, stepY, width, height } = GRID;
  const hits = (x, y) => board.notes.some((n) => (
    x < n.x + width + 16 && x + width + 16 > n.x && y < n.y + height + 16 && y + height + 16 > n.y
  ));
  for (let i = 0; i < 400; i += 1) {
    const x = margin + (i % cols) * stepX;
    const y = margin + Math.floor(i / cols) * stepY;
    if (!hits(x, y)) return { x, y };
  }
  return { x: margin, y: margin };
}

function importSessions(board, snapshots, now = Date.now(), colorSeed = 0) {
  const report = { created: 0, updated: 0, skipped: 0, notes: [] };
  const list = Array.isArray(snapshots) ? snapshots : [];

  for (const snap of list) {
    const sessionId = String(snap?.sessionId ?? '');
    if (!sessionId) continue;
    const todos = (Array.isArray(snap.todos) ? snap.todos : []).slice(0, 50);
    if (!todos.length) continue;

    const title = String(snap.title ?? '').slice(0, 200) || `会话 ${sessionId.slice(0, 8)}`;
    const allDone = todos.every((t) => t.status === 'completed');
    const existing = board.notes.find((n) => n.source?.kind === 'session' && n.source.id === sessionId);

    if (!existing) {
      const count = board.notes.length;
      const slot = nextFreeSlot(board);
      const note = {
        id: newId(),
        text: title,
        done: allDone,
        x: slot.x,
        y: slot.y,
        color: COLORS[(colorSeed + count) % COLORS.length],
        createdAt: now,
        updatedAt: now,
        doneAt: allDone ? now : null,
        updates: [],
        todos: todos.map((t) => ({ content: String(t.content), status: t.status })),
        stages: Array.isArray(snap.stages) ? snap.stages.slice(-20) : [],
        goal: snap.goal ? String(snap.goal).slice(0, 500) : null,
        deliverables: Array.isArray(snap.deliverables) ? snap.deliverables.slice(0, 12) : [],
        source: {
          kind: 'session',
          id: sessionId,
          title,
          workspace: String(snap.workspace ?? '').slice(0, 200),
          updatedAt: Number(snap.updatedAt) || 0,
          syncedAt: now,
        },
      };
      board.notes.push(note);
      pushHistory(note, 'imported', `从会话「${title}」导入 ${todos.length} 条待办`, now);
      report.created += 1;
      report.notes.push({ id: note.id, title, action: 'created' });
      continue;
    }

    // 系统字段（目标/产出）不覆盖你的编辑，但可以补齐：排版、拖拽都会动 updatedAt，
    // 不能因为「卡片被摆过」就永远补不上。
    const fillSystem = () => {
      if (snap.goal) existing.goal = String(snap.goal).slice(0, 500);
      if (Array.isArray(snap.deliverables) && snap.deliverables.length) {
        existing.deliverables = snap.deliverables.slice(0, 12);
      }
      if (Array.isArray(snap.stages) && snap.stages.length) {
        existing.stages = snap.stages.slice(-20);
      }
      // 标题跟随线程：只有「当前标题仍等于上次系统给的标题」时才覆盖，
      // 你自己改过的标题永远不动。
      const previous = existing.source?.title ?? '';
      if (title && existing.text === previous && title !== previous) {
        pushHistory(existing, 'title', `线程标题变为：${title.slice(0, 60)}`, now);
        existing.text = title;
      }
      if (existing.source) existing.source.title = title;
    };

    if (existing.cancelled) {
      fillSystem();
      report.skipped += 1;
      report.notes.push({ id: existing.id, title: existing.text, action: 'skipped' });
      continue;
    }
    const untouched = existing.updatedAt <= (existing.source?.syncedAt ?? 0);
    if (!untouched) {
      fillSystem();
      report.skipped += 1;
      report.notes.push({ id: existing.id, title: existing.text, action: 'skipped' });
      continue;
    }

    existing.text = title;
    existing.todos = todos.map((t) => ({ content: String(t.content), status: t.status }));
    if (Array.isArray(snap.stages) && snap.stages.length) existing.stages = snap.stages.slice(-20);
    existing.goal = snap.goal ? String(snap.goal).slice(0, 500) : null;
    existing.deliverables = Array.isArray(snap.deliverables) ? snap.deliverables.slice(0, 12) : [];
    existing.source = {
      kind: 'session',
      id: sessionId,
      title,
      workspace: String(snap.workspace ?? existing.source?.workspace ?? '').slice(0, 200),
      updatedAt: Number(snap.updatedAt) || 0,
      syncedAt: now,
    };
    existing.done = allDone;
    existing.doneAt = allDone ? (existing.doneAt ?? now) : null;
    existing.updatedAt = now;
    pushHistory(existing, 'synced', `从会话同步 ${todos.length} 条待办`, now);
    report.updated += 1;
    report.notes.push({ id: existing.id, title, action: 'updated' });
  }

  return report;
}

/**
 * 把一份简报放到画布上：同一天只保留一张，重复生成就地更新。
 * 简报卡比普通便签宽，所以单独找一个 380 宽的空位。
 */
function upsertBriefNote(board, brief, now = Date.now()) {
  // 先清掉别的日期的旧简报卡（含旧口径文本），再找今天这张
  board.notes = board.notes.filter((n) => n.kind !== 'brief' || n.brief?.date === brief.date);
  const existing = board.notes.find((n) => n.kind === 'brief' && n.brief?.date === brief.date);
  const payload = {
    date: brief.date,
    generatedAt: brief.generatedAt,
    window: brief.window,
    totals: brief.totals,
    sections: brief.sections,
  };
  if (existing) {
    existing.text = `助理简报 · ${brief.date}`;
    existing.brief = payload;
    existing.updatedAt = now;
    return { note: existing, created: false };
  }

  const width = 360;
  const height = 420;
  const hits = (x, y) => board.notes.some((n) => {
    const w = n.kind === 'brief' ? width : GRID.width;
    const h = n.kind === 'brief' ? height : GRID.height;
    return x < n.x + w + 16 && x + w + 16 > n.x && y < n.y + h + 16 && y + h + 16 > n.y;
  });
  let spot = { x: GRID.margin, y: GRID.margin };
  for (let i = 0; i < 200; i += 1) {
    const x = GRID.margin + (i % 6) * (width + 16);
    const y = GRID.margin + Math.floor(i / 6) * (height + 16);
    if (!hits(x, y)) { spot = { x, y }; break; }
  }

  const note = {
    id: newId('b'),
    text: `助理简报 · ${brief.date}`,
    done: false,
    x: spot.x,
    y: spot.y,
    color: 'blue',
    createdAt: now,
    updatedAt: now,
    doneAt: null,
    updates: [],
    todos: [],
    source: null,
    kind: 'brief',
    brief: payload,
  };
  board.notes.push(note);
  return { note, created: true };
}

/**
 * 批量改位置（排版用）：一次落盘，避免「排 15 张卡就写 15 次整块看板」。
 * @param {{id:string,x:number,y:number}[]} patches
 */
function applyPositions(board, patches, now = Date.now()) {
  const index = new Map(board.notes.map((n) => [n.id, n]));
  let moved = 0;
  for (const p of patches ?? []) {
    const note = index.get(String(p?.id ?? ''));
    if (!note) continue;
    const x = Number(p.x);
    const y = Number(p.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (note.x === x && note.y === y) continue;
    note.x = x;
    note.y = y;
    note.updatedAt = now;
    moved += 1;
  }
  return { moved };
}

/**
 * 按来源会话批量删卡（用来清理早期误导入的子代理卡）。
 * 来源 id 可能带或不带 `session-` 前缀，两边都试。
 * @returns 被删掉的便签标题
 */
function removeNotesBySources(board, sessionIds) {
  const want = new Set();
  for (const raw of sessionIds ?? []) {
    const id = String(raw);
    want.add(id);
    want.add(id.startsWith('session-') ? id.slice('session-'.length) : `session-${id}`);
  }
  const removed = [];
  board.notes = board.notes.filter((n) => {
    const src = String(n.source?.id ?? '');
    if (src && want.has(src)) { removed.push(n.text); return false; }
    return true;
  });
  return removed;
}

/** 时间戳 → 2026-11-16 14:20 */
function fmtTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '—';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 把一张便签导出成完整的 Markdown（含历史，便于长期留档）。 */
function noteToMarkdown(note) {
  if (!note) throw new Error('便签不存在');
  const state = note.cancelled ? '已放弃' : note.done ? '已完成' : '未完成';
  const out = [];
  out.push(`# ${note.text.split('\n')[0].slice(0, 80) || '未命名便签'}`);
  out.push('');
  out.push(`- 状态：${state}`);
  out.push(`- 创建：${fmtTime(note.createdAt)}`);
  out.push(`- 更新：${fmtTime(note.updatedAt)}`);
  if (note.doneAt) out.push(`- 完成：${fmtTime(note.doneAt)}`);
  if (note.source) {
    out.push(`- 来源线程：${note.source.title || note.source.id}${note.source.workspace ? `（${note.source.workspace}）` : ''}`);
  }
  out.push('');
  out.push('## 正文');
  out.push('');
  out.push(note.text);
  if (note.goal) {
    out.push('', '## 任务目标', '', note.goal);
  }
  if ((note.todos ?? []).length) {
    out.push('', '## 待办');
    for (const t of note.todos) {
      const mark = t.status === 'completed' ? 'x' : ' ';
      const tag = t.status === 'in_progress' ? '（进行中）' : '';
      out.push(`- [${mark}] ${t.content}${tag}`);
    }
  }
  if ((note.updates ?? []).length) {
    out.push('', '## 进展');
    for (const u of note.updates) out.push(`- ${fmtTime(u.at)} ${u.text}`);
  }
  if ((note.deliverables ?? []).length) {
    out.push('', '## 产出');
    for (const f of note.deliverables) out.push(`- \`${f}\``);
  }
  if ((note.history ?? []).length) {
    out.push('', `## 变更历史（最近 ${note.history.length} 条${note.historyTruncated ? '，更早的已丢弃' : ''}）`);
    for (const h of note.history) out.push(`- ${fmtTime(h.at)} \`${h.kind}\` ${h.text}`);
  }
  out.push('', `---`, `导出时间：${fmtTime(Date.now())} · dsh-secretary`);
  return `${out.join('\n')}\n`;
}

/** Agent 用的纯文本摘要。 */
function summaryText(board) {
  const s = stats(board);
  const lines = [`看板：共 ${s.total} 张便签，已完成 ${s.done}，未完成 ${s.open}。`];
  const open = board.notes.filter((n) => !n.done && !n.cancelled && n.kind !== 'brief');
  const done = board.notes.filter((n) => n.done && n.kind !== 'brief');
  const dropped = board.notes.filter((n) => n.cancelled);
  if (open.length) {
    lines.push('未完成：');
    for (const n of open) {
      const last = n.updates[n.updates.length - 1];
      const from = n.source ? `（来自会话：${n.source.title}）` : '';
      const todoLines = (n.todos ?? []).length
        ? `\n${n.todos.map((t) => `    · [${t.status === 'completed' ? 'x' : t.status === 'in_progress' ? '~' : ' '}] ${t.content}`).join('\n')}`
        : '';
      lines.push(`- [${n.id}] ${n.text}${from}${last ? `（最新进展：${last.text}）` : ''}${todoLines}`);
    }
  }
  if (done.length) {
    lines.push('已完成：');
    for (const n of done) lines.push(`- [${n.id}] ${n.text}`);
  }
  if (dropped.length) {
    lines.push('已放弃：');
    for (const n of dropped) lines.push(`- [${n.id}] ${n.text}`);
  }
  return lines.join('\n');
}

return { DEFAULT_BOARD, normalizeBoard, stats, addNote, updateNote, setDone, addUpdate, removeUpdate, removeNote, findNote, summaryText, COLORS, newId, importSessions, upsertBriefNote, nextFreeSlot, applyPositions, pushHistory, noteToMarkdown, removeNotesBySources, LIMITS };
})();

const storeMod = (() => {
/**
 * 看板落盘：~/.dsh/workbench/board.json。
 *
 * 纯文件、可读、可以直接用编辑器看。写入用「临时文件 + rename」保证原子性，
 * 读失败不会把已有数据清空。
 *
 * 并发：所有写操作走同一条 promise 队列，避免两个标签页同时拖便签时互相覆盖半个文件。
 */


function defaultDataDir() {
  return path.join(os.homedir(), '.dsh', 'secretary');
}

class BoardStore {
  constructor(dataDir) {
    this.dataDir = dataDir || defaultDataDir();
    this.file = path.join(this.dataDir, 'board.json');
    this.queue = Promise.resolve();
    this.warned = false;
  }

  /** 读盘。文件不存在 / 解析失败都给一个干净看板（不抛错，面板至少能打开）。 */
  read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT' && !this.warned) {
        this.warned = true;
        console.warn(`[workbench] 读看板失败：${error?.message ?? error}`);
      }
      return normalizeBoard(DEFAULT_BOARD);
    }
    try {
      return normalizeBoard(JSON.parse(raw));
    } catch (error) {
      // 解析失败：把坏文件留一份副本，别直接覆盖掉用户数据。
      const backup = `${this.file}.broken-${Date.now()}`;
      try { fs.copyFileSync(this.file, backup); } catch { /* 忽略 */ }
      console.warn(`[workbench] 看板 JSON 解析失败，已备份到 ${backup}：${error?.message ?? error}`);
      return normalizeBoard(DEFAULT_BOARD);
    }
  }

  write(board) {
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(board, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, this.file);
    return board;
  }

  /** 串行地做一次读-改-写，返回 { board, result }。 */
  mutate(fn) {
    const run = async () => {
      const board = this.read();
      const result = fn(board);
      this.write(board);
      return { board, result };
    };
    const next = this.queue.then(run, run);
    // 队列本身不因为单次失败而断掉
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  addNote(input) { return this.mutate((b) => addNote(b, input)); }
  updateNote(id, patch) { return this.mutate((b) => updateNote(b, id, patch)); }
  setDone(id, done) { return this.mutate((b) => setDone(b, id, done)); }
  addUpdate(id, text) { return this.mutate((b) => addUpdate(b, id, text)); }
  removeUpdate(id, updateId) { return this.mutate((b) => removeUpdate(b, id, updateId)); }
  removeNote(id) { return this.mutate((b) => removeNote(b, id)); }
}

return { BoardStore, defaultDataDir };
})();

const logsMod = (() => {
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
function decodeFrames(buf) {
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
function decodeSessionFile(file) {
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
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

/**
 * 列出所有会话日志文件。
 * 目录结构不完全统一，所以直接按两层目录去找 <sessionId>/session.v4.jsonl.zstd。
 */
function listSessionLogs(home = dshHome()) {
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

/** 从会话日志头里读 cwd（不需要 sessionQuery；两种 id 写法都试）。 */
function readSessionCwd(home, sessionId) {
  const raw = String(sessionId ?? '').trim();
  if (!raw) return '';
  const bare = raw.startsWith('session-') ? raw.slice('session-'.length) : raw;
  const names = [...new Set([raw, bare, `session-${bare}`])];
  let projects = [];
  try {
    projects = fs.readdirSync(path.join(home ?? dshHome(), 'sessions'), { withFileTypes: true })
      .filter((d) => d.isDirectory());
  } catch {
    return '';
  }
  for (const project of projects) {
    for (const name of names) {
      const file = path.join(home ?? dshHome(), 'sessions', project.name, name, 'session.v4.jsonl.zstd');
      try {
        const { events } = decodeSessionFile(file);
        const head = events.find((e) => e.type === 'session');
        if (head?.cwd) return String(head.cwd);
      } catch {
        // 换下一个写法
      }
    }
  }
  return '';
}

/** 读工作区注册表：sessionId → { id, title, path }。 */
function readWorkspaces(home = dshHome()) {
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
function readCachedGoal(home, sessionId) {
  // 投影缓存的文件名用裸 uuid，而会话日志头里的 id 可能带 session- 前缀：两种都试
  const id = String(sessionId ?? '');
  const bare = id.startsWith('session-') ? id.slice('session-'.length) : id;
  const candidates = [...new Set([bare, id].filter(Boolean))];
  for (const candidate of candidates) {
    try {
      const found = readGoalFile(home, candidate);
      if (found) return found;
    } catch {
      // 换下一个写法
    }
  }
  return null;
}

function readGoalFile(home, sessionId) {
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

/**
 * 记一个任务阶段。
 *
 * 判定「还是同一个任务」用**内容重合度**，不是全等：
 * 同一任务在推进时经常增删条目（9 条 → 10 条、措辞微调），
 * 全等判断会把这些都当成新任务（deepbao 曾因此出现 9 个假阶段）。
 * 重合度 ≥ 50% 视为同一阶段，只把最新状态写回去。
 */
const STAGE_SAME_TASK_OVERLAP = 0.5;

/** 归一化：去掉空白与标点，用于判断「首条任务是否还是同一个」。 */
function normalizeTask(text) {
  return String(text ?? '').toLowerCase().replace(/[\s`~!@#$%^&*()_+\-={}\[\]|\\:;"'<>,.?/，。；：！？、（）【】《》""'']/g, '');
}

function contentSet(items) {
  return new Set(items.map((t) => String(t.content)));
}

function pushStage(d, todos, at) {
  if (!todos?.length) return;
  const items = todos.map((t) => ({ content: t.content, status: t.status }));
  const current = d.stages[d.stages.length - 1];
  if (current) {
    const prev = contentSet(current.items);
    const next = contentSet(items);
    let shared = 0;
    for (const c of next) if (prev.has(c)) shared += 1;
    const overlap = shared / Math.max(prev.size, next.size, 1);

    // 同一任务的两种情形：
    //  1) 条目重合度 ≥ 50%（追加/勾选/小改）
    //  2) 首条任务没变（任务目标没变，只是后面的步骤被重写了措辞）
    const prevFirst = normalizeTask(current.items[0]?.content);
    const nextFirst = normalizeTask(items[0]?.content);
    const sameHead = prevFirst && nextFirst && (prevFirst === nextFirst
      || prevFirst.startsWith(nextFirst) || nextFirst.startsWith(prevFirst));

    if (overlap >= STAGE_SAME_TASK_OVERLAP || sameHead) {
      current.items = items; // 同一任务：采用最新清单与状态
      return;
    }
  }
  d.stages.push({ at, items });
  if (d.stages.length > 20) d.stages.shift();
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
 */
function digestEvents(events) {
  const d = {
    sessionId: '',
    cwd: '',
    createdAt: 0,
    origin: '',
    parentSession: '',
    title: '',
    goal: null,
    todos: null,
    todosAt: 0,
    stages: [],        // [{ at, items: [{content,status}] }] 同一线程里的连续任务
    deliverables: [],
    lastTools: [],
    turns: 0,
    userMessages: 0,
    lastTurnEnd: null,
    lastActivity: 0,
    usageByDay: {},
    usageTotals: { input: 0, output: 0, cached: 0 },
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
      if (data.origin) d.origin = String(data.origin);
      if (data.parentSession) d.parentSession = String(data.parentSession);
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
        const day = dayOf(time);
        const bucket = d.usageByDay[day] ?? { input: 0, output: 0, cached: 0 };
        const input = Number(usage.inputTokens) || 0;
        const output = Number(usage.outputTokens) || 0;
        const cached = Number(usage.cacheReadTokens) || 0;
        bucket.input += input;
        bucket.output += output;
        bucket.cached += cached;
        d.usageByDay[day] = bucket;
        d.usageTotals.input += input;
        d.usageTotals.output += output;
        d.usageTotals.cached += cached;
      }
      for (const block of msg?.content ?? []) {
        if (block?.type !== 'tool-call') continue;
        const name = String(block.name ?? '');
        if (!name) continue;
        d.lastTools.push(name);
        if (d.lastTools.length > 40) d.lastTools.shift();

        if (name === 'todo_write') {
          const todos = parseTodos(block.arguments);
          if (todos) { d.todos = todos; d.todosAt = time; pushStage(d, todos, time); }
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
const DIGEST_CACHE_VERSION = 5; // 3: 阶段按内容切分（旧版按状态切分，会过度切分）

function loadDigestCache(dataDir) {
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

function saveDigestCache(dataDir, cache) {
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

return { dshHome, decodeFrames, decodeSessionFile, listSessionLogs, readWorkspaces, readCachedGoal, readSessionCwd, digestEvents, loadDigestCache, saveDigestCache };
})();

const insightsMod = (() => {
/**
 * 会话画像：把一个线程压成一张「任务卡」。
 *
 * 数据来自**直接读会话日志**（见 logs.mjs），不再依赖 readSurface：
 *   · 能覆盖完整历史（压缩掉的也算得出来）
 *   · 按文件签名增量，没变的会话不重复解析
 *   · 消耗按事件发生的日期分桶，长期累计才准
 *
 * 运行/等待状态仍问一次 DSH 的 session 服务（只有近期活跃的会话才问，失败不影响画像）。
 */


function failureOf(lastTurnEnd) {
  const kind = lastTurnEnd?.reason?.kind;
  if (kind === 'error') return `上次回合出错：${lastTurnEnd.reason?.error?.message ?? '未知错误'}`;
  if (kind === 'aborted') return '上次回合被中断';
  if (kind === 'blocked') return '上次回合被拦截';
  if (kind === 'max-tokens') return '上次回合触顶（输出过长）';
  return null;
}

/**
 * @param {object} opts
 * @param {object} opts.ctx cordis 上下文（只用来问实时运行状态）
 * @param {string} opts.dataDir 插件数据目录（放摘要缓存）
 * @param {(m:string)=>void} opts.log
 * @param {number} opts.sinceMs 报告窗口起点
 * @param {number} [opts.maxSessions] 最多看多少个会话
 * @param {number} [opts.maxParse] 这次最多解析多少个「新增/有改动」的日志
 * @param {number} [opts.staleDays]
 * @param {number} [opts.budgetMs]
 */
async function collectPortraits({
  ctx, dataDir, log, sinceMs, maxSessions = 400, maxParse = 400, staleDays = 3, staleMaxDays = 14, budgetMs = 30000,
  onProgress,
}) {
  const started = Date.now();
  const now = Date.now();

  const logs = listSessionLogs().sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, Math.max(1, maxSessions));
  if (!logs.length) return { portraits: [], scanned: 0, parsed: 0, pending: 0, error: '没有找到会话日志' };

  const report = typeof onProgress === 'function' ? onProgress : () => {};
  report({ phase: '读取会话日志', done: 0, total: logs.length });

  const cache = loadDigestCache(dataDir);
  const workspaces = readWorkspaces();
  const live = typeof ctx?.get === 'function' ? ctx.get('sessionController') : undefined;

  const portraits = [];
  let parsed = 0;
  let pending = 0;
  let cacheDirty = false;

  for (const entry of logs) {
    const cached = cache.sessions[entry.sessionId];
    let digest = cached && cached.sig === entry.sig ? cached.digest : null;

    if (!digest) {
      if (parsed >= maxParse || Date.now() - started > budgetMs) {
        pending += 1;
        // 解析预算用完了：这次先用旧摘要（如果有），没有就跳过
        if (!cached?.digest) continue;
        digest = cached.digest;
      } else {
        try {
          const { events, badLines } = decodeSessionFile(entry.file);
          if (!events.length) {
            log(`会话 ${entry.sessionId.slice(0, 14)} 没解析出任何事件，跳过（不写缓存）`);
            continue;
          }
          digest = digestEvents(events);
          digest.badLines = badLines;
          cache.sessions[entry.sessionId] = { sig: entry.sig, digest };
          cacheDirty = true;
          parsed += 1;
          // 每解析 10 个报一次，别让进度回调本身拖慢扫描
          if (parsed % 10 === 0) report({ phase: '解析会话日志', done: parsed, total: logs.length });
        } catch (error) {
          log(`解析会话 ${entry.sessionId.slice(0, 14)} 失败：${error?.message ?? error}`);
          continue;
        }
      }
    }

    const sessionId = digest.sessionId || entry.sessionId;
    // 子代理线程（我派出去的 worker）不是"你的任务"：卡面和简报都不该出现它们，
    // 但它们的花费是真的，仍然计入长期累计。
    const isSubagent = digest.origin === 'subagent' || Boolean(digest.parentSession);
    const workspace = workspaces.get(sessionId) ?? workspaces.get(entry.sessionId);
    const updatedAt = Number(entry.mtimeMs) || digest.lastActivity || 0;
    const recentActive = updatedAt >= sinceMs || (digest.lastActivity || 0) >= sinceMs;

    // 实时运行/等待状态：只问最近半小时活跃的会话，避免无谓调用
    let state = null;
    if (live && now - updatedAt < 30 * 60_000) {
      try {
        state = await live.state({ sessionId });
      } catch {
        state = null;
      }
    }

    const todos = digest.todos ?? [];
    const todosDone = todos.filter((t) => t.status === 'completed').length;
    const todosOpen = todos.length - todosDone;
    const failure = failureOf(digest.lastTurnEnd);
    // 只有「真的报错」且是这两天的事才叫需要你出手；
    // 手动中断/被拦截、以及一周前的 401/503，都不该继续占着提醒位。
    const fatalError = digest.lastTurnEnd?.reason?.kind === 'error';
    const running = state?.running === true;
    const waiting = (state?.pendingInput ?? []).length > 0;
    const idleDays = updatedAt ? (now - updatedAt) / 86_400_000 : 0;

    // 目标：投影缓存里的 DSH Goal 最权威，其次日志里 create_goal 的记录
    const cachedGoal = readCachedGoal(undefined, sessionId);
    const goal = cachedGoal ?? digest.goal ?? null;

    let status = 'idle';
    if (running) status = 'running';
    else if (waiting) status = 'waiting';
    else if (fatalError && idleDays <= 2) status = 'failed';
    else if (todos.length && todosDone === todos.length) status = 'done';
    // 只有「最近停下的」才提醒：三个月没动的旧线程不该天天催
    else if (todosOpen > 0 && idleDays >= staleDays && idleDays <= staleMaxDays) status = 'stalled';
    else if (recentActive) status = 'active';

    const usage = sumUsage(Object.values(digest.usageByDay ?? {}).map((v) => ({
      inputTokens: v.input, outputTokens: v.output, cacheReadTokens: v.cached,
    })));

    const title = (digest.title
      || (digest.cwd ? String(digest.cwd).split('/').filter(Boolean).pop() : '')
      || `会话 ${sessionId.slice(-8)}`).slice(0, 120);

    portraits.push({
      sessionId,
      isSubagent,
      title,
      workspace: workspace?.title ?? '',
      workspaceId: workspace?.id ?? '',
      cwd: digest.cwd || workspace?.path || '',
      createdAt: digest.createdAt || 0,
      updatedAt,
      live: Boolean(state),
      running,
      waiting,
      status,
      failure,
      goal: goal ? { objective: goal.objective, status: goal.status ?? 'active' } : null,
      todos,
      stages: digest.stages ?? [],
      todosDone,
      todosOpen,
      turns: digest.turns ?? 0,
      toolCalls: (digest.lastTools ?? []).length,
      recentTools: (digest.lastTools ?? []).slice(-6),
      deliverables: (digest.deliverables ?? []).slice(0, 8),
      usage,
      usageByDay: digest.usageByDay ?? {},
      activeInWindow: recentActive,
      idleDays: Math.max(0, Math.round(idleDays * 10) / 10),
    });
  }

  report({ phase: '汇总', done: portraits.length, total: logs.length });
  if (cacheDirty) saveDigestCache(dataDir, cache);

  portraits.sort((a, b) => b.updatedAt - a.updatedAt);
  return {
    portraits,
    scanned: logs.length,
    parsed,
    pending,
    truncated: pending > 0,
    totalSessions: logs.length,
    error: null,
  };
}

return { collectPortraits };
})();

const sessionsMod = (() => {
/**
 * 会话扫描（「拉取线程任务」用）：底层复用 logs.mjs 的日志摘要，
 * 所以和简报、长期累计看到的是同一份数据。
 */


/**
 * 列出「有待办清单」的会话。
 *
 * @param {object} opts
 * @param {object} opts.ctx
 * @param {string} opts.dataDir
 * @param {(m:string)=>void} opts.log
 * @param {number} [opts.limit] 最多看多少个最近会话
 * @param {number} [opts.budgetMs]
 */
async function scanSessions({ ctx, dataDir, log, limit = 60, budgetMs = 20000, onProgress }) {
  const result = await collectPortraits({
    ctx,
    dataDir,
    log,
    sinceMs: Date.now() - 30 * 86_400_000, // 活跃窗口只影响运行状态判断，这里放宽
    maxSessions: Math.max(1, limit),
    maxParse: 400,
    budgetMs,
    onProgress,
  });
  if (result.error) return { sessions: [], scanned: 0, truncated: false, error: result.error };

  const sessions = result.portraits
    .filter((p) => !p.isSubagent)
    .filter((p) => p.todos.length)
    .map((p) => ({
      sessionId: p.sessionId,
      title: p.title,
      workspace: p.workspace,
      live: p.running || p.waiting,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      todos: p.todos,
      stages: p.stages ?? [],
      goal: p.goal?.objective ?? null,
      deliverables: p.deliverables ?? [],
    }));

  return {
    sessions,
    subagentIds: result.portraits.filter((p) => p.isSubagent).map((p) => p.sessionId),
    scanned: result.scanned,
    truncated: result.truncated === true,
    error: null,
  };
}

/** 兼容导出：从 todo_write 的参数里解析清单。 */
function parseTodoArguments(raw) {
  if (!raw) return null;
  let args;
  try {
    args = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return null;
  }
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

return { scanSessions, parseTodoArguments };
})();

const cumulativeMod = (() => {
/**
 * 长期累计账本：只加不减，不受简报 90 天保留期影响。
 *
 * 结构（`<dataDir>/cumulative.json`）：
 *   {
 *     version: 1,
 *     updatedAt: 0,
 *     sessions: {
 *       [sessionId]: {
 *         updatedAt: <会话最后更新时间>,
 *         days: { 'YYYY-MM-DD': { input, output, cached } }
 *       }
 *     }
 *   }
 *
 * 为什么按「会话」存而不是直接累加总数：
 *   · 同一段历史会被多次读到（每次生成简报都会扫），直接累加会重复计数
 *   · 以会话为单位整段替换，重复读同样的日志结果不变（幂等）
 *   · 会话更新后再读一次，会覆盖成新的分布，不会越加越多
 */


const FILE = 'cumulative.json';

function emptyLedger() {
  return { version: 1, updatedAt: 0, sessions: {} };
}

function fileOf(dataDir) {
  return path.join(dataDir, FILE);
}

function loadLedger(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(dataDir), 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.sessions) return emptyLedger();
    return { version: 1, updatedAt: Number(raw.updatedAt) || 0, sessions: raw.sessions };
  } catch {
    return emptyLedger();
  }
}

function saveLedger(dataDir, ledger, now = Date.now()) {
  const next = { ...ledger, updatedAt: now };
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = fileOf(dataDir);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}

/** 这个会话是不是已经按当前版本记过账了。 */
function isIngested(ledger, sessionId, updatedAt) {
  const rec = ledger.sessions?.[String(sessionId)];
  if (!rec) return false;
  return Number(rec.updatedAt) === Number(updatedAt);
}

/**
 * 把一次完整日志的「按天用量」并入账本（整段替换该会话）。
 * @param {object} ledger
 * @param {string} sessionId
 * @param {number} updatedAt 会话最后更新时间，用来判断是否需要重读
 * @param {Record<string, {input:number, output:number, cached:number}>} days
 */
function ingest(ledger, sessionId, updatedAt, days) {
  const id = String(sessionId);
  const clean = {};
  for (const [day, v] of Object.entries(days ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !v) continue;
    clean[day] = {
      input: Number(v.input) || 0,
      output: Number(v.output) || 0,
      cached: Number(v.cached) || 0,
    };
  }
  ledger.sessions[id] = { updatedAt: Number(updatedAt) || 0, days: clean };
  return ledger;
}

/** 所有会话所有天的合计。 */
function totals(ledger) {
  const total = { input: 0, output: 0, cached: 0, days: new Set(), sessions: 0 };
  for (const rec of Object.values(ledger.sessions ?? {})) {
    const days = rec?.days ?? {};
    const keys = Object.keys(days);
    if (!keys.length) continue;
    total.sessions += 1;
    for (const day of keys) {
      const v = days[day];
      total.input += v.input ?? 0;
      total.output += v.output ?? 0;
      total.cached += v.cached ?? 0;
      total.days.add(day);
    }
  }
  const days = [...total.days].sort();
  return {
    input: total.input,
    output: total.output,
    cached: total.cached,
    tokens: total.input + total.output + total.cached,
    sessions: total.sessions,
    days: days.length,
    firstDay: days[0] ?? null,
    lastDay: days[days.length - 1] ?? null,
  };
}

/** 最近 N 天的每日用量（给趋势用）。 */
function dailySeries(ledger, limit = 14) {
  const byDay = new Map();
  for (const rec of Object.values(ledger.sessions ?? {})) {
    for (const [day, v] of Object.entries(rec?.days ?? {})) {
      const cur = byDay.get(day) ?? { day, input: 0, output: 0, cached: 0 };
      cur.input += v.input ?? 0;
      cur.output += v.output ?? 0;
      cur.cached += v.cached ?? 0;
      byDay.set(day, cur);
    }
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-limit);
}

return { emptyLedger, loadLedger, saveLedger, isIngested, ingest, totals, dailySeries };
})();

const pricingMod = (() => {
/**
 * token 用量的格式化与汇总（**不做费用计算**）。
 *
 * 字段语义（用真实日志核对过）：
 *   inputTokens      = 未命中缓存的输入 token
 *   cacheReadTokens  = 命中缓存的输入 token
 *   outputTokens     = 输出 token
 *   totalTokens      = 未命中 + 输出 + 命中
 */

/** 把 token 数写成好读的形式：12.3k / 1.24M / 1.45B。 */
function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

/** 汇总一组用量记录。 */
function sumUsage(entries) {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 };
  for (const e of entries ?? []) {
    total.inputTokens += Number(e.inputTokens) || 0;
    total.outputTokens += Number(e.outputTokens) || 0;
    total.cacheReadTokens += Number(e.cacheReadTokens) || 0;
    total.calls += 1;
  }
  total.totalTokens = total.inputTokens + total.outputTokens + total.cacheReadTokens;
  const prompt = total.inputTokens + total.cacheReadTokens;
  total.cacheHitRate = prompt > 0 ? total.cacheReadTokens / prompt : 0;
  return total;
}

return { fmtTokens, sumUsage };
})();

const briefMod = (() => {
/**
 * 助理简报：把会话画像压成「今天该知道的事」，并存快照。
 *
 * 简报是规则拼装出来的（不调模型）：结论必须能指回具体会话，避免"看起来很懂"。
 * 结构固定成这样，画布上按块渲染：
 *   { date, generatedAt, window, totals, sections: [{ key, title, tone, lines: [{text, tone}] }] }
 */


const MAX_ITEMS = 6;

/** 本地日期键：2026-11-15 */
function dateKey(ms = Date.now()) {
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
function composeBrief(portraits, { sinceMs, now = Date.now(), scanInfo = {}, cumulative = null } = {}) {
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
function briefText(brief) {
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
function saveBrief(dataDir, brief, { retentionDays = 90, now = Date.now() } = {}) {
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
function pruneBriefs(dataDir, { retentionDays = 90, now = Date.now() } = {}) {
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
function listBriefs(dataDir, { limit = 30 } = {}) {
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
function readBrief(dataDir, date) {
  const file = path.join(briefDir(dataDir), `${date}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

return { composeBrief, briefText, dateKey, saveBrief, pruneBriefs, listBriefs, readBrief };
})();

const settingsMod = (() => {
/**
 * 用户设置：存在数据目录的 settings.json，改完立即生效（不用重启）。
 *
 *   { dailyTime: '08:00', retentionDays: 90, enabled: true }
 *
 * dailyTime 是**本机时区**的 HH:MM；retentionDays 是简报快照保留天数。
 */


const DEFAULT_SETTINGS = { dailyTime: '08:00', retentionDays: 90, enabled: true };

function fileOf(dataDir) {
  return path.join(dataDir, 'settings.json');
}

function normalizeTime(value) {
  const raw = String(value ?? '').trim();
  const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function readSettings(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(dataDir), 'utf8'));
    return sanitize(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function sanitize(raw = {}) {
  const time = normalizeTime(raw.dailyTime) ?? DEFAULT_SETTINGS.dailyTime;
  const days = Number(raw.retentionDays);
  const retentionDays = Number.isFinite(days) ? Math.min(3650, Math.max(1, Math.round(days))) : DEFAULT_SETTINGS.retentionDays;
  return { dailyTime: time, retentionDays, enabled: raw.enabled !== false };
}

function writeSettings(dataDir, patch = {}) {
  const next = sanitize({ ...readSettings(dataDir), ...patch });
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = fileOf(dataDir);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}

return { DEFAULT_SETTINGS, readSettings, writeSettings, sanitize };
})();

const briefingMod = (() => {
/**
 * 简报执行器：扫会话 → 拼简报 → 存快照 → 放到画布。
 *
 * 面板按钮、每日定时器、Agent 工具都调这一个函数，保证三条路径的结果一致。
 */


/**
 * @param {object} opts
 * @param {object} opts.ctx cordis 上下文
 * @param {object} opts.store BoardStore
 * @param {string} opts.dataDir
 * @param {(m:string)=>void} opts.log
 * @param {number} [opts.sinceHours] 回溯多少小时，默认 24
 * @param {object} [opts.settings] 覆盖设置（定时器直接传入当前设置）
 * @param {boolean} [opts.placeOnBoard] 是否落到画布，默认 true
 */
async function runBrief({ ctx, store, dataDir, log, sinceHours = 24, settings, placeOnBoard = true, onProgress }) {
  const cfg = settings ?? readSettings(dataDir);
  const now = Date.now();
  const sinceMs = now - Math.max(1, Math.min(24 * 30, Number(sinceHours) || 24)) * 3_600_000;

  // 长期账本：没记过账的会话也读一次，把历史补进去（每次上限由 maxUsageSessions 控制）
  const ledger = loadLedger(dataDir);
  const scan = await collectPortraits({ ctx, dataDir, log, sinceMs, onProgress });
  if (scan.error) throw new Error(scan.error);

  // 有完整日志的会话把按天用量并进账本（整段替换，重复读不会重复计数）
  let ingested = 0;
  for (const p of scan.portraits) {
    if (!p.usageByDay || !Object.keys(p.usageByDay).length) continue;
    ingest(ledger, p.sessionId, p.updatedAt, p.usageByDay);
    ingested += 1;
  }
  if (ingested) saveLedger(dataDir, ledger, now);
  const cumulative = ledgerTotals(ledger);

  const brief = composeBrief(scan.portraits, {
    sinceMs,
    now,
    scanInfo: { truncated: scan.truncated },
    cumulative,
  });
  brief.scan = { sessions: scan.scanned, usageReads: scan.usageReads ?? 0, truncated: scan.truncated === true };
  brief.cumulative = cumulative;

  if (typeof onProgress === 'function') onProgress({ phase: '生成简报', done: 1, total: 1 });
  const saved = saveBrief(dataDir, brief, { retentionDays: cfg.retentionDays, now });

  let note = null;
  let created = false;
  if (placeOnBoard) {
    const result = await store.mutate((board) => upsertBriefNote(board, brief, now));
    note = result.result.note;
    created = result.result.created;
  }

  return {
    brief,
    text: briefText(brief),
    noteId: note?.id ?? null,
    created,
    pruned: saved.pruned,
    date: dateKey(now),
    cumulative,
    scan: { sessions: scan.scanned, truncated: scan.truncated === true },
  };
}

/** 定时器用：今天已经生成过就跳过。 */
async function runScheduledBrief({ ctx, store, dataDir, log, settings }) {
  const cfg = settings ?? readSettings(dataDir);
  const today = dateKey(Date.now());
  const board = store.read();
  const existing = board.notes.find((n) => n.kind === 'brief' && n.brief?.date === today);
  if (existing) return { skipped: true, reason: '今天已经有简报', date: today };
  return { skipped: false, ...(await runBrief({ ctx, store, dataDir, log, settings: cfg })) };
}

return { runBrief, runScheduledBrief };
})();

const httpMod = (() => {
/**
 * DSH 助理 HTTP 路由 —— 面板读写看板的唯一入口。
 *
 * 挂在 DSH 自己的 webServer 上（不开新端口），前端 fetch `/workbench/api/*`。
 *
 * 写操作要求 `X-Workbench-Token`：令牌启动时随机生成，通过
 * `webserver/index-inject` 注入页面。这样同机其它网页无法跨站改你的看板。
 */


const ROUTE_PREFIX = '/workbench/api';
const TOKEN_GLOBAL_KEY = '__WORKBENCH_TOKEN__';
const TOKEN_FILE = 'api-token';

function loadOrCreateToken(dataDir) {
  const file = path.join(dataDir, TOKEN_FILE);
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch { /* 不存在就生成 */ }
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

/** 把 URL 的 query 读成普通对象。 */
function readQuery(url) {
  const out = {};
  try {
    const u = new URL(String(url ?? ''), 'http://127.0.0.1');
    for (const [k, v] of u.searchParams.entries()) out[k] = v;
  } catch {
    // URL 坏掉就当没有参数
  }
  return out;
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 256 * 1024) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('请求体必须是对象');
  return parsed;
}

/** 统一的响应格式：{ board, stats }，前端整块替换本地状态。 */
function payload(board) {
  return { board, stats: stats(board) };
}

function registerHttpRoutes(ctx, { store, log, scanOptions }) {
  const dataDir = store.dataDir;
  const connection = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;

  /** 进度：长任务（扫描/解析）跑的时候，面板能问「现在到哪一步了」。 */
  const progress = { running: false, task: '', phase: '', done: 0, total: 0, startedAt: 0, finishedAt: 0 };
  function trackProgress(task, fn) {
    progress.running = true;
    progress.task = task;
    progress.phase = '准备中';
    progress.done = 0;
    progress.total = 0;
    progress.startedAt = Date.now();
    progress.finishedAt = 0;
    const onProgress = ({ phase, done, total }) => {
      progress.phase = phase;
      progress.done = Number(done) || 0;
      progress.total = Number(total) || 0;
    };
    return Promise.resolve()
      .then(() => fn(onProgress))
      .finally(() => {
        progress.running = false;
        progress.phase = '完成';
        progress.finishedAt = Date.now();
      });
  }

  /**
   * DSH 的 owner 鉴权：`connection.admit` 校验浏览器凭据，只放行 owner。
   * 拿不到 connection 服务或判定异常时返回 null，交给令牌兜底。
   */
  function ownerVerdict(req) {
    if (!connection || typeof connection.admit !== 'function') return null;
    try {
      const result = connection.admit({ headers: req.headers });
      const kind = result?.peer?.principal?.kind;
      if (kind === 'owner') return true;
      if (result?.peer) return false;
      return false; // 有 rejection 就是拒
    } catch (error) {
      log(`owner 鉴权异常（回落令牌）：${error?.message ?? error}`);
      return null;
    }
  }
  const token = loadOrCreateToken(store.dataDir);

  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: TOKEN_GLOBAL_KEY, value: token });
  });

  let registered = false;
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => {
      webCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: async (req, res) => {
          const url = String(req.url ?? '');
          const route = url.slice(url.indexOf(ROUTE_PREFIX) + ROUTE_PREFIX.length).split('?')[0] || '/';
          const method = String(req.method ?? 'GET').toUpperCase();

          try {
            // 先把门关了：owner 身份或令牌，二者之一才能进来
            const owner = ownerVerdict(req);
            const suppliedToken = String(req.headers['x-workbench-token'] ?? '');
            const tokenOk = suppliedToken.length === token.length
              && crypto.timingSafeEqual(Buffer.from(suppliedToken), Buffer.from(token));
            if (owner !== true && !tokenOk) {
              return json(res, 403, { error: 'unauthorized' });
            }

            if (route === '/board' && method === 'GET') {
              return json(res, 200, payload(store.read()));
            }
            if (route === '/settings' && method === 'GET') {
              return json(res, 200, { settings: readSettings(dataDir), dataDir });
            }
            if (route === '/progress' && method === 'GET') {
              return json(res, 200, { progress });
            }
            // 跳转前解析会话 id：DSH 里有裸 uuid / session- 前缀两种存量写法，
            // 由宿主自己的会话存储判断哪个真的存在（客户端不再瞎猜）。
            if (route === '/session/resolve' && method === 'GET') {
              const raw = String(readQuery(url).id ?? '').trim();
              if (!raw) return json(res, 400, { error: 'id 必填' });
              const bare = raw.startsWith('session-') ? raw.slice('session-'.length) : raw;
              const candidates = [...new Set([raw, bare, `session-${bare}`])];
              const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined;
              if (!query) return json(res, 200, { id: raw, resolvedBy: 'fallback' });

              // 顺带查清楚：这个会话是否登记在某个工作区里（不登记的话侧边栏没有它，
              // 前端 openSession 选不中，只会开出一个空白会话）
              const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
              const listedIn = (id) => {
                for (const ws of registry?.list?.() ?? []) {
                  const ids = (ws?.sessionIds ?? []).map(String);
                  for (const form of [String(id), String(id).replace(/^session-/, ''), `session-${String(id).replace(/^session-/, '')}`]) {
                    if (ids.includes(form)) return { title: ws?.title ?? '', path: ws?.path ?? '' };
                  }
                }
                return null;
              };

              for (const candidate of candidates) {
                try {
                  const snap = await query.readTitleSnapshot(candidate);
                  if (snap !== undefined && snap !== null) {
                    const listed = listedIn(candidate);
                    let cwd = '';
                    try {
                      const full = await query.readSession(candidate);
                      cwd = String(full?.header?.cwd ?? full?.snapshot?.header?.cwd ?? '');
                    } catch { /* 下面用日志头兜底 */ }
                    if (!cwd) cwd = readSessionCwd(undefined, candidate);
                    return json(res, 200, {
                      id: candidate,
                      title: snap?.title?.title ?? '',
                      listed: Boolean(listed),
                      workspace: listed?.title ?? '',
                      workspacePath: listed?.path ?? '',
                      cwd,
                      resolvedBy: 'sessionQuery',
                    });
                  }
                } catch {
                  // 这个写法不认识，试下一个
                }
              }
              return json(res, 404, { error: '会话不存在', tried: candidates });
            }

            /**
             * 把一个「不在任何工作区」的会话收编进来：
             * 按它的 cwd 找到或创建工作区，再把会话 attach 到该工作区。
             * 不 attach 的话，新工作区里不认识这条会话，openSession 仍然只能开空白会话。
             */
            if (route === '/session/adopt' && method === 'POST') {
              const body = await readJsonBody(req);
              const raw = String(body.id ?? '').trim();
              if (!raw) return json(res, 400, { error: 'id 必填' });
              const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : undefined;
              const query = typeof ctx.get === 'function' ? ctx.get('sessionQuery') : undefined;
              if (!registry) return json(res, 501, { error: '当前环境没有 workspaceRegistry，无法注册工作区' });

              const bare = raw.startsWith('session-') ? raw.slice('session-'.length) : raw;
              const candidates = [...new Set([raw, bare, `session-${bare}`])];
              let sessionId = null;
              if (query) {
                for (const candidate of candidates) {
                  try {
                    const snap = await query.readTitleSnapshot(candidate);
                    if (snap !== undefined && snap !== null) { sessionId = candidate; break; }
                  } catch { /* 换下一个写法 */ }
                }
              }
              if (!sessionId) sessionId = raw;

              // cwd 优先用调用方给的（面板从 /session/resolve 已经拿到），读不到再翻日志头
              const cwd = String(body.cwd ?? '').trim() || readSessionCwd(undefined, sessionId);
              if (!cwd) return json(res, 400, { error: '读不到该会话的目录，无法注册工作区' });

              let workspace = registry.list().find((w) => String(w?.path ?? '') === cwd) ?? null;
              let created = false;
              if (!workspace) {
                workspace = await registry.create(cwd);
                created = true;
              }
              try {
                await workspace.attachSession(sessionId);
              } catch (error) {
                log(`attach 会话失败（可能已属于该工作区）：${error?.message ?? error}`);
              }
              return json(res, 200, {
                sessionId,
                cwd,
                workspaceId: String(workspace?.id ?? ''),
                title: String(workspace?.title ?? ''),
                created,
              });
            }

            if (route === '/cumulative' && method === 'GET') {
              return json(res, 200, { totals: ledgerTotals(loadLedger(dataDir)) });
            }
            if (route === '/note/export' && method === 'GET') {
              const q = readQuery(url);
              const note = findNote(store.read(), String(q.id ?? ''));
              if (!note) return json(res, 404, { error: '便签不存在' });
              if (String(q.format ?? 'md') === 'json') return json(res, 200, { note });
              const md = noteToMarkdown(note);
              res.writeHead(200, {
                'Content-Type': 'text/markdown; charset=utf-8',
                'Content-Disposition': `attachment; filename="note-${note.id}.md"`,
                'Cache-Control': 'no-store',
              });
              res.end(md);
              return undefined;
            }

            if (route === '/briefs' && method === 'GET') {
              return json(res, 200, {
                briefs: listBriefs(dataDir, { limit: 30 }).map((b) => ({
                  date: b.date, generatedAt: b.generatedAt, totals: b.totals,
                })),
              });
            }
            if (route === '/brief' && method === 'GET' && readQuery(url).date) {
              const brief = readBrief(dataDir, readQuery(url).date);
              return brief ? json(res, 200, { brief }) : json(res, 404, { error: '没有这一天的简报' });
            }

            // ── 会话任务：预览与导入 ──────────────────────
            if (route === '/sessions' && method === 'GET') {
              const scan = await trackProgress('scan', (onProgress) => scanSessions({ ctx, dataDir, log, ...(scanOptions ?? {}), onProgress }));
              const board = store.read();
              const known = new Set(board.notes.filter((n) => n.source?.kind === 'session').map((n) => n.source.id));
              return json(res, 200, {
                ...scan,
                sessions: scan.sessions.map((s) => ({
                  ...s,
                  existing: known.has(s.sessionId),
                  total: s.todos.length,
                  done: s.todos.filter((t) => t.status === 'completed').length,
                })),
              });
            }

            if (route === '/note' && method === 'POST') {
              const body = await readJsonBody(req);
              const { board } = await store.addNote(body);
              return json(res, 200, payload(board));
            }
            if (route === '/settings' && method === 'POST') {
              const body = await readJsonBody(req);
              const settings = writeSettings(dataDir, body);
              log(`设置已更新：${JSON.stringify(settings)}`);
              return json(res, 200, { settings });
            }

            if (route === '/brief' && method === 'POST') {
              const body = await readJsonBody(req);
              const result = await trackProgress('brief', (onProgress) => runBrief({
                ctx,
                store,
                dataDir,
                log,
                sinceHours: Number(body.sinceHours) || 24,
                onProgress,
              }));
              return json(res, 200, {
                ...payload(store.read()),
                brief: result.brief,
                report: { noteId: result.noteId, created: result.created, pruned: result.pruned, date: result.date, scan: result.scan },
              });
            }

            if (route === '/import' && method === 'POST') {
              const body = await readJsonBody(req);
              const only = Array.isArray(body.sessionIds) && body.sessionIds.length
                ? new Set(body.sessionIds.map(String))
                : null;
              const scan = await trackProgress('import', (onProgress) => scanSessions({
                ctx,
                dataDir,
                log,
                ...(scanOptions ?? {}),
                // 只刷某几张卡时放宽扫描上限，免得目标会话不在前 N 个里
                limit: Number(body.limit) || (only ? 300 : undefined),
                onProgress,
              }));
              const picked = only ? scan.sessions.filter((s2) => only.has(String(s2.sessionId))) : scan.sessions;
              const { board, result } = await store.mutate((b) => {
                const report = importSessions(b, picked);
                // 早期版本把子代理线程也导进来了：每次导入顺手清掉这些遗留卡
                const cleaned = removeNotesBySources(b, scan.subagentIds ?? []);
                return { ...report, cleaned };
              });
              return json(res, 200, {
                ...payload(board),
                report: result,
                scanned: scan.scanned,
                matched: picked.length,
                truncated: scan.truncated,
                scanError: scan.error ?? null,
              });
            }

            if (route === '/layout' && method === 'POST') {
              const body = await readJsonBody(req);
              const patches = Array.isArray(body.positions) ? body.positions : [];
              if (!patches.length) return json(res, 400, { error: 'positions 必填' });
              await store.mutate((b) => applyPositions(b, patches));
              return json(res, 200, payload(store.read()));
            }

            if (route === '/note/update' && method === 'POST') {
              const body = await readJsonBody(req);
              if (!body.id) return json(res, 400, { error: 'id 必填' });
              const { board } = await store.updateNote(body.id, body);
              return json(res, 200, payload(board));
            }
            if (route === '/note/done' && method === 'POST') {
              const body = await readJsonBody(req);
              if (!body.id) return json(res, 400, { error: 'id 必填' });
              const { board } = await store.setDone(body.id, body.done !== false);
              return json(res, 200, payload(board));
            }
            if (route === '/note/delete' && method === 'POST') {
              const body = await readJsonBody(req);
              if (!body.id) return json(res, 400, { error: 'id 必填' });
              const { board } = await store.removeNote(body.id);
              return json(res, 200, payload(board));
            }
            if (route === '/note/update-log' && method === 'POST') {
              const body = await readJsonBody(req);
              if (!body.id) return json(res, 400, { error: 'id 必填' });
              if (body.delete) {
                const { board } = await store.removeUpdate(body.id, body.updateId);
                return json(res, 200, payload(board));
              }
              const { board } = await store.addUpdate(body.id, body.text);
              return json(res, 200, payload(board));
            }

            return json(res, 404, { error: `未知路由 ${method} ${route}` });
          } catch (error) {
            const message = error?.message ?? String(error);
            // 业务错误（便签不存在、内容为空）用 400，其余 500
            const status = /不存在|不能为空|必填|请求体|超过上限|太多|过长/.test(message) ? 400 : 500;
            if (status === 500) log(`路由异常 ${method} ${route}: ${message}`);
            return json(res, status, { error: message });
          }
        },
      });
      registered = true;
      log(`HTTP 路由已挂载：${ROUTE_PREFIX}`);
      return () => { registered = false; };
    }, 'secretary: api routes');
  });

  return { token, get registered() { return registered; } };
}

return { registerHttpRoutes };
})();

const { DEFAULT_BOARD, normalizeBoard, stats, addNote, updateNote, setDone, addUpdate, removeUpdate, removeNote, findNote, summaryText, COLORS, newId, importSessions, upsertBriefNote, nextFreeSlot, applyPositions, pushHistory, noteToMarkdown, removeNotesBySources, LIMITS } = boardMod;
const { BoardStore, defaultDataDir } = storeMod;
const { dshHome, decodeFrames, decodeSessionFile, listSessionLogs, readWorkspaces, readCachedGoal, readSessionCwd, digestEvents, loadDigestCache, saveDigestCache } = logsMod;
const { collectPortraits } = insightsMod;
const { scanSessions, parseTodoArguments } = sessionsMod;
const { emptyLedger, loadLedger, saveLedger, isIngested, ingest, totals: ledgerTotals, dailySeries } = cumulativeMod;
const { fmtTokens, sumUsage } = pricingMod;
const { composeBrief, briefText, dateKey, saveBrief, pruneBriefs, listBriefs, readBrief } = briefMod;
const { DEFAULT_SETTINGS, readSettings, writeSettings, sanitize } = settingsMod;
const { runBrief, runScheduledBrief } = briefingMod;
const { registerHttpRoutes } = httpMod;

/**
 * dsh-secretary —— DSH 助理的宿主入口。
 *
 * 两件事：
 *   1. 把 ~/.dsh/workbench/board.json 的读写挂到 webServer 上，给画布面板用
 *   2. 注册 secretary_* 工具，Agent 也能帮你看板里加便签、勾完成
 */


export const name = 'secretary';

export const inject = ['tools'];

export function apply(ctx, rawConfig = {}) {
  const dataDir = rawConfig && typeof rawConfig.dataDir === 'string' && rawConfig.dataDir
    ? rawConfig.dataDir
    : defaultDataDir();
  const log = (msg) => console.log(`[secretary] ${msg}`);
  const store = new BoardStore(dataDir);

  ctx.effect(() => {
    const routes = registerHttpRoutes(ctx, { store, log, scanOptions: { limit: 60, budgetMs: 12000 } });
    log(`数据目录 ${dataDir}`);
    return () => {
      // 路由生命周期由 webCtx.effect 自己回收
      void routes;
    };
  }, 'secretary: routes');

  // ── 每日简报定时器 ─────────────────────────────────
  // 每分钟看一眼：到点且今天还没出过简报就生成。开机时如果已经过了今天的点，
  // 补一份（助理不该因为你 9 点才打开电脑就漏掉今天的简报）。
  ctx.effect(() => {
    let lastKey = '';
    let timer = null;
    const pad = (n) => String(n).padStart(2, '0');
    const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

    const fire = async (why) => {
      try {
        const result = await runScheduledBrief({ ctx, store, dataDir, log });
        if (result.skipped) log(`跳过每日简报：${result.reason}`);
        else log(`已生成 ${result.date} 的简报（${why}）：扫描 ${result.scan.sessions} 个会话`);
      } catch (error) {
        log(`生成简报失败：${error?.message ?? error}`);
      }
    };

    const tick = async () => {
      const settings = readSettings(dataDir);
      if (!settings.enabled) return;
      const now = new Date();
      const today = dateKey(now.getTime());
      if (hhmm(now) !== settings.dailyTime) return;
      if (lastKey === today) return;
      lastKey = today;
      await fire('到点');
    };

    // 开机补跑：今天已经过了设置的时间，但还没有今天的简报
    const boot = setTimeout(async () => {
      const settings = readSettings(dataDir);
      if (!settings.enabled) return;
      const now = new Date();
      const today = dateKey(now.getTime());
      if (hhmm(now) < settings.dailyTime) return;
      const board = store.read();
      const has = board.notes.some((n) => n.kind === 'brief' && n.brief?.date === today);
      if (has) return;
      lastKey = today;
      await fire('开机补跑');
    }, 8000);
    boot.unref?.();

    timer = setInterval(() => { void tick(); }, 60_000);
    timer.unref?.();
    log(`每日简报已安排：${readSettings(dataDir).dailyTime}（本机时区）`);

    return () => {
      clearTimeout(boot);
      if (timer) clearInterval(timer);
    };
  }, 'secretary: daily brief timer');

  // ── 实时钉卡：一轮跑完就标「待验收」 ───────────────
  // 不依赖扫描是否在跑，也不改 updatedAt（那是"你动过"的判据，别混）。
  try {
    ctx.on('session/event', (session, event) => {
      if (event?.type !== 'turn/end') return;
      const reason = event?.data?.reason?.kind;
      if (reason !== 'completed') return; // 出错/中断的不算"干完了等你验收"
      const sessionId = String(session?.id ?? event?.sessionId ?? '');
      if (!sessionId) return;
      const at = Number(event?.time) || Date.now();
      const seq = Number(event?.seq) || 0;
      void store.mutate((board) => {
        const note = board.notes.find((n) => n.kind !== 'brief'
          && n.source?.kind === 'session' && String(n.source.id) === sessionId);
        if (!note || note.done || note.cancelled) return null;
        note.review = { at, seq };
        return note.id;
      }).catch((error) => log(`标记待验收失败：${error?.message ?? error}`));
    }, 'secretary: turn/end review');
  } catch (error) {
    log(`挂接 turn/end 失败（实时钉卡不可用）：${error?.message ?? error}`);
  }

  const tools = ctx.get('tools');
  if (!tools) {
    log('没有 tools 服务，跳过工具注册（画布本身不受影响）');
    return;
  }

  // ToolDefinition 硬性要求 output { schema, render }，缺了会抛错并中断 apply。
  const register = (definition) => {
    const tool = {
      ...definition,
      output: definition.output ?? {
        schema: { type: 'object', additionalProperties: true },
        render: (_args, value) => [{ type: 'text', text: value?.content?.[0]?.text ?? JSON.stringify(value) }],
      },
    };
    try {
      tools.register(tool);
    } catch (error) {
      log(`工具注册失败 ${definition.name}: ${error?.message ?? error}`);
    }
  };

  register({
    name: 'secretary_list',
    description: '查看便签画布看板：总数、已完成、未完成，以及每张便签的 id、内容和最新进展。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() {
      const board = store.read();
      return { content: [{ type: 'text', text: summaryText(board) }], total: stats(board) };
    },
  });

  register({
    name: 'secretary_add_note',
    description: '在看板画布上新建一张便签（也就是一个待办）。text 是便签内容，color 可选：yellow/pink/green/blue/purple/orange。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '便签内容' },
        color: { type: 'string', description: '便签颜色，默认自动轮换' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute(args) {
      const board = store.read();
      const note = addNote(board, args);
      store.write(board);
      return { content: [{ type: 'text', text: `已新建便签 [${note.id}] ${note.text}` }], noteId: note.id };
    },
  });

  register({
    name: 'secretary_complete_note',
    description: '把某张便签勾完成（done=true）或取消完成（done=false）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '便签 id' },
        done: { type: 'boolean', description: 'true 勾完成，false 取消勾选，默认 true' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args) {
      const board = store.read();
      const note = setDone(board, args.id, args.done !== false);
      store.write(board);
      return { content: [{ type: 'text', text: `便签 [${note.id}] 已${note.done ? '完成' : '取消完成'}` }] };
    },
  });

  register({
    name: 'secretary_add_progress',
    description: '给某张便签追加一条进展记录（没做完时记一笔）。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '便签 id' },
        text: { type: 'string', description: '进展内容' },
      },
      required: ['id', 'text'],
      additionalProperties: false,
    },
    async execute(args) {
      const board = store.read();
      addUpdate(board, args.id, args.text);
      store.write(board);
      return { content: [{ type: 'text', text: `已给便签 [${args.id}] 追加进展：${args.text}` }] };
    },
  });

  register({
    name: 'secretary_update_note',
    description: '修改便签内容或颜色。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '便签 id' },
        text: { type: 'string', description: '新的便签内容' },
        color: { type: 'string', description: 'yellow/pink/green/blue/purple/orange' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args) {
      const board = store.read();
      const note = updateNote(board, args.id, args);
      store.write(board);
      return { content: [{ type: 'text', text: `已更新便签 [${note.id}]` }] };
    },
  });

  register({
    name: 'secretary_delete_note',
    description: '删除某张便签（真的删掉，不是勾完成）。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '便签 id' } },
      required: ['id'],
      additionalProperties: false,
    },
    async execute(args) {
      const board = store.read();
      removeNote(board, args.id); // 不存在会抛错
      store.write(board);
      return { content: [{ type: 'text', text: `已删除便签 [${args.id}]` }] };
    },
  });

  register({
    name: 'secretary_import_sessions',
    description: '扫描 DSH 里所有工作区的会话，把每个会话最后的待办清单（todo_write）作为一张便签导入看板；按会话去重，你手改过的卡不会被覆盖。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '最多扫描多少个最近会话，默认 60' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const scan = await scanSessions({ ctx, log, limit: Number(args?.limit) || 60 });
      if (scan.error) throw new Error(scan.error);
      const board = store.read();
      const report = importSessions(board, scan.sessions);
      store.write(board);
      const lines = [
        `扫描 ${scan.scanned} 个会话，其中 ${scan.sessions.length} 个有任务清单${scan.truncated ? '（时间到，未扫完）' : ''}。`,
        `新建 ${report.created} 张，刷新 ${report.updated} 张，跳过 ${report.skipped} 张（你手动改过）。`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }], report };
    },
  });

  register({
    name: 'secretary_daily_brief',
    description: '扫一遍 DSH 所有工作区的会话，生成一份「助理简报」（任务目标/进展/待办/消耗/需要你出手的事），并在画布上放一张简报卡。',
    parameters: {
      type: 'object',
      properties: {
        sinceHours: { type: 'number', description: '回溯多少小时，默认 24' },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const result = await runBrief({ ctx, store, dataDir, log, sinceHours: Number(args?.sinceHours) || 24 });
      return { content: [{ type: 'text', text: result.text }], brief: result.brief };
    },
  });

  log('secretary_* 工具已注册');
}

