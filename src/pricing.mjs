/**
 * 官方价格表与费用计算。
 *
 * 价格口径：DeepSeek 官方文档 Models & Pricing（2026-11 抓取），单位「美元 / 100万 tokens」。
 * 官方规则：**错峰价是高峰价的一半**；高峰时段为 UTC 周一至周五 01:00–04:00 与 06:00–10:00
 * （中国法定节假日不算高峰 —— 这里没做节假日日历，按工作日近似，误差只会让估算偏高）。
 *
 * 计价分三档：缓存命中输入 / 缓存未命中输入 / 输出。
 */

/** 每 1M tokens 的**错峰**价（美元）。高峰 = 错峰 × 2。 */
export const PRICES = {
  flash: { label: 'deepseek-flash', cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  pro: { label: 'deepseek-v4-pro', cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
};

/** 没见过的新模型按 flash 计，并在结果里标记为估算。 */
export const DEFAULT_TIER = 'flash';

/** 模型 id → 价格档。只认官方这两档，其它一律回落并标记估算。 */
export function priceTierOf(model) {
  const id = String(model ?? '').toLowerCase();
  if (!id) return { tier: DEFAULT_TIER, known: false };
  if (id.includes('pro')) return { tier: 'pro', known: true };
  if (id.includes('flash')) return { tier: 'flash', known: true };
  // 历史上还有 deepseek-chat / deepseek-reasoner 这类名字，官方现在都并到 flash 档
  if (id.includes('deepseek')) return { tier: 'flash', known: true };
  return { tier: DEFAULT_TIER, known: false };
}

/** 某个时刻是否按高峰计价（UTC 工作日 01–04、06–10 点）。 */
export function isPeak(timeMs) {
  const d = new Date(Number(timeMs) || Date.now());
  const day = d.getUTCDay(); // 0=周日
  if (day === 0 || day === 6) return false;
  const hour = d.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

/**
 * 单次调用的费用（美元）。
 *
 * usage 来自 assistant/message.usage。**字段语义（用真实日志核对过）**：
 *   inputTokens      = 未命中缓存的输入 token（不是输入总量！）
 *   cacheReadTokens  = 命中缓存的输入 token
 *   outputTokens     = 输出 token
 *   totalTokens      = input + output + cacheRead（样例核对：12988+135+2560=15683）
 * 所以计费时：未命中 = inputTokens，命中 = cacheReadTokens，别相减。
 */
export function usageCost(usage, model, timeMs) {
  const u = usage ?? {};
  const { tier, known } = priceTierOf(model);
  const p = PRICES[tier];
  const hit = Math.max(0, Number(u.cacheReadTokens) || 0);
  const miss = Math.max(0, Number(u.inputTokens) || 0); // 未命中，已经是"非缓存"部分
  const out = Math.max(0, Number(u.outputTokens) || 0);
  const multiplier = isPeak(timeMs) ? 2 : 1;
  const usd = ((hit * p.cacheHit) + (miss * p.cacheMiss) + (out * p.output)) / 1_000_000 * multiplier;
  return { usd, hit, miss, out, tier, known };
}

/** 把 token 数写成好读的形式：12.3k / 1.24M。 */
export function fmtTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(2)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

/** 美元金额：小于 1 分也显示，避免出现 $0.00。 */
export function fmtUsd(usd) {
  const v = Number(usd) || 0;
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  if (v < 1) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(2)}`;
}

/** 汇总一组调用的 token 与费用。 */
export function sumUsage(entries) {
  const total = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, calls: 0, estimated: false };
  for (const e of entries ?? []) {
    total.inputTokens += Number(e.inputTokens) || 0;
    total.outputTokens += Number(e.outputTokens) || 0;
    total.cacheReadTokens += Number(e.cacheReadTokens) || 0;
    total.cacheWriteTokens += Number(e.cacheWriteTokens) || 0;
    total.usd += Number(e.usd) || 0;
    total.calls += 1;
    if (e.known === false) total.estimated = true;
  }
  // 和 DSH 自己的口径一致：总 token = 未命中输入 + 输出 + 缓存命中
  total.totalTokens = total.inputTokens + total.outputTokens + total.cacheReadTokens;
  const prompt = total.inputTokens + total.cacheReadTokens;
  total.cacheHitRate = prompt > 0 ? total.cacheReadTokens / prompt : 0;
  return total;
}
