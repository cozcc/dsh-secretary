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
 *     goal: string | null,                          ← 这个线程的任务目标（优先取 DSH Goal）
 *     deliverables: string[],                       ← 产出文件路径
 *     brief:   { date, totals, sections } | null }
 *
 * x / y 是画布坐标（像素）。新建便签由调用方指定位置，这里只做兜底。
 */

export const COLORS = ['yellow', 'pink', 'green', 'blue', 'purple', 'orange'];

export const DEFAULT_BOARD = { version: 1, notes: [] };

export function newId(prefix = 'n') {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 限额只用来兜住"异常大的输入"，不是业务裁剪：
 * 超限时**明确报错**（HTTP 400 + 原因），不再静默截断丢掉用户内容。
 */
export const LIMITS = {
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
export function normalizeBoard(raw) {
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
export function pushHistory(note, kind, text, now = Date.now()) {
  if (!note.history) note.history = [];
  note.history.push({ at: now, kind: String(kind).slice(0, 40), text: String(text ?? '').slice(0, 500) });
  if (note.history.length > LIMITS.history) {
    note.history.splice(0, note.history.length - LIMITS.history);
    note.historyTruncated = true;
  }
  return note;
}

/** 看板统计：总数 / 已完成 / 未完成。 */
export function stats(board) {
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

export function findNote(board, id) {
  return board.notes.find((n) => n.id === id) ?? null;
}

/** 新增便签。位置没给就自动排到画布左上。 */
export function addNote(board, input = {}, now = Date.now()) {
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
export function setDone(board, id, done, now = Date.now()) {
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
export function updateNote(board, id, patch = {}, now = Date.now()) {
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
export function addUpdate(board, id, text, now = Date.now()) {
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
export function removeUpdate(board, id, updateId) {
  const note = findNote(board, id);
  if (!note) throw new Error(`便签不存在：${id}`);
  const before = note.updates.length;
  note.updates = note.updates.filter((u) => u.id !== updateId);
  if (note.updates.length === before) throw new Error(`进展不存在：${updateId}`);
  note.updatedAt = Date.now();
  return note;
}

/** 删便签。 */
export function removeNote(board, id) {
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
export function nextFreeSlot(board) {
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

export function importSessions(board, snapshots, now = Date.now(), colorSeed = 0) {
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
export function upsertBriefNote(board, brief, now = Date.now()) {
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
export function applyPositions(board, patches, now = Date.now()) {
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
export function removeNotesBySources(board, sessionIds) {
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
export function noteToMarkdown(note) {
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
export function summaryText(board) {
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
