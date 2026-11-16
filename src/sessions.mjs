/**
 * 会话扫描（「拉取线程任务」用）：底层复用 logs.mjs 的日志摘要，
 * 所以和简报、长期累计看到的是同一份数据。
 */

import { collectPortraits } from './insights.mjs';

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
export async function scanSessions({ ctx, dataDir, log, limit = 60, budgetMs = 20000, onProgress }) {
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
export function parseTodoArguments(raw) {
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
