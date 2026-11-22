/**
 * DSH 助理 HTTP 路由 —— 面板读写看板的唯一入口。
 *
 * 挂在 DSH 自己的 webServer 上（不开新端口），前端 fetch `/workbench/api/*`。
 *
 * 写操作要求 `X-Workbench-Token`：令牌启动时随机生成，通过
 * `webserver/index-inject` 注入页面。这样同机其它网页无法跨站改你的看板。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { stats, importSessions, applyPositions, findNote, noteToMarkdown, removeNotesBySources } from './board.mjs';
import { scanSessions } from './sessions.mjs';
import { readSettings, writeSettings } from './settings.mjs';
import { runBrief } from './briefing.mjs';
import { listBriefs, readBrief } from './brief.mjs';
import { readSessionCwd } from './logs.mjs';
import { buildWeekly } from './weekly.mjs';
import { loadLedger, totals as ledgerTotals } from './cumulative.mjs';

export const ROUTE_PREFIX = '/workbench/api';
export const TOKEN_GLOBAL_KEY = '__WORKBENCH_TOKEN__';
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

export function registerHttpRoutes(ctx, { store, log, scanOptions }) {
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

            if (route === '/weekly' && method === 'GET') {
              return json(res, 200, buildWeekly({ dataDir, store }));
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
