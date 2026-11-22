/**
 * 本周看板：会话数、token、完成任务，按周聚合。
 *
 * 数据来源：
 *   · token / 会话数 —— 长期账本 `cumulative.json`（按会话 + 日期存着每天的用量，
 *     所以某一天有哪些会话在跑、花了多少 token 都能算出来）
 *   · 完成任务 —— 画布上 doneAt 落在本周的卡片
 *
 * 一周从**本地周一**开始（和周报习惯一致）。
 */

import { loadLedger } from './cumulative.mjs';

const DAY_MS = 86_400_000;

/** 本地日期键 YYYY-MM-DD。 */
export function dayKey(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本周一 00:00（本地）的毫秒时间戳。 */
export function weekStartOf(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  const dow = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - dow);
  return d.getTime();
}

/** 把账本摊平成「日期 → { tokens, sessions }」。 */
function dailyFromLedger(ledger) {
  const map = new Map();
  for (const rec of Object.values(ledger.sessions ?? {})) {
    for (const [day, v] of Object.entries(rec?.days ?? {})) {
      const cur = map.get(day) ?? { tokens: 0, sessions: 0, input: 0, output: 0, cached: 0 };
      cur.tokens += (v.input ?? 0) + (v.output ?? 0) + (v.cached ?? 0);
      cur.input += v.input ?? 0;
      cur.output += v.output ?? 0;
      cur.cached += v.cached ?? 0;
      cur.sessions += 1; // 这一天这个会话有消耗 = 活跃
      map.set(day, cur);
    }
  }
  return map;
}

function sumRange(daily, fromMs, toMs) {
  const out = { tokens: 0, sessions: 0, input: 0, output: 0, cached: 0 };
  for (let t = fromMs; t <= toMs; t += DAY_MS) {
    const v = daily.get(dayKey(t));
    if (!v) continue;
    out.tokens += v.tokens;
    out.sessions += v.sessions;
    out.input += v.input;
    out.output += v.output;
    out.cached += v.cached;
  }
  return out;
}

/**
 * 生成本周看板数据。
 * @param {{dataDir:string, store:object, now?:number}} deps
 */
export function buildWeekly({ dataDir, store, now = Date.now() }) {
  const start = weekStartOf(now);
  const end = Math.min(start + 7 * DAY_MS - 1, now);
  const lastStart = start - 7 * DAY_MS;
  const lastEnd = start - 1;

  const daily = dailyFromLedger(loadLedger(dataDir));

  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const t = start + i * DAY_MS;
    const v = daily.get(dayKey(t)) ?? { tokens: 0, sessions: 0 };
    days.push({
      date: dayKey(t),
      weekday: ['一', '二', '三', '四', '五', '六', '日'][i],
      tokens: v.tokens,
      sessions: v.sessions,
      future: t > now,
    });
  }

  const thisWeek = sumRange(daily, start, end);
  const lastWeek = sumRange(daily, lastStart, lastEnd);

  const board = store.read();
  const cards = (board.notes ?? []).filter((n) => n.kind !== 'brief');
  const doneCards = cards.filter((n) => n.doneAt && n.doneAt >= start && n.doneAt <= end);
  const doneLastWeek = cards.filter((n) => n.doneAt && n.doneAt >= lastStart && n.doneAt <= lastEnd);
  const openCards = cards.filter((n) => !n.done && !n.cancelled);

  const weekNo = (() => {
    const d = new Date(start);
    const thursday = new Date(d.getTime());
    thursday.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
    const firstThursday = new Date(thursday.getFullYear(), 0, 4);
    firstThursday.setDate(firstThursday.getDate() + 3 - ((firstThursday.getDay() + 6) % 7));
    return 1 + Math.round((thursday - firstThursday) / (7 * DAY_MS));
  })();

  return {
    weekStart: dayKey(start),
    weekEnd: dayKey(start + 6 * DAY_MS),
    weekNo,
    days,
    totals: {
      tokens: thisWeek.tokens,
      sessions: thisWeek.sessions,
      done: doneCards.length,
      input: thisWeek.input,
      output: thisWeek.output,
      cached: thisWeek.cached,
      open: openCards.length,
    },
    lastWeek: {
      tokens: lastWeek.tokens,
      sessions: lastWeek.sessions,
      done: doneLastWeek.length,
    },
    doneCards: doneCards
      .sort((a, b) => b.doneAt - a.doneAt)
      .slice(0, 12)
      .map((n) => ({ id: n.id, text: n.text, doneAt: n.doneAt })),
  };
}
