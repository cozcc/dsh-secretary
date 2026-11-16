/**
 * 面板渲染 + 交互的回归脚本（headless 挂载 React，抓渲染期崩溃）。
 *
 * 这个 bug 就是它抓到的：看板接口给的是 { version, notes }，面板却当成数组
 * 直接 .filter，首帧抛错 → 点开工作台整页黑屏。
 *
 * 跑法（ESM 不受 NODE_PATH 影响，所以要把脚本放进装了依赖的目录）：
 *   mkdir -p /tmp/wb-run && cd /tmp/wb-run && npm i react@19 react-dom@19 jsdom@25
 *   cp ~/Documents/Playground/workbench/test/panel.render.mjs ./probe.mjs
 *   WB_BUNDLE=~/Documents/Playground/workbench/packages/workbench/lib/client.js node probe.mjs
 *
 * 覆盖：首屏渲染、勾选完成、只看没做完、新建后自动编辑、回车保存、
 *      记进展、删除、拖拽坐标换算、连建多张不重叠。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const here = path.dirname(fileURLToPath(import.meta.url));
/**
 * 被测的浏览器端产物。把本文件复制到装了依赖的临时目录里跑时，
 * 用 WB_BUNDLE=/绝对路径/lib/client.js 指过去。
 */
const bundlePath = process.env.WB_BUNDLE ?? path.resolve(here, '..', 'lib/client.js');

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://127.0.0.1:56761/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;
globalThis.Node = dom.window.Node;
globalThis.__WORKBENCH_TOKEN__ = 'x'.repeat(64);
let clipboard = '';
Object.defineProperty(dom.window.navigator, 'clipboard', {
  value: { writeText: async (text) => { clipboard = text; } },
  configurable: true,
});

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

// —— 假服务端：和 src/http.mjs 的语义一致 ——
let seq = 0;
const mk = (text, extra = {}) => ({ id: `n${++seq}`, text, done: false, x: 60, y: 60, color: 'yellow', createdAt: Date.now(), updatedAt: Date.now(), doneAt: null, updates: [], ...extra });
let notes = [mk('写周报', { x: 40, y: 40, updates: [{ id: 'u1', text: '写了一半', at: Date.now() }] }), mk('回邮件', { done: true, doneAt: Date.now(), x: 328, y: 40 })];
const stats = () => {
  const tasks = notes.filter((n) => n.kind !== 'brief');
  return { total: tasks.length, done: tasks.filter((n) => n.done).length, open: tasks.filter((n) => !n.done).length, briefs: notes.length - tasks.length };
};
const reply = () => ({ board: { version: 1, notes: JSON.parse(JSON.stringify(notes)) }, stats: stats() });

const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  const route = String(url).replace('/workbench/api', '');
  const body = opts.body ? JSON.parse(opts.body) : {};
  calls.push(`${opts.method ?? 'GET'} ${route}`);
  if (route === '/board') return { ok: true, status: 200, async text() { return JSON.stringify(reply()); } };
  if (route.startsWith('/note/export')) {
    return { ok: true, status: 200, async text() { return '# 导出的便签\n\n- 状态：未完成\n'; } };
  }
  if (route === '/progress') {
    return { ok: true, status: 200, async text() {
      return JSON.stringify({ progress: { running: true, phase: '解析会话日志', done: 3, total: 10, startedAt: Date.now() - 1200 } });
    } };
  }
  if (route === '/layout') {
    const body = JSON.parse(opts.body);
    for (const p of body.positions || []) { const n = notes.find((x) => x.id === p.id); if (n) { n.x = p.x; n.y = p.y; } }
    return { ok: true, status: 200, async text() { return JSON.stringify({ board: { version: 1, notes: JSON.parse(JSON.stringify(notes)) }, stats: stats() }); } };
  }
  if (route === '/cumulative') {
    return { ok: true, status: 200, async text() { return JSON.stringify({ totals: { tokens: 1_450_000_000, usd: 19.48, sessions: 150, days: 30, firstDay: '2026-10-16', lastDay: '2026-11-15' } }); } };
  }
  if (route === '/settings' && (opts.method ?? 'GET') === 'GET') {
    return { ok: true, status: 200, async text() { return JSON.stringify({ settings: { dailyTime: '08:00', retentionDays: 90, enabled: true } }); } };
  }
  if (route === '/settings') {
    return { ok: true, status: 200, async text() { return JSON.stringify({ settings: JSON.parse(opts.body) }); } };
  }
  if (route === '/brief') {
    const b = {
      date: '2026-11-15',
      generatedAt: Date.now(),
      totals: { sessions: 3, doing: 1, done: 1, tokens: { input: 1000, output: 200 } },
      sections: [
        { key: 'headline', title: '过去 24 小时', tone: 'normal', lines: [{ text: '活跃 2 个任务 · 消耗 1.2k tokens / $0.001', tone: 'strong' }] },
        { key: 'attention', title: '需要你出手 · 1', tone: 'warn', items: [{ sessionId: 'sess-brief', title: '卡住的会话', lines: [{ text: '5 天没动，还有 3 项没做完', tone: 'warn' }] }] },
      ],
    };
    notes.push({ id: `b${++seq}`, text: `助理简报 · ${b.date}`, done: false, x: 40, y: 600, color: 'blue',
      createdAt: Date.now(), updatedAt: Date.now(), doneAt: null, updates: [], todos: [], source: null, kind: 'brief', brief: b });
    return { ok: true, status: 200, async text() { return JSON.stringify({ board: { version: 1, notes: JSON.parse(JSON.stringify(notes)) }, stats: stats(), brief: b, report: { created: true, scan: { sessions: 3 } } }); } };
  }
  if (route === '/import') {
    await new Promise((r) => setTimeout(r, 450)); // 模拟真实扫描耗时
    for (let i = 0; i < 3; i += 1) {
      notes.push({ id: `s${++seq}`, text: `线程${i + 1}`, done: false, x: 40, y: 40, color: 'blue',
        createdAt: Date.now(), updatedAt: Date.now(), doneAt: null, updates: [], kind: 'note', source: null,
        todos: [{ content: `待办${i + 1}`, status: 'pending' }],
        source: { kind: 'session', id: `sess-${i + 1}`, title: `线程${i + 1}`, workspace: 'Play', updatedAt: Date.now(), syncedAt: Date.now() } });
    }
    return { ok: true, status: 200, async text() { return JSON.stringify({ board: { version: 1, notes: JSON.parse(JSON.stringify(notes)) }, stats: stats(), report: { created: 3, updated: 0, skipped: 0 } }); } };
  }
  if (route === '/note') {
    const n = mk(body.text ?? '新便签', { x: body.x ?? 40, y: body.y ?? 40 });
    notes.push(n);
  } else if (route === '/note/done') {
    const n = notes.find((x) => x.id === body.id);
    n.done = body.done !== false; n.doneAt = n.done ? Date.now() : null;
  } else if (route === '/note/update') {
    const n = notes.find((x) => x.id === body.id);
    if (body.cancelled !== undefined) n.cancelled = body.cancelled === true;
    if (body.text !== undefined) n.text = body.text;
    if (body.x !== undefined) n.x = body.x;
    if (body.y !== undefined) n.y = body.y;
    if (body.color !== undefined) n.color = body.color;
  } else if (route === '/note/delete') {
    notes = notes.filter((x) => x.id !== body.id);
  } else if (route === '/note/update-log') {
    const n = notes.find((x) => x.id === body.id);
    n.updates.push({ id: `u${++seq}`, text: body.text, at: Date.now() });
  }
  return { ok: true, status: 200, async text() { return JSON.stringify(reply()); } };
};
dom.window.fetch = globalThis.fetch;

let mod = null;
globalThis.window.__ModuleLoader__ = { load: ({ factory }) => { mod = factory((n) => (n === 'react' ? React : null)); } };
new Function('window', 'globalThis', fs.readFileSync(bundlePath, 'utf8'))(dom.window, globalThis);

const reg = {};
const opened = [];
const ctx = {
  effect: (f) => f(),
  get: (key) => (key === 'uiWorkspace' ? { openSession: (id) => { opened.push(String(id)); } } : undefined),
  slots: { inject: (n, cb) => cb(), register: (o, C) => { reg[o.name === 'main' ? 'main' : 'sidebar'] = C; } },
};
mod.apply(ctx);

// jsdom 没有布局引擎，这里按内联样式伪造矩形，好验证拖拽换算
// jsdom 没有布局：给 clientWidth 一个固定值，模拟 1200px 宽的可见区域
Object.defineProperty(dom.window.Element.prototype, 'clientWidth', {
  get() { return 1200; }, configurable: true,
});

dom.window.Element.prototype.getBoundingClientRect = function () {
  const left = parseFloat(this.style?.left) || 0;
  const top = parseFloat(this.style?.top) || 0;
  const width = parseFloat(this.style?.width) || 208;
  const height = parseFloat(this.style?.height) || 200;
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
};

const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);
await act(async () => { root.render(React.createElement(reg.main, {})); });
await act(async () => { await new Promise((r) => setTimeout(r, 50)); });

const text = () => host.textContent;
const btns = () => [...host.querySelectorAll('button')];
const byTitle = (t) => btns().find((b) => b.getAttribute('title') === t);
const byText = (t) => btns().find((b) => b.textContent.includes(t));
let pass = 0; let fail = 0;
const check = (name, cond, extra = '') => { if (cond) { pass++; console.log('✔', name); } else { fail++; console.log('✖', name, extra); } };

check('首屏渲染出两张便签', text().includes('写周报') && text().includes('回邮件'));
check('统计正确（便签2 / 没做完1 / 已完成1）', text().includes('便签 2') && text().includes('没做完 1') && text().includes('已完成 1'), text().slice(0, 120));

// 勾完成
await act(async () => { byTitle('做完，勾掉').click(); await new Promise((r) => setTimeout(r, 30)); });
check('勾选后统计变 没做完0 / 已完成2', text().includes('没做完 0') && text().includes('已完成 2'), text().slice(0, 120));

// 只看没做完
await act(async () => { byText('只看没做完').click(); await new Promise((r) => setTimeout(r, 30)); });
check('筛选后两张都收起，提示没有没做完的', text().includes('没有没做完的了'), text().slice(0, 160));

// 取消筛选
const showAllBtn = [...host.querySelectorAll('button')].find((b) => (b.textContent || '').includes('隐藏 2'));
check('筛选按钮显示隐藏张数', !!showAllBtn, [...host.querySelectorAll('button')].map((b) => b.textContent).slice(0, 6).join(' | '));
await act(async () => { showAllBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 30)); });
check('再点恢复显示', text().includes('写周报') && text().includes('回邮件'));

// 切「只看没做完」后应自动重排：新建一张未完成卡，再开筛选，它应回到左上角
await act(async () => { byText('＋ 新建便签').click(); await new Promise((r) => setTimeout(r, 220)); });
await act(async () => { byText('只看没做完').click(); await new Promise((r) => setTimeout(r, 260)); });
const visibleOpen = notes.filter((n) => n.kind !== 'brief' && !n.done && !n.cancelled)
  .sort((a, b) => (a.y - b.y) || (a.x - b.x));
check('筛选后第一张可见便签回到左上', visibleOpen.length > 0 && visibleOpen[0].x === 40 && visibleOpen[0].y === 40,
  visibleOpen[0] ? `x=${visibleOpen[0].x} y=${visibleOpen[0].y}` : '没有未完成便签');
check('筛选后可见便签互不重叠', (() => {
  const W = 248; const H = 200;
  for (let i = 0; i < visibleOpen.length; i += 1) {
    for (let j = i + 1; j < visibleOpen.length; j += 1) {
      const a = visibleOpen[i]; const b = visibleOpen[j];
      if (a.x < b.x + W && a.x + W > b.x && a.y < b.y + H && a.y + H > b.y) return false;
    }
  }
  return true;
})());
await act(async () => {
  const back = [...host.querySelectorAll('button')].find((b) => (b.textContent || '').includes('隐藏'));
  if (back) back.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
});


// 新建便签：应自动进入编辑态（出现 textarea）
await act(async () => { byText('＋ 新建便签').click(); await new Promise((r) => setTimeout(r, 50)); });
check('新建后出现编辑框', !!host.querySelector('textarea'), host.innerHTML.slice(-300));

// 在编辑框里输入并回车保存
const ta = host.querySelector('textarea');
const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set;
await act(async () => {
  setter.call(ta, '给面板加空态');
  ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 10));
});
await act(async () => {
  ta.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
});
check('回车保存后便签内容更新', text().includes('给面板加空态'), text().slice(0, 200));

// 记进展
const progressBtn = byText('＋ 记进展');
if (progressBtn) {
  await act(async () => { progressBtn.click(); await new Promise((r) => setTimeout(r, 30)); });
  const pi = host.querySelector('input[placeholder]');
  if (pi) {
    const iset = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    await act(async () => {
      iset.call(pi, '画布第一版');
      pi.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 10));
    });
    await act(async () => {
      pi.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise((r) => setTimeout(r, 50));
    });
    check('进展写回并显示', text().includes('画布第一版'), text().slice(0, 200));
  } else check('进展输入框出现', false);
} else check('找到记进展按钮', false);

// 删除
const before = notes.length;
await act(async () => { byTitle('删除这张便签').click(); await new Promise((r) => setTimeout(r, 50)); });
check('删除按钮生效', notes.length === before - 1);

// ── 拖拽：pointerdown → move(+100,+80) → up，应写回 x+100 / y+80 ──
const before2 = JSON.parse(JSON.stringify(notes));
const cards = [...host.querySelectorAll('div')].filter((el) => {
  const st = el.getAttribute('style') || '';
  return st.includes('position: absolute') && st.includes('width: 248px');
});
const noteEl = cards[0];
const target = noteEl.querySelector('div[role="textbox"]') ?? noteEl;
const draggedId = (() => {
  const t = noteEl.textContent || '';
  return notes.find((n) => t.startsWith(n.text))?.id;
})();
const startLeft = parseFloat(noteEl.style.left);
const startTop = parseFloat(noteEl.style.top);
const fire = (type, x, y, el) => {
  const ev = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  (el ?? dom.window).dispatchEvent(ev);
};
await act(async () => {
  fire('pointerdown', startLeft + 20, startTop + 20, target);
  await new Promise((r) => setTimeout(r, 10));
});
fire('pointermove', startLeft + 120, startTop + 100, dom.window);
await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
fire('pointerup', startLeft + 120, startTop + 100, dom.window);
await act(async () => { await new Promise((r) => setTimeout(r, 60)); });
const moved = notes.find((n) => n.id === draggedId);
const orig = before2.find((n) => n.id === draggedId);
check('拖拽生效：位置 +100/+80',
  moved.x === orig.x + 100 && moved.y === orig.y + 80,
  `实际 x=${moved.x} y=${moved.y}（期望 ${orig.x + 100},${orig.y + 80}），起始 x=${startLeft} y=${startTop}`);

// ── 连建 6 张：两两不能重叠（卡片 208×156）──
for (let i = 0; i < 6; i += 1) {
  const btn = byText('＋ 新建便签');
  await act(async () => { btn.click(); await new Promise((r) => setTimeout(r, 40)); });
}
const W = 248; const H = 200;
let overlap = null;
for (let i = 0; i < notes.length; i += 1) {
  for (let j = i + 1; j < notes.length; j += 1) {
    const a = notes[i]; const b = notes[j];
    if (a.x < b.x + W && a.x + W > b.x && a.y < b.y + H && a.y + H > b.y) overlap = `${a.text}(${a.x},${a.y}) × ${b.text}(${b.x},${b.y})`;
  }
}
check(`新建 ${notes.length} 张互不重叠`, !overlap, overlap ?? '');
console.log('排布：', notes.map((n) => `${n.text}@${n.x},${n.y}`).join(' | '));


// ── 自动排列：铺满一行自动换行 ──────────────────────────
const COLS = 4; // 可见宽度 1200 - 2*40 margin，248 宽 + 16 间距 → 每行 4 张
const STEP_X = 248 + 16;
const STEP_Y = 200 + 16; // 与 client.mjs 的 NOTE_H 保持一致
const M = 40;
const slot = (i) => ({ x: M + (i % COLS) * STEP_X, y: M + Math.floor(i / COLS) * STEP_Y });

for (let i = 0; i < 5; i += 1) {
  const b = byText('＋ 新建便签');
  await act(async () => { b.click(); await new Promise((r) => setTimeout(r, 40)); });
}
// 打乱一下位置，模拟用户随手拖过的乱局
notes.forEach((n, i) => { n.x = 40 + (i % 5) * 37; n.y = 40 + (i % 3) * 23; });
await act(async () => { root.render(React.createElement(reg.main, {})); await new Promise((r) => setTimeout(r, 40)); });

await act(async () => { byText('自动排列').click(); await new Promise((r) => setTimeout(r, 200)); });
const want = notes.map((_, i) => slot(i)).map((p) => `${p.x},${p.y}`).sort();
const got = notes.map((n) => `${n.x},${n.y}`).sort();
check('自动排列：全部落到网格位并换行', JSON.stringify(want) === JSON.stringify(got), `want=${want.join(' ')} got=${got.join(' ')}`);
const row1 = notes.filter((n) => n.y === M).length;
const newest = [...notes].filter((n) => n.kind !== 'brief').sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))[0];
check('最新的便签在最左上', newest && newest.x === 40 && newest.y === 40, newest ? `x=${newest.x} y=${newest.y}` : '无');
const rowBuckets = new Map();
for (const n of notes) rowBuckets.set(n.y, (rowBuckets.get(n.y) || 0) + 1);
const perRow = [...rowBuckets.values()];
check('自动排列：每行最多 4 张并逐行往下', perRow.length > 1 && Math.max(...perRow) <= COLS, `每行 ${perRow.join('/')}（共 ${notes.length} 张）`);


// ── 会话导入卡片：待办清单和来源要能渲染出来 ──────────────
notes.push({
  id: `n${++seq}`,
  text: '工作台插件（来自会话）',
  review: { at: Date.now(), seq: 7 },
  done: false, x: 40, y: 400, color: 'purple',
  createdAt: Date.now(), updatedAt: Date.now(), doneAt: null, updates: [],
  todos: [
    { content: '加自动排列', status: 'completed' },
    { content: '加会话导入', status: 'in_progress' },
    { content: '补测试', status: 'pending' },
  ],
  goal: '把工作台做成 DSH 助理',
  deliverables: ['/tmp/report.md'],
  source: { kind: 'session', id: 'sess-1', title: '工作台插件开发', workspace: 'Playground', updatedAt: Date.now(), syncedAt: Date.now() },
});
await act(async () => { byText('自动排列').click(); await new Promise((r) => setTimeout(r, 200)); });
check('会话卡片渲染出待办清单', text().includes('加自动排列') && text().includes('加会话导入') && text().includes('补测试'));
check('会话卡片显示来源', text().includes('Playground'), text().slice(-200));
check('清单状态标记（✓/◐/○）', host.textContent.includes('✓') && host.textContent.includes('◐') && host.textContent.includes('○'));


// ── 助理简报：生成按钮、简报卡渲染、设置面板 ──────────────
const statsBefore = stats();
await act(async () => { byText('生成简报').click(); await new Promise((r) => setTimeout(r, 120)); });
check('生成简报：自动切到简报页', text().includes('助理简报') && text().includes('重新生成'), text().slice(0, 160));
check('简报页渲染分块标题', text().includes('过去 24 小时') && text().includes('需要你出手'));
check('简报页渲染条目与语气', text().includes('卡住的会话') && text().includes('5 天没动'));
check('简报卡不参与待办计数', stats().total === statsBefore.total && stats().done === statsBefore.done);

// 便签 / 简报 是两个页面
const tabBtns = [...host.querySelectorAll('button')].filter((b) => {
  const t = (b.textContent || '').trim();
  return t.startsWith('便签') || t === '简报';
});
check('顶栏有两个页面标签', tabBtns.length === 2, tabBtns.map((b) => b.textContent).join(' | '));
const notesTab = tabBtns.find((b) => (b.textContent || '').startsWith('便签'));
await act(async () => { notesTab.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 60)); });
const notesPane = () => host.querySelector('[data-page="notes"]');
const briefPane = () => host.querySelector('[data-page="brief"]');
check('切回便签页：便签可见、简报页已卸下', !!notesPane() && (notesPane().getAttribute('style') || '').indexOf('display: none') === -1 && !briefPane());
check('便签页不再渲染简报卡', ![...host.querySelectorAll('div[data-note-id]')].some((el) => el.textContent.includes('需要你出手')));

// 设置面板
await act(async () => { byText('设置').click(); await new Promise((r) => setTimeout(r, 60)); });
const timeInput = host.querySelector('input[type="time"]');
check('设置面板打开且有每日时间输入', !!timeInput && timeInput.value === '08:00', timeInput?.value);
const dayInput = host.querySelector('input[type="number"]');
check('设置面板有保留天数输入', !!dayInput && dayInput.value === '90', dayInput?.value);

// 改时间并保存
const iset = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
await act(async () => {
  iset.call(timeInput, '07:30');
  timeInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  timeInput.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 20));
});
await act(async () => { byText('保存').click(); await new Promise((r) => setTimeout(r, 80)); });
check('保存设置发出 POST /settings', calls.some((c) => c.startsWith('POST /settings')), calls.join(' → '));
check('保存后提示已生效', text().includes('08:00') || text().includes('07:30'), text().slice(-160));


// ── 新便签占最左、旧卡右移；卡片随内容长高，不做内部滚动 ──
const beforeX = new Map(notes.filter((n) => n.kind !== 'brief').map((n) => [n.id, n.x]));
const countBefore = notes.length;
await act(async () => { byText('＋ 新建便签').click(); await new Promise((r) => setTimeout(r, 250)); });
const fresh = notes.slice(countBefore).find((n) => n.kind !== 'brief');
check('新便签落在最左（x=40,y=40）', fresh && fresh.x === 40 && fresh.y === 40, fresh ? `x=${fresh.x} y=${fresh.y}` : '没建出来');
const shifted = notes.filter((n) => n.kind !== 'brief' && beforeX.has(n.id) && n.x > (beforeX.get(n.id) ?? 0));
check('旧便签整体往右移', shifted.length > 0, `移动 ${shifted.length} 张`);
check('排版走批量接口（一次请求）', calls.some((c) => c.startsWith('POST /layout')));

const html = host.innerHTML;
check('卡片没有内部滚动条', !html.includes('max-height') && !html.includes('overflow-y'), html.match(/max-height[^;]*/)?.[0] ?? '');
const todoCard = [...host.querySelectorAll('div[data-note-id]')].find((el) => el.textContent.includes('加自动排列'));
if (todoCard) {
  const text = todoCard.innerHTML;
  const iTodo = text.indexOf('加自动排列');
  const iUpdates = text.indexOf('记进展');
  check('待办清单在正文之后、进展之前', iTodo > 0 && (iUpdates === -1 || iTodo < iUpdates));
} else check('找到会话卡片', false);


// ── 未完成的待办可以跳转到对应线程 ──────────────────
const linkBtns = [...host.querySelectorAll('button[title^="打开对应线程"]')];
check('未完成的待办渲染成链接', linkBtns.length >= 2, `链接数 ${linkBtns.length}`);
check('已完成的待办不给链接', !linkBtns.some((b) => b.textContent.includes('加自动排列')));
const todoLink = linkBtns.find((b) => b.textContent.includes('加会话导入')) ?? linkBtns[0];
await act(async () => { todoLink.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 30)); });
check('点击后跳转到对应会话', opened.includes('sess-1'), `opened=${JSON.stringify(opened)}`);
const srcBtn = [...host.querySelectorAll('button[title^="打开对应线程"]')].find((b) => b.textContent.includes('Playground'));
check('来源标记也能跳转', !!srcBtn);

// 简报页里的条目也能跳（先切到简报页）
const briefTabBtn = [...host.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '简报');
if (briefTabBtn) await act(async () => { briefTabBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 100)); });
const briefLink = [...host.querySelectorAll('button[title^="打开对应线程"]')].find((b) => b.textContent.includes('卡住的会话'));
check('简报条目渲染成链接', !!briefLink);
if (briefLink) {
  await act(async () => { briefLink.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 30)); });
  check('点简报条目跳到对应会话', opened.includes('sess-brief'), JSON.stringify(opened));
}


// ── 导入会话卡后自动按真实高度排开，不叠 ─────────────?
// 拉取按钮只在便签页
const notesTabBtn = [...host.querySelectorAll('button')].find((b) => (b.textContent || '').trim().startsWith('便签'));
if (notesTabBtn) await act(async () => { notesTabBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 80)); });
const beforeImport = notes.length;
await act(async () => { byText('拉取线程任务').click(); await new Promise((r) => setTimeout(r, 260)); });
check('长任务期间显示进度', text().includes('解析会话日志') && /3\/10/.test(text()), text().slice(0, 120));
await act(async () => { await new Promise((r) => setTimeout(r, 400)); });
const imported = notes.slice(beforeImport);
check('导入后新增会话卡片', imported.length === 3, `新增 ${imported.length}`);
let overlapImport = null;
const W2 = 248; const H2 = 200;
for (let i = 0; i < notes.length; i += 1) {
  for (let j = i + 1; j < notes.length; j += 1) {
    const a = notes[i]; const b = notes[j];
    if (a.kind === 'brief' || b.kind === 'brief') continue;
    if (a.x < b.x + W2 && a.x + W2 > b.x && a.y < b.y + H2 && a.y + H2 > b.y) overlapImport = `${a.text}×${b.text}`;
  }
}
check('导入后自动排开不重叠', !overlapImport, overlapImport ?? '');


// ── 已完成的卡不能整卡半透明（叠起来会像一层透明纸） ──
const doneCard = [...host.querySelectorAll('div[data-note-id]')].find((el) => (el.getAttribute('style') || '').includes('opacity'));
const anyOpacity = [...host.querySelectorAll('div[data-note-id]')].some((el) => /opacity:\s*0?\.[0-9]/.test(el.getAttribute('style') || ''));
check('卡片没有整卡透明（opacity）', !anyOpacity, [...host.querySelectorAll('div[data-note-id]')].map((el) => el.getAttribute('style')).filter(Boolean).slice(0, 2).join(' | '));


// ── 会话卡：继续 / 刷新 / 取消 ─────────────────────────
const findCard = (word) => [...host.querySelectorAll('div[data-note-id]')].find((el) => (el.textContent || '').includes(word));
let card = findCard('待办1') ?? findCard('加会话导入');
check('会话卡有继续/刷新/取消', !!card && ['继续', '刷新', '取消'].every((t) => [...card.querySelectorAll('button')].some((b) => b.textContent === t)));

const refreshBtn = card && [...card.querySelectorAll('button')].find((b) => b.textContent === '刷新');
if (refreshBtn) await act(async () => { refreshBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 120)); });
check('刷新会按会话 id 重新拉取', calls.some((c) => c.startsWith('POST /import')), calls.slice(-3).join(' → '));

card = findCard('待办1') ?? findCard('加会话导入');
const cancelBtn = card && [...card.querySelectorAll('button')].find((b) => b.textContent === '取消');
if (cancelBtn) await act(async () => { cancelBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 120)); });
check('取消后标记为已放弃', notes.some((n) => n.cancelled), JSON.stringify(notes.filter((n) => n.cancelled).map((n) => n.text)));
check('顶栏出现「已放弃」计数', text().includes('已放弃'), text().slice(0, 80));
const restored = [...host.querySelectorAll('button')].find((b) => b.textContent === '恢复');
check('放弃的卡可以恢复', !!restored);
if (restored) await act(async () => { restored.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 120)); });
check('恢复后不再是已放弃', !notes.some((n) => n.cancelled));

// ── 继续：复制续做草稿并打开会话 ────────────────────────
const continueBtn = [...host.querySelectorAll('button')].find((b) => b.textContent === '继续');
check('会话卡有「继续」', !!continueBtn);
const openedBefore = opened.length;
if (continueBtn) {
  await act(async () => { continueBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 80)); });
}
check('继续会复制草稿', clipboard.includes('接着上面的进度继续'), clipboard.slice(0, 80));
check('草稿含目标', clipboard.includes('把工作台做成 DSH 助理'));
check('草稿含未完成待办', clipboard.includes('加会话导入') || clipboard.includes('补测试'));
check('草稿含产出文件', clipboard.includes('/tmp/report.md'));
check('继续同时打开会话', opened.length > openedBefore, JSON.stringify(opened.slice(-2)));


// ── 长期累计：顶栏显示累计 tokens 与费用 ────────────────
check('顶栏显示长期累计', text().includes('累计 1.45B') && !text().includes('$'), text().slice(0, 160));


// ── 待验收：徽标与顶栏计数 ─────────────────────────────
check('卡片上有「待验收」徽标', text().includes('待验收'), text().slice(0, 120));
check('顶栏有待验收计数', /待验收 \d+/.test(text()));


// ── 单卡历史 / 导出 ────────────────────────────────────
const historyBtn = [...host.querySelectorAll('button')].find((b) => /^历史 \d+$/.test((b.textContent || '').trim()));
check('卡片有「历史 N」按钮', !!historyBtn, [...host.querySelectorAll('button')].map((b) => b.textContent).slice(0, 8).join(' | '));
if (historyBtn) {
  await act(async () => { historyBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 60)); });
}
check('展开后能看到变更记录', text().includes('收起历史') || text().includes('还没有变更记录'));

const exportBtn = [...host.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === '导出');
check('卡片有「导出」按钮', !!exportBtn);
if (exportBtn) {
  await act(async () => { exportBtn.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await new Promise((r) => setTimeout(r, 120)); });
}
check('导出会请求 /note/export', calls.some((c) => c.startsWith('GET /note/export')), calls.slice(-3).join(' → '));

// ── 默认排序：未完成在上 ────────────────────────────────
await act(async () => {
  const arrange = byText('自动排列');
  if (arrange) arrange.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  await new Promise((r) => setTimeout(r, 200));
});
// 排序体现在「位置」上：按 y 再 x 还原视觉顺序
const taskNotes = notes.filter((n) => n.kind !== 'brief');
const visual = [...taskNotes].sort((a, b) => (a.y - b.y) || (a.x - b.x));
const firstDoneIndex = visual.findIndex((n) => n.done || n.cancelled);
const lastOpenIndex = visual.map((n) => !(n.done || n.cancelled)).lastIndexOf(true);
check('未完成的便签排在已完成的上面', firstDoneIndex === -1 || lastOpenIndex < firstDoneIndex,
  `视觉顺序里最后一张未完成 #${lastOpenIndex}，第一张已完成 #${firstDoneIndex}`);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
console.log('接口调用：', calls.join(' → '));
process.exit(fail ? 1 : 0);
