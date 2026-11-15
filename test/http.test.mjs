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

function makeServer({ admit } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-http-'));
  const store = new BoardStore(dataDir);
  let handler = null;
  const injected = [];
  const connection = admit ? { admit } : undefined;
  const ctx = {
    on: () => {},
    effect: (fn) => fn(),
    inject: (deps, cb) => injected.push(cb),
    get: (key) => (key === 'connection' ? connection : undefined),
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
