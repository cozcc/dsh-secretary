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

import {
  listSessionLogs, decodeSessionFile, digestEvents, readWorkspaces, readCachedGoal,
  loadDigestCache, saveDigestCache,
} from './logs.mjs';
import { usageCost, sumUsage } from './pricing.mjs';

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
export async function collectPortraits({
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
          digest = digestEvents(events, { costOf: usageCost });
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
      usd: v.usd, known: true,
    })));

    const title = (digest.title
      || (digest.cwd ? String(digest.cwd).split('/').filter(Boolean).pop() : '')
      || `会话 ${sessionId.slice(-8)}`).slice(0, 120);

    portraits.push({
      sessionId,
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
