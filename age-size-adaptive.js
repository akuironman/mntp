/** Pure age/size adaptive DLMM selector based on public TrackLP research. */
const finite = (value) => Number.isFinite(Number(value)) ? Number(value) : null;

export function chooseAgeSizePlan(pool = {}, deployAmountSol = null) {
  const age = finite(pool.token_age_hours);
  const volatility = finite(pool.volatility);
  const feeRatio = finite(pool.fee_active_tvl_ratio);
  const volumeChange = finite(pool.volume_change_pct);
  const feeChange = finite(pool.fee_change_pct);
  const priceChange = finite(pool.price_change_pct);
  const amount = finite(deployAmountSol);
  if (age == null || age < 12) return { eligible: false, regime: "INSUFFICIENT_AGE", reason: "pool must have at least 12 hours of history" };
  if (volatility == null || volatility <= 0) return { eligible: false, regime: "INSUFFICIENT_DATA", reason: "volatility unavailable" };
  if (feeRatio == null || feeRatio < 0.15) return { eligible: false, regime: "WEAK_FEES", reason: "fee/active-TVL below 0.15" };
  if (volumeChange != null && volumeChange <= -40) return { eligible: false, regime: "DECAYING", reason: "volume fell >= 40%" };
  if (feeChange != null && feeChange <= -40) return { eligible: false, regime: "DECAYING", reason: "fees fell >= 40%" };
  if (priceChange != null && priceChange >= 25) return { eligible: false, regime: "OVEREXTENDED", reason: "price already rallied >= 25%" };
  if (age < 72) return { eligible: true, regime: "NEW_POOL_SPOT", strategy: "spot", bins_below: 15, bins_above: 15, minimum_hold_minutes: 0, reason: "pool under 3 days; use spot for fast fee capture" };
  if (age >= 240) return { eligible: true, regime: "MATURE_POOL_BIDASK", strategy: "bid_ask", bins_below: 40, bins_above: 0, minimum_hold_minutes: 60, reason: "pool at least 10 days old; use BidAsk with a 60-minute minimum hold" };
  if (amount != null && amount > 2) return { eligible: true, regime: "MID_POOL_LARGE_BIDASK", strategy: "bid_ask", bins_below: 35, bins_above: 0, minimum_hold_minutes: 60, reason: "3-10 day pool with larger position; use BidAsk" };
  return { eligible: true, regime: "MID_POOL_SPOT", strategy: "spot", bins_below: 25, bins_above: 15, minimum_hold_minutes: 0, reason: "3-10 day pool with smaller position; use Spot" };
}