/**
 * Deterministic regime classifier for DLMM entries.
 * This module is deliberately pure so it can be tested without RPC or wallet state.
 */

const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

export function classifyRegime(pool = {}) {
  const volatility = finite(pool.volatility);
  const volumeChange = finite(pool.volume_change_pct);
  const feeChange = finite(pool.fee_change_pct);
  const priceChange = finite(pool.price_change_pct);
  const feeRatio = finite(pool.fee_active_tvl_ratio);
  const absorption = finite(pool.absorption_score?.scaled ?? pool.absorption_scaled);

  if (volatility == null || volatility <= 0) return { regime: "INSUFFICIENT_DATA", reason: "volatility unavailable" };
  if (volumeChange != null && volumeChange <= -40) return { regime: "DECAYING", reason: "volume fell >= 40%" };
  if (feeChange != null && feeChange <= -40) return { regime: "DECAYING", reason: "fees fell >= 40%" };
  if (priceChange != null && priceChange >= 25) return { regime: "OVEREXTENDED", reason: "price already rallied >= 25%" };
  if (priceChange != null && priceChange <= -15) return { regime: "DOWNTREND", reason: "price declined >= 15%" };
  if (volatility >= 12) return { regime: "HIGH_VOLATILITY", reason: "volatility >= 12" };
  if (feeRatio != null && feeRatio >= 0.15 && (volumeChange == null || volumeChange >= 0) && (feeChange == null || feeChange >= 0)) {
    return { regime: absorption != null && absorption >= 55 ? "ACCUMULATION" : "RANGE" , reason: "fees and volume are healthy" };
  }
  return { regime: "TRENDING", reason: "no defensive regime triggered" };
}

export function getAdaptivePlan(pool = {}) {
  const classification = classifyRegime(pool);
  const plans = {
    ACCUMULATION: { strategy: "spot", bins_below: 24, bins_above: 16, min_absorption_score: 55 },
    RANGE: { strategy: "spot", bins_below: 20, bins_above: 20, min_absorption_score: 45 },
    TRENDING: { strategy: "spot", bins_below: 28, bins_above: 12, min_absorption_score: 50 },
    HIGH_VOLATILITY: { strategy: "spot", bins_below: 55, bins_above: 25, min_absorption_score: 55 },
    OVEREXTENDED: { strategy: "none", reason: "wait for retracement" },
    DOWNTREND: { strategy: "none", reason: "downtrend is not an entry" },
    DECAYING: { strategy: "none", reason: "fee/volume decay" },
    INSUFFICIENT_DATA: { strategy: "none", reason: "insufficient market data" },
  };
  const plan = plans[classification.regime] || plans.INSUFFICIENT_DATA;
  return { ...classification, ...plan, bins_below: clamp(plan.bins_below ?? 0, 0, 200), bins_above: clamp(plan.bins_above ?? 0, 0, 200) };
}