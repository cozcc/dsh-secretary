/**
 * 看板数据层测试：便签增删改、勾完成、进展记录、坏文件兜底。
 *
 * 跑法：node --test test/board.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyPositions,
  importSessions,
  normalizeBoard,
  noteToMarkdown,
  LIMITS,
  stats,
  addNote,
  setDone,
  updateNote,
  addUpdate,
  removeUpdate,
  removeNote,
  summaryText,
} from '../src/board.mjs';
import { BoardStore } from '../src/store.mjs';

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-test-'));

test('新建便签默认未完成，颜色自动轮换', () => {
  const board = normalizeBoard({});
  const a = addNote(board, { text: '写周报' }, 1000);
  const b = addNote(board, { text: '改预算' }, 1001);
  assert.equal(a.done, false);
  assert.notEqual(a.color, b.color);
  assert.equal(stats(board).open, 2);
});

test('勾完成后再取消，完成时间和统计跟着变', () => {
  const board = normalizeBoard({});
  const note = addNote(board, { text: '对账' }, 1000);
  setDone(board, note.id, true, 2000);
  assert.equal(stats(board).done, 1);
  assert.equal(note.doneAt, 2000);
  setDone(board, note.id, false, 3000);
  assert.equal(stats(board).open, 1);
  assert.equal(note.doneAt, null);
});

test('正文不能改成空，改颜色和位置生效', () => {
  const board = normalizeBoard({});
  const note = addNote(board, { text: '初稿' }, 1000);
  assert.throws(() => updateNote(board, note.id, { text: '   ' }), /不能为空/);
  updateNote(board, note.id, { text: '终稿', color: 'blue', x: 320, y: 64 });
  assert.equal(note.text, '终稿');
  assert.equal(note.color, 'blue');
  assert.equal(note.x, 320);
});

test('进展可追加可删除，空进展被拒', () => {
  const board = normalizeBoard({});
  const note = addNote(board, { text: '修面板' }, 1000);
  const u = addUpdate(board, note.id, '定位到是 inject 没写', 2000);
  assert.equal(note.updates.length, 1);
  assert.match(summaryText(board), /inject 没写/);
  assert.throws(() => addUpdate(board, note.id, ' '), /不能为空/);
  removeUpdate(board, note.id, u.id);
  assert.equal(note.updates.length, 0);
});

test('删便签；不存在的 id 报错', () => {
  const board = normalizeBoard({});
  const note = addNote(board, { text: '临时' }, 1000);
  removeNote(board, note.id);
  assert.equal(board.notes.length, 0);
  assert.throws(() => removeNote(board, 'nope'), /不存在/);
  assert.throws(() => setDone(board, 'nope', true), /不存在/);
});

test('读到脏数据也能修成合法看板', () => {
  const board = normalizeBoard({
    notes: [
      { text: '没有 id 和坐标', color: '不存在' },
      { id: 'x', text: 'ok', x: '88', y: null, updates: [{ text: '进展' }, { text: '' }] },
      null,
    ],
  });
  assert.equal(board.notes.length, 2);
  assert.ok(board.notes[0].id);
  assert.equal(board.notes[0].color, 'yellow');
  assert.equal(board.notes[1].x, 88);
  assert.equal(board.notes[1].updates.length, 1);
});

test('落盘是原子写：写坏文件会留备份而不是清空', async () => {
  const dir = tmpDir();
  const store = new BoardStore(dir);
  const { board } = await store.addNote({ text: '第一条' });
  const noteId = board.notes[0].id;

  // 正常再读一次，内容还在
  assert.equal(store.read().notes[0].id, noteId);

  // 模拟文件被写坏
  fs.writeFileSync(path.join(dir, 'board.json'), '{ 坏掉的 json', 'utf8');
  const recovered = store.read();
  assert.equal(recovered.notes.length, 0);
  const backups = fs.readdirSync(dir).filter((f) => f.includes('.broken-'));
  assert.equal(backups.length, 1);
});


test('导入会话任务：一个会话一张卡，按来源去重，不覆盖手改', () => {
  const board = normalizeBoard({});
  const snaps = [
    { sessionId: 's1', title: '工作台插件', workspace: 'Playground', updatedAt: 100, todos: [
      { content: '加自动排列', status: 'completed' },
      { content: '加会话导入', status: 'in_progress' },
    ] },
    { sessionId: 's2', title: '季度对账', workspace: '财务', updatedAt: 90, todos: [
      { content: '导出流水', status: 'completed' },
    ] },
  ];

  const first = importSessions(board, snaps, 1000);
  assert.deepEqual({ ...first, notes: undefined }, { created: 2, updated: 0, skipped: 0, notes: undefined });
  assert.equal(board.notes.length, 2);
  const s1 = board.notes.find((n) => n.source?.id === 's1');
  assert.equal(s1.text, '工作台插件');
  assert.equal(s1.todos.length, 2);
  assert.equal(s1.done, false);
  assert.equal(s1.source.workspace, 'Playground');
  // 全部完成的会话，卡片直接是勾掉的状态
  assert.equal(board.notes.find((n) => n.source?.id === 's2').done, true);

  // 新卡落在网格空位，不会叠在一起
  const [a, b] = board.notes;
  assert.ok(a.x !== b.x || a.y !== b.y);

  // 没动过 → 第二次导入全部刷新，不新增
  const second = importSessions(board, snaps, 2000);
  assert.deepEqual([second.created, second.updated, second.skipped], [0, 2, 0]);
  assert.equal(board.notes.length, 2);

  // 手改过 s1 → 跳过，不被覆盖
  s1.updatedAt = 3000;
  s1.text = '我自己改的';
  const third = importSessions(board, snaps, 4000);
  assert.deepEqual([third.created, third.updated, third.skipped], [0, 1, 1]);
  assert.equal(board.notes.find((n) => n.source?.id === 's1').text, '我自己改的');
});

test('导入时没有待办清单的会话直接忽略', () => {
  const board = normalizeBoard({});
  const report = importSessions(board, [{ sessionId: 'x', title: '空会', todos: [] }], 1000);
  assert.equal(report.created, 0);
  assert.equal(board.notes.length, 0);
});


test('放弃任务：不计入没做完，重新拉取也不复活', () => {
  const board = normalizeBoard({});
  const snaps = [{ sessionId: 's1', title: '没意义了的任务', updatedAt: 100, todos: [{ content: '做一半', status: 'pending' }] }];
  importSessions(board, snaps, 1000);
  const note = board.notes[0];
  assert.deepEqual(stats(board), { total: 1, done: 0, open: 1, cancelled: 0, briefs: 0 });

  updateNote(board, note.id, { cancelled: true }, 2000);
  assert.equal(board.notes[0].cancelled, true);
  assert.deepEqual(stats(board), { total: 0, done: 0, open: 0, cancelled: 1, briefs: 0 });

  // 再拉一次：被放弃的会话不会再冒出来
  const report = importSessions(board, snaps, 3000);
  assert.equal(report.created, 0);
  assert.equal(report.skipped, 1);
  assert.equal(board.notes.length, 1);

  // 恢复
  updateNote(board, note.id, { cancelled: false }, 4000);
  assert.deepEqual(stats(board), { total: 1, done: 0, open: 1, cancelled: 0, briefs: 0 });
});


test('待验收标记：能打上，勾完成时自动清掉', () => {
  const board = normalizeBoard({});
  const note = addNote(board, { text: '刚干完的活' }, 1000);
  updateNote(board, note.id, { review: { at: 2000, seq: 42 } }, 2000);
  assert.deepEqual(board.notes[0].review, { at: 2000, seq: 42 });

  setDone(board, note.id, true, 3000);
  assert.equal(board.notes[0].review, null, '验收后不该还挂待验收');

  // 取消标记 / 显式清空也支持
  updateNote(board, note.id, { review: { at: 4000, seq: 43 } }, 4000);
  updateNote(board, note.id, { review: null }, 5000);
  assert.equal(board.notes[0].review, null);
});


test('批量排版：一次写回多张，非法项跳过', () => {
  const board = normalizeBoard({});
  const a = addNote(board, { text: 'A' }, 1);
  const b = addNote(board, { text: 'B' }, 2);
  const result = applyPositions(board, [
    { id: a.id, x: 300, y: 40 },
    { id: b.id, x: 564, y: 40 },
    { id: 'nope', x: 1, y: 1 },
    { id: a.id, x: 'x', y: 2 },
  ], 500);
  assert.equal(result.moved, 2);
  assert.equal(board.notes.find((n) => n.id === a.id).x, 300);
  assert.equal(board.notes.find((n) => n.id === b.id).x, 564);

  // 位置没变的不重复计数
  assert.equal(applyPositions(board, [{ id: a.id, x: 300, y: 40 }], 600).moved, 0);
});


test('导入会话时保留任务目标与产出（续做草稿要用）', () => {
  const board = normalizeBoard({});
  importSessions(board, [{
    sessionId: 's1', title: '工作台', updatedAt: 100,
    goal: '把工作台做成助理', deliverables: ['/tmp/a.md', '/tmp/b.png'],
    todos: [{ content: '写测试', status: 'pending' }],
  }], 1000);
  const note = board.notes[0];
  assert.equal(note.goal, '把工作台做成助理');
  assert.deepEqual(note.deliverables, ['/tmp/a.md', '/tmp/b.png']);

  // 落盘再读回来也要在
  const again = normalizeBoard(JSON.parse(JSON.stringify(board)));
  assert.equal(again.notes[0].goal, '把工作台做成助理');
  assert.equal(again.notes[0].deliverables.length, 2);
});


test('不再静默截断：超限明确报错，未超限一字不改', () => {
  const board = normalizeBoard({});
  const long = 'x'.repeat(5000); // 旧上限是 4000，现在应当完整保存
  const note = addNote(board, { text: long }, 1);
  assert.equal(note.text.length, 5000, '正常长度不该被裁');

  const tooLong = 'y'.repeat(LIMITS.text + 1);
  assert.throws(() => addNote(board, { text: tooLong }, 2), /超过上限/);
  assert.throws(() => updateNote(note.id ? board : board, note.id, { text: tooLong }, 3), /超过上限/);

  // 进展同样：不裁剪，超限报错
  const n2 = addNote(board, { text: '卡' }, 4);
  const big = 'z'.repeat(3000);
  addUpdate(board, n2.id, big, 5);
  assert.equal(board.notes.find((n) => n.id === n2.id).updates[0].text.length, 3000);
  assert.throws(() => addUpdate(board, n2.id, 'w'.repeat(LIMITS.update + 1), 6), /超过上限/);
});

test('单卡变更历史：记录创建/改文本/完成/进展/取消', () => {
  const board = normalizeBoard({});
  const note = addNote(board, { text: '写文档' }, 1000);
  updateNote(board, note.id, { text: '写文档 v2' }, 2000);
  addUpdate(board, note.id, '写了一半', 3000);
  setDone(board, note.id, true, 4000);
  updateNote(board, note.id, { cancelled: true }, 5000);

  const kinds = board.notes[0].history.map((h) => h.kind);
  for (const k of ['created', 'text', 'progress', 'done', 'cancelled']) {
    assert.ok(kinds.includes(k), `历史里缺 ${k}：${kinds.join(',')}`);
  }
  assert.equal(board.notes[0].history.at(-1).kind, 'cancelled');

  // 落盘再读回来还在
  const again = normalizeBoard(JSON.parse(JSON.stringify(board)));
  assert.equal(again.notes[0].history.length, board.notes[0].history.length);
});

test('单卡导出 Markdown：含状态、正文、待办、进展、产出、历史', () => {
  const board = normalizeBoard({});
  importSessions(board, [{
    sessionId: 's9', title: '导出测试', updatedAt: 10, goal: '把导出做出来',
    deliverables: ['/tmp/a.md'], todos: [{ content: '写导出', status: 'completed' }, { content: '补测试', status: 'pending' }],
  }], 1000);
  const note = board.notes[0];
  addUpdate(board, note.id, '写完了导出', 2000);
  const md = noteToMarkdown(note);

  assert.match(md, /^# 导出测试/m);
  assert.match(md, /状态：未完成/);
  assert.match(md, /## 任务目标[\s\S]*把导出做出来/);
  assert.match(md, /- \[x\] 写导出/);
  assert.match(md, /- \[ \] 补测试/);
  assert.match(md, /## 进展[\s\S]*写完了导出/);
  assert.match(md, /## 产出[\s\S]*\/tmp\/a\.md/);
  assert.match(md, /## 变更历史/);
});
