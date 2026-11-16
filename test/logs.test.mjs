/**
 * 会话日志读取与摘要的测试（不依赖真实会话文件）。
 *
 * 跑法：node --test test/logs.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

import { decodeFrames, decodeSessionFile, digestEvents, listSessionLogs, readWorkspaces } from '../src/logs.mjs';

/** 把事件数组按块压成「多帧」zstd，模拟 DSH 的追加写日志。 */
function writeMultiFrameZstd(file, events, chunkSize = 3) {
  const lines = events.map((e) => JSON.stringify(e));
  const parts = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    const chunk = `${lines.slice(i, i + chunkSize).join('\n')}\n`;
    parts.push(zlib.zstdCompressSync(Buffer.from(chunk, 'utf8')));
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat(parts));
}

function sampleEvents() {
  const now = Date.parse('2026-11-15T12:00:00+08:00');
  return [
    { type: 'session', version: 4, id: 'session-abc', createdAt: now - 86400e3, cwd: '/Users/vv/Demo' },
    { type: 'session/title', seq: 2, time: now - 86000e3, data: { title: '工作台插件开发' } },
    { type: 'turn/start', seq: 3, time: now - 80000e3, data: { turn: 1 } },
    { type: 'user/message', seq: 4, time: now - 79000e3, data: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    {
      type: 'assistant/message',
      seq: 5,
      time: now - 70000e3,
      data: {
        usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500 },
        message: {
          role: 'assistant',
          source: { kind: 'model', provider: 'oxo', model: 'deepseek-v4.1-flash' },
          content: [
            { type: 'tool-call', id: 'c1', name: 'create_goal', arguments: JSON.stringify({ objective: '做个助理' }) },
            { type: 'tool-call', id: 'c2', name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: '加简报', status: 'completed' }, { content: '加累计', status: 'pending' }] }) },
            { type: 'tool-call', id: 'c3', name: 'present', arguments: JSON.stringify({ files: [{ path: '/tmp/a.md' }] }) },
          ],
        },
      },
    },
    { type: 'turn/end', seq: 6, time: now - 60000e3, data: { turn: 1, reason: { kind: 'completed' } } },
    // 第二天的用量（用于按天分桶）
    {
      type: 'assistant/message',
      seq: 7,
      time: now + 86400e3,
      data: {
        usage: { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 0 },
        message: { role: 'assistant', source: { kind: 'model', provider: 'oxo', model: 'deepseek-v4.1-flash' }, content: [] },
      },
    },
  ];
}

const costOf = (usage, model, time) => ({ usd: 0.001, known: true });

test('多帧 zstd 能全部解出来（不是只解第一帧）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-logs-'));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const events = sampleEvents();
  writeMultiFrameZstd(file, events, 2);

  const text = decodeFrames(fs.readFileSync(file));
  const lines = text.split('\n').filter(Boolean);
  assert.equal(lines.length, events.length, '每一帧的行都要拼回来');

  const decoded = decodeSessionFile(file);
  assert.equal(decoded.events.length, events.length);
  assert.equal(decoded.badLines, 0);
});

test('坏行容错：不因为一行坏了就丢掉整个会话', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-logs-'));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  const good = JSON.stringify({ type: 'session', version: 4, id: 'session-x', cwd: '/tmp' });
  const buf = Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(`${good}\n{坏掉的 json\n`)),
    zlib.zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'turn/start', seq: 2, time: 1, data: {} })}\n`)),
  ]);
  fs.writeFileSync(file, buf);
  const decoded = decodeSessionFile(file);
  assert.equal(decoded.events.length, 2);
  assert.equal(decoded.badLines, 1);
});

test('摘要：标题、目标、待办、产出、回合、失败原因都对', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-logs-'));
  const file = path.join(dir, 'session.v4.jsonl.zstd');
  writeMultiFrameZstd(file, sampleEvents(), 2);

  const d = digestEvents(decodeSessionFile(file).events, { costOf });
  assert.equal(d.sessionId, 'session-abc');
  assert.equal(d.cwd, '/Users/vv/Demo');
  assert.equal(d.title, '工作台插件开发');
  assert.equal(d.goal.objective, '做个助理');
  assert.equal(d.todos.length, 2);
  assert.equal(d.todos[0].status, 'completed');
  assert.deepEqual(d.deliverables, ['/tmp/a.md']);
  assert.equal(d.turns, 1);
  assert.equal(d.lastTurnEnd.reason.kind, 'completed');

  // 用量按「事件发生的那一天」分桶，两天各一桶
  const days = Object.keys(d.usageByDay).sort();
  assert.equal(days.length, 2);
  assert.equal(d.usageTotals.input, 3000);
  assert.equal(d.usageTotals.output, 300);
  assert.equal(d.usageTotals.cached, 500);
  assert.equal(d.usageTotals.totalTokens, 3800);
});

test('会话日志列表：能发现文件并带 size:mtime 签名', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-home-'));
  const file = path.join(home, 'sessions', '--proj--', 'session-abc', 'session.v4.jsonl.zstd');
  writeMultiFrameZstd(file, sampleEvents(), 4);
  const list = listSessionLogs(home);
  assert.equal(list.length, 1);
  assert.equal(list[0].sessionId, 'session-abc');
  assert.match(list[0].sig, /^\d+:\d+$/);
});

test('工作区注册表映射', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-home-'));
  fs.mkdirSync(path.join(home, 'storages'), { recursive: true });
  fs.writeFileSync(path.join(home, 'storages', 'workspace.json'), JSON.stringify({
    tables: { workspaces: { 'ws-1': { path: '/Users/vv/Demo', title: 'Playground', sessionIds: ['session-abc'] } } },
  }));
  const map = readWorkspaces(home);
  assert.equal(map.get('session-abc').title, 'Playground');
});


test('阶段按任务内容切分：状态变化不算新阶段', () => {
  const now = Date.now();
  const usage = { inputTokens: 10, outputTokens: 1, cacheReadTokens: 0 };
  const call = (at, todos) => ({
    type: 'assistant/message', time: at,
    data: { usage, message: { role: 'assistant', source: { kind: 'model', provider: 'p', model: 'm' },
      content: [{ type: 'tool-call', id: 'c', name: 'todo_write', arguments: JSON.stringify({ todos }) }] } },
  });
  const events = [
    { type: 'session', version: 4, id: 's', cwd: '/tmp' },
    call(now - 3000, [{ content: 'A', status: 'pending' }, { content: 'B', status: 'pending' }]),
    call(now - 2000, [{ content: 'A', status: 'completed' }, { content: 'B', status: 'pending' }]),
    call(now - 1000, [{ content: 'C', status: 'pending' }]),
  ];
  const d = digestEvents(events);
  assert.equal(d.stages.length, 2, `应该是 2 个阶段，实际 ${d.stages.length}`);
  assert.equal(d.stages[0].items[0].status, 'completed', '同一阶段保留最新状态');
  assert.equal(d.stages[1].items[0].content, 'C');
});
