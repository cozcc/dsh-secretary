/**
 * HTTP 入口的鉴权测试：owner 身份或令牌，二者之一才能进；都没有就是 403。
 *
 * 跑法：node --test test/http.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { registerHttpRoutes } from '../src/http.mjs';
import { BoardStore } from '../src/store.mjs';

function makeServer({ admit, workspaceRegistry, sessionQuery } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-http-'));
  const store = new BoardStore(dataDir);
  let handler = null;
  const injected = [];
  const connection = admit ? { admit } : undefined;
  const ctx = {
    on: () => {},
    effect: (fn) => fn(),
    inject: (deps, cb) => injected.push(cb),
    get: (key) => {
      if (key === 'connection') return connection;
      if (key === 'workspaceRegistry') return workspaceRegistry;
      if (key === 'sessionQuery') return sessionQuery;
      return undefined;
    },
  };
  registerHttpRoutes(ctx, { store, log: () => {} });
  for (const cb of injected) {
    cb({ effect: (fn) => fn(), webServer: { register: (opts) => { handler = opts.handler; return () => {}; } } });
  }
  const token = fs.readFileSync(path.join(dataDir, 'api-token'), 'utf8').trim();

  const call = (method, url, headers = {}, body) => new Promise((resolve) => {
    const res = {
      statusCode: 0,
      writeHead(status) { this.statusCode = status; },
      end(text) {
        let parsed = {};
        try { parsed = JSON.parse(text || '{}'); } catch { parsed = { raw: text }; }
        resolve({ status: this.statusCode, body: parsed });
      },
    };
    const req = {
      method,
      url,
      headers,
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)); },
    };
    if (!handler) { resolve({ status: 0, body: { error: 'handler 未注册' } }); return; }
    handler(req, res);
  });

  return { call, dataDir, store, token };
}

const ownerPeer = { peer: { principal: { kind: 'owner' } } };
const rejectPeer = { rejection: 403 };

test('没有任何凭据：403', async () => {
  const s = makeServer({ admit: () => rejectPeer });
  const r = await s.call('GET', '/workbench/api/board');
  assert.equal(r.status, 403);
  assert.equal(r.body.error, 'unauthorized');
});

test('owner 身份：不带令牌也能读', async () => {
  const s = makeServer({ admit: () => ownerPeer });
  const r = await s.call('GET', '/workbench/api/board');
  assert.equal(r.status, 200);
  assert.ok(r.body.board);
});

test('令牌兜底：没有 connection 服务时靠令牌放行', async () => {
  const s = makeServer({});
  const ok = await s.call('GET', '/workbench/api/board', { 'x-workbench-token': s.token });
  assert.equal(ok.status, 200);
  const bad = await s.call('GET', '/workbench/api/board', { 'x-workbench-token': 'wrong' });
  assert.equal(bad.status, 403);
});

test('owner 拒绝 + 错令牌：403（fail-closed）', async () => {
  const s = makeServer({ admit: () => rejectPeer });
  const r = await s.call('POST', '/workbench/api/settings', { 'x-workbench-token': 'wrong' }, { dailyTime: '09:00' });
  assert.equal(r.status, 403);
});

test('有 owner 身份时改设置成功', async () => {
  const s = makeServer({ admit: () => ownerPeer });
  const r = await s.call('POST', '/workbench/api/settings', { 'content-type': 'application/json' }, { dailyTime: '07:30', retentionDays: 30 });
  assert.equal(r.status, 200);
  assert.equal(r.body.settings.dailyTime, '07:30');
  assert.equal(r.body.settings.retentionDays, 30);
});


test('导出与历史路由：md 导出、404、按日期取快照', async () => {
  const s = makeServer({ admit: () => ownerPeer });

  // 先建一张卡
  const created = await s.call('POST', '/workbench/api/note', { 'content-type': 'application/json' }, { text: '导出测试' });
  assert.equal(created.status, 200);
  const id = created.body.board.notes.find((n) => n.text === '导出测试').id;

  const md = await s.call('GET', `/workbench/api/note/export?id=${id}&format=md`, {});
  assert.equal(md.status, 200);
  assert.match(md.body.raw ?? '', /状态：未完成/);
  assert.match(md.body.raw ?? '', /## 变更历史/);

  const missing = await s.call('GET', '/workbench/api/note/export?id=nope', {});
  assert.equal(missing.status, 404);

  // 超长正文：400 且明确指出超限
  const tooLong = await s.call('POST', '/workbench/api/note', { 'content-type': 'application/json' }, { text: 'x'.repeat(100_001) });
  assert.equal(tooLong.status, 400);
  assert.match(tooLong.body.error, /超过上限/);

  // 按日期取简报：没有就是 404（顺带覆盖 readQuery）
  const brief = await s.call('GET', '/workbench/api/brief?date=2020-01-01', {});
  assert.equal(brief.status, 404);
});

test('新建的便签自带变更历史', async () => {
  const s = makeServer({ admit: () => ownerPeer });
  await s.call('POST', '/workbench/api/note', { 'content-type': 'application/json' }, { text: '带历史' });
  const board = s.store.read();
  const note = board.notes.find((n) => n.text === '带历史');
  assert.ok(note.history.length >= 1);
  assert.equal(note.history[0].kind, 'created');
});


test('收编会话：按 cwd 建工作区并 attach，然后就能打开', async () => {
  const attached = [];
  const created = [];
  const registry = {
    list: () => created,
    create: async (path) => {
      const ws = { id: 'ws-new', path, title: 'source', sessionIds: [], attachSession: async (id) => { attached.push([ws.id, id]); } };
      created.push(ws);
      return ws;
    },
  };
  const sessionQuery = {
    readTitleSnapshot: async (id) => (id.startsWith('session-') ? { title: { title: 'T' } } : (() => { throw new Error('unknown'); })()),
  };
  const s = makeServer({ admit: () => ownerPeer, workspaceRegistry: registry, sessionQuery });
  const r = await s.call('POST', '/workbench/api/session/adopt', { 'content-type': 'application/json' },
    { id: 'session-abc-123', cwd: '/tmp/demo' });
  assert.equal(r.status, 200);
  assert.equal(r.body.sessionId, 'session-abc-123');
  assert.equal(r.body.created, true);
  assert.deepEqual(attached, [['ws-new', 'session-abc-123']], '会话必须被 attach 到新工作区');
});
