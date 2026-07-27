/**
 * Absorption Score — weighted multi-signal scoring system.
 *
 * Inspired by @magersih's absorption score formula (https://x.com/magersih/status/2080657851475988706):
 *
 *   Old logic:  if volume > x and holders > y and liquidity > z => BUY
 *   New logic:  weighted score with price_response as NEGATIVE signal
 *
 *   score = demand*0.30 + liquidity*0.20 + runner_history*0.15
 *           + smart_wallet*0.20 - price_response*0.15
 *
 * Key insight: price_response (abs price change) is SUBTRACTED because
 * a token that already pumped hard = bad entry. Demand (buy pressure)
 * is the strongest positive signal. Smart wallet presence confirms alpha.
 *
 * Each component is normalized to 0..1 via target-saturation.
 * Raw score range: [-0.15, 0.85]
 * Scaled score (0..100): (raw + 0.15) * 100
 *
 * Works in two modes:
 *   1. FAST — pool data only (no enrichment): uses volume_active_tvl_ratio
 *      as demand proxy, unique_lps_change_pct as liquidity, etc.
 *   2. FULL — with enrichment data (token stats, smart wallets): uses
 *      actual buy/sell volume split, real smart wallet count, etc.
 */

// ─── Defaults ────────────────────────────────────────────────────

export const DEFAULT_WEIGHTS = {
  demand: 0.30,
  liquidity: 0.20,
  runner_history: 0.15,
  smart_wallet: 0.20,
  price_response: -0.15, // negative = subtracted from score
};

export const DEFAULT_TARGETS = {
  // demand: buy_vol / (buy_vol + sell_vol) ratio. 0.60 = 60% buys = strong demand.
  // In fast mode (no buy/sell split), uses volume_active_tvl_ratio / 20 as proxy.
  demandRatio: 0.60,
  demandVolRatioProxy: 20, // volume_active_tvl_ratio that = full demand in fast mode

  // liquidity: unique_lps_change_pct (% growth). 50% LP growth = full score.
  liquidityGrowthPct: 50,
  // In fast mode without LP growth data, uses unique_lps count / 40 as proxy.
  liquidityLpCountProxy: 40,

  // price_response: abs(price_change_pct). 20% move = full penalty.
  priceMovePct: 20,

  // runner_history: max_price / min_price range ratio. 3x range = proven runner.
  runnerRange: 3,

  // smart_wallet: count of tracked smart wallets in pool. 2 = full score.
  smartWalletCount: 2,
};

// ─── Helpers ─────────────────────────────────────────────────────

const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

function num(value) {
  if (value == null) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Normalize a raw value to 0..1 via target saturation.
 * Returns value / target, clamped to [0, 1].
 */
function normalizeTarget(value, target) {
  if (!Number.isFinite(value) || !Number.isFinite(target) || target <= 0) return 0;
  return clamp01(value / target);
}

// ─── Component Extractors ────────────────────────────────────────

/**
 * Demand — buy pressure.
 * FULL mode: buy_vol / (buy_vol + sell_vol) from enriched token stats.
 * FAST mode: volume_active_tvl_ratio / proxy target (high volume relative to TVL = demand).
 */
function extractDemand(pool, enrichment, targets) {
  // Full path: use actual buy/sell volume split if available
  const stats1h = enrichment?.token_info?.stats_1h || pool.token_stats_1h;
  if (stats1h?.buy_vol != null && stats1h?.sell_vol != null) {
    const buyVol = num(stats1h.buy_vol);
    const sellVol = num(stats1h.sell_vol);
    const total = buyVol + sellVol;
    if (total > 0) return normalizeTarget(buyVol / total, targets.demandRatio);
  }

  // Fallback: net buyers direction from token info
  const netBuyers = stats1h?.net_buyers ?? enrichment?.token_info?.stats_1h?.net_buyers;
  if (netBuyers != null) {
    // net_buyers is a count — normalize: 50+ net buyers = full demand
    return normalizeTarget(num(netBuyers), 50);
  }

  // Fast path: volume_active_tvl_ratio as demand proxy
  const volRatio = num(pool.volume_active_tvl_ratio);
  if (volRatio > 0) return normalizeTarget(volRatio, targets.demandVolRatioProxy);

  // Last resort: volume / active_tvl
  const vol = num(pool.volume_window);
  const tvl = num(pool.active_tvl ?? pool.tvl);
  if (tvl > 0 && vol > 0) return normalizeTarget(vol / tvl, targets.demandVolRatioProxy);

  return 0;
}

/**
 * Liquidity growth — LP conviction.
 * Uses unique_lps_change_pct (% growth in unique LPs).
 * Fallback: unique_lps count / proxy target.
 */
function extractLiquidity(pool, enrichment, targets) {
  const lpGrowthPct = num(pool.unique_lps_change_pct);
  if (lpGrowthPct !== 0) return normalizeTarget(lpGrowthPct, targets.liquidityGrowthPct);

  // Fallback: raw LP count as proxy (more LPs = more liquidity confidence)
  const lpCount = num(pool.unique_lps) + num(pool.positions_created);
  if (lpCount > 0) return normalizeTarget(lpCount, targets.liquidityLpCountProxy);

  // Fallback: fee_change_pct (growing fees = growing liquidity health)
  const feeGrowth = num(pool.fee_change_pct);
  if (feeGrowth !== 0) return normalizeTarget(feeGrowth, targets.liquidityGrowthPct);

  return 0;
}

/**
 * Price response — absolute price movement (NEGATIVE signal).
 * Bigger move = worse entry. Uses abs(price_change_pct).
 */
function extractPriceResponse(pool, enrichment, targets) {
  const priceChange = num(pool.price_change_pct);
  if (priceChange !== 0) return normalizeTarget(Math.abs(priceChange), targets.priceMovePct);

  // Fallback: volatility as proxy for price movement
  const vol = num(pool.volatility);
  if (vol > 0) return normalizeTarget(vol, targets.priceMovePct / 10); // scale volatility

  return 0;
}

/**
 * Runner history — has this token proven it can run?
 * Uses max_price / min_price range in the screening window.
 * A wider range = the token has shown runner behavior.
 */
function extractRunnerHistory(pool, enrichment, targets) {
  const maxPrice = num(pool.max_price);
  const minPrice = num(pool.min_price);

  if (maxPrice > 0 && minPrice > 0) {
    const range = maxPrice / minPrice;
    if (Number.isFinite(range) && range > 0) {
      return normalizeTarget(range, targets.runnerRange);
    }
  }

  // Fallback: swap_count + unique_traders as activity proxy (active = likely runner)
  const swaps = num(pool.swap_count);
  const traders = num(pool.unique_traders);
  const activity = swaps + traders * 2;
  if (activity > 0) return normalizeTarget(activity, 500); // 500 activity = full score

  return 0;
}

/**
 * Smart wallet — tracked alpha wallets in this pool.
 * Uses enrichment from checkSmartWalletsOnPool + token holders smart wallet data.
 */
function extractSmartWallet(pool, enrichment, targets) {
  // Primary: smart wallets with positions in this pool
  const inPool = enrichment?.smart_wallets?.in_pool;
  if (Array.isArray(inPool) && inPool.length > 0) {
    return normalizeTarget(inPool.length, targets.smartWalletCount);
  }

  // Fallback: smart wallets holding the token (from getTokenHolders)
  const holding = enrichment?.token_holders?.smart_wallets_holding;
  if (Array.isArray(holding) && holding.length > 0) {
    return normalizeTarget(holding.length, targets.smartWalletCount);
  }

  // Fallback: confidence_boost flag
  if (enrichment?.smart_wallets?.confidence_boost) {
    return 0.5; // half score for confirmed but uncounted presence
  }

  return 0;
}

// ─── Main Export ─────────────────────────────────────────────────

/**
 * Compute the absorption score for a pool.
 *
 * @param {Object} pool - Condensed pool object (from condensePool / getTopCandidates)
 * @param {Object} [enrichment] - Optional enrichment data:
 *   - smart_wallets: result from checkSmartWalletsOnPool
 *   - token_info: result from getTokenInfo (has stats_1h with buy_vol/sell_vol)
 *   - token_holders: result from getTokenHolders (has smart_wallets_holding)
 * @param {Object} [opts] - Override weights and targets
 * @returns {{
 *   score: number,        // raw score [-0.15, 0.85]
 *   scaled: number,       // 0..100 scaled score
 *   components: Object,   // individual normalized components
 *   weights: Object,      // weights used
 * }}
 */
export function absorptionScore(pool, enrichment = {}, opts = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
  const targets = { ...DEFAULT_TARGETS, ...(opts.targets || {}) };

  const components = {
    demand: extractDemand(pool, enrichment, targets),
    liquidity: extractLiquidity(pool, enrichment, targets),
    price_response: extractPriceResponse(pool, enrichment, targets),
    runner_history: extractRunnerHistory(pool, enrichment, targets),
    smart_wallet: extractSmartWallet(pool, enrichment, targets),
  };

  const raw =
    components.demand * weights.demand +
    components.liquidity * weights.liquidity +
    components.runner_history * weights.runner_history +
    components.smart_wallet * weights.smart_wallet +
    components.price_response * weights.price_response; // weight is negative (-0.15)

  // Scale to 0..100: shift by +0.15 (abs of min negative weight) and multiply by 100
  // Min possible raw = -0.15 (only price_response=1, all others=0)
  // Max possible raw = 0.85 (all positive=1, price_response=0)
  const scaled = clamp01((raw + 0.15) / 1.0) * 100;

  return {
    score: Number(raw.toFixed(4)),
    scaled: Number(scaled.toFixed(1)),
    components,
    weights,
  };
}

/**
 * Format absorption score for LLM prompt injection.
 * Returns a compact string showing the score and component breakdown.
 */
export function formatAbsorptionScore(result) {
  if (!result?.components) return "";
  const { score, scaled, components, weights } = result;
  const lines = [
    `Absorption Score: ${scaled}/100 (raw ${score})`,
    `  demand         ${(components.demand * 100).toFixed(0)}% × ${weights.demand}`,
    `  liquidity      ${(components.liquidity * 100).toFixed(0)}% × ${weights.liquidity}`,
    `  runner_history ${(components.runner_history * 100).toFixed(0)}% × ${weights.runner_history}`,
    `  smart_wallet   ${(components.smart_wallet * 100).toFixed(0)}% × ${weights.smart_wallet}`,
    `  price_response ${(components.price_response * 100).toFixed(0)}% × ${weights.price_response} (PENALTY)`,
  ];
  return lines.join("\n");
}

/**
 * Batch-score multiple pools and return sorted by absorption score (desc).
 * Optionally enriches each pool if an enrichFn is provided.
 *
 * @param {Array} pools - Array of condensed pool objects
 * @param {Function} [enrichFn] - async (pool) => enrichment object
 * @param {Object} [opts] - Override weights and targets
 * @returns {Array} pools with absorption_score attached, sorted desc
 */
export async function rankByAbsorption(pools, enrichFn, opts = {}) {
  const scored = await Promise.all(
    pools.map(async (pool) => {
      const enrichment = enrichFn ? await enrichFn(pool).catch(() => ({})) : {};
      const result = absorptionScore(pool, enrichment, opts);
      return { ...pool, absorption_score: result };
    })
  );
  return scored.sort((a, b) => b.absorption_score.scaled - a.absorption_score.scaled);
}
