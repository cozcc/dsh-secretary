/**
 * token 用量的格式化与汇总（**不做费用计算**）。
 *
 * 字段语义（用真实日志核对过）：
 *   inputTokens      = 未命中缓存的输入 token
 *   cacheReadTokens  = 命中缓存的输入 token
 *   outputTokens     = 输出 token
 *   totalTokens      = 未命中 + 输出 + 命中
 */

/** 把 token 数写成好读的形式：12.3k / 1.24M / 1.45B。 */
export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

/** 汇总一组用量记录。 */
export function sumUsage(entries) {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, calls: 0 };
  for (const e of entries ?? []) {
    total.inputTokens += Number(e.inputTokens) || 0;
    total.outputTokens += Number(e.outputTokens) || 0;
    total.cacheReadTokens += Number(e.cacheReadTokens) || 0;
    total.calls += 1;
  }
  total.totalTokens = total.inputTokens + total.outputTokens + total.cacheReadTokens;
  const prompt = total.inputTokens + total.cacheReadTokens;
  total.cacheHitRate = prompt > 0 ? total.cacheReadTokens / prompt : 0;
  return total;
}
