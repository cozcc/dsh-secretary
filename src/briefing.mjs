/**
 * 简报执行器：扫会话 → 拼简报 → 存快照 → 放到画布。
 *
 * 面板按钮、每日定时器、Agent 工具都调这一个函数，保证三条路径的结果一致。
 */

import { collectPortraits } from './insights.mjs';
import { loadLedger, saveLedger, ingest, totals as ledgerTotals } from './cumulative.mjs';
import { composeBrief, saveBrief, briefText, dateKey } from './brief.mjs';
import { readSettings } from './settings.mjs';
import { upsertBriefNote } from './board.mjs';

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
export async function runBrief({ ctx, store, dataDir, log, sinceHours = 24, settings, placeOnBoard = true, onProgress }) {
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
export async function runScheduledBrief({ ctx, store, dataDir, log, settings }) {
  const cfg = settings ?? readSettings(dataDir);
  const today = dateKey(Date.now());
  const board = store.read();
  const existing = board.notes.find((n) => n.kind === 'brief' && n.brief?.date === today);
  if (existing) return { skipped: true, reason: '今天已经有简报', date: today };
  return { skipped: false, ...(await runBrief({ ctx, store, dataDir, log, settings: cfg })) };
}
