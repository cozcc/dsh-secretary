/**
 * 长期累计账本：只加不减，不受简报 90 天保留期影响。
 *
 * 结构（`<dataDir>/cumulative.json`）：
 *   {
 *     version: 1,
 *     updatedAt: 0,
 *     sessions: {
 *       [sessionId]: {
 *         updatedAt: <会话最后更新时间>,
 *         days: { 'YYYY-MM-DD': { input, output, cached } }
 *       }
 *     }
 *   }
 *
 * 为什么按「会话」存而不是直接累加总数：
 *   · 同一段历史会被多次读到（每次生成简报都会扫），直接累加会重复计数
 *   · 以会话为单位整段替换，重复读同样的日志结果不变（幂等）
 *   · 会话更新后再读一次，会覆盖成新的分布，不会越加越多
 */

import fs from 'node:fs';
import path from 'node:path';

const FILE = 'cumulative.json';

export function emptyLedger() {
  return { version: 1, updatedAt: 0, sessions: {} };
}

function fileOf(dataDir) {
  return path.join(dataDir, FILE);
}

export function loadLedger(dataDir) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(dataDir), 'utf8'));
    if (!raw || typeof raw !== 'object' || !raw.sessions) return emptyLedger();
    return { version: 1, updatedAt: Number(raw.updatedAt) || 0, sessions: raw.sessions };
  } catch {
    return emptyLedger();
  }
}

export function saveLedger(dataDir, ledger, now = Date.now()) {
  const next = { ...ledger, updatedAt: now };
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = fileOf(dataDir);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  return next;
}

/** 这个会话是不是已经按当前版本记过账了。 */
export function isIngested(ledger, sessionId, updatedAt) {
  const rec = ledger.sessions?.[String(sessionId)];
  if (!rec) return false;
  return Number(rec.updatedAt) === Number(updatedAt);
}

/**
 * 把一次完整日志的「按天用量」并入账本（整段替换该会话）。
 * @param {object} ledger
 * @param {string} sessionId
 * @param {number} updatedAt 会话最后更新时间，用来判断是否需要重读
 * @param {Record<string, {input:number, output:number, cached:number}>} days
 */
export function ingest(ledger, sessionId, updatedAt, days) {
  const id = String(sessionId);
  const clean = {};
  for (const [day, v] of Object.entries(days ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !v) continue;
    clean[day] = {
      input: Number(v.input) || 0,
      output: Number(v.output) || 0,
      cached: Number(v.cached) || 0,
    };
  }
  ledger.sessions[id] = { updatedAt: Number(updatedAt) || 0, days: clean };
  return ledger;
}

/** 所有会话所有天的合计。 */
export function totals(ledger) {
  const total = { input: 0, output: 0, cached: 0, days: new Set(), sessions: 0 };
  for (const rec of Object.values(ledger.sessions ?? {})) {
    const days = rec?.days ?? {};
    const keys = Object.keys(days);
    if (!keys.length) continue;
    total.sessions += 1;
    for (const day of keys) {
      const v = days[day];
      total.input += v.input ?? 0;
      total.output += v.output ?? 0;
      total.cached += v.cached ?? 0;
      total.days.add(day);
    }
  }
  const days = [...total.days].sort();
  return {
    input: total.input,
    output: total.output,
    cached: total.cached,
    tokens: total.input + total.output + total.cached,
    sessions: total.sessions,
    days: days.length,
    firstDay: days[0] ?? null,
    lastDay: days[days.length - 1] ?? null,
  };
}

/** 最近 N 天的每日用量（给趋势用）。 */
export function dailySeries(ledger, limit = 14) {
  const byDay = new Map();
  for (const rec of Object.values(ledger.sessions ?? {})) {
    for (const [day, v] of Object.entries(rec?.days ?? {})) {
      const cur = byDay.get(day) ?? { day, input: 0, output: 0, cached: 0 };
      cur.input += v.input ?? 0;
      cur.output += v.output ?? 0;
      cur.cached += v.cached ?? 0;
      byDay.set(day, cur);
    }
  }
  return [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)).slice(-limit);
}
