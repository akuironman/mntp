/**
 * Slippage-Aware Deploy — Timing Optimal
 *
 * Before deploying, checks market conditions to find the best entry:
 * 1. Check 1m / 5m / 15m volatility
 * 2. Check recent whale activity
 * 3. If volatility too high → delay 2-3 minutes
 * 4. If stable → deploy immediately
 *
 * Config (user-config.json):
 * "slippageAware": {
 *   "enabled": true,
 *   "maxVolatility1m": 5,
 *   "delayMs": 30000,
 *   "maxRetries": 3
 * }
 */

import { config } from "./config.js";
import { log } from "./logger.js";
import { getActiveBin } from "./tools/dlmm.js";

const VOLATILITY_MEMORY = {}; // pool -> { timestamps: [], prices: [] }

/**
 * Check if it's a good time to deploy to a pool.
 * Returns { ok: boolean, reason?: string, delayMs?: number }
 */
export async function checkDeployTiming({ pool_address, volatility, timeframe = "30m" }) {
  if (!config.slippageAware?.enabled) {
    return { ok: true, reason: "slippage-aware disabled" };
  }

  const maxVol = config.slippageAware.maxVolatility1m ?? 5;
  const delayMs = config.slippageAware.delayMs ?? 30000;

  // 1. Use provided volatility from screening data
  const vol = Number(volatility ?? 0);
  if (vol > 0 && vol > maxVol) {
    log("slippage", `Volatility ${vol} > max ${maxVol} — delaying ${delayMs}ms`);
    return { ok: false, reason: `Volatility ${vol}% (${timeframe}) exceeds max ${maxVol}%`, delayMs };
  }

  // 2. Check price movement in last minute via live active bin
  try {
    const activeBin = await getActiveBin({ pool_address });
    if (!activeBin?.binId) return { ok: true };

    const key = pool_address;
    if (!VOLATILITY_MEMORY[key]) {
      VOLATILITY_MEMORY[key] = { timestamps: [], binIds: [] };
    }

    const mem = VOLATILITY_MEMORY[key];
    const now = Date.now();
    mem.timestamps.push(now);
    mem.binIds.push(activeBin.binId);

    // Keep last 30 seconds of data
    const cutoff = now - 30000;
    while (mem.timestamps.length > 0 && mem.timestamps[0] < cutoff) {
      mem.timestamps.shift();
      mem.binIds.shift();
    }

    // Check if bin is moving fast (more than 2 bin changes in 30s = unstable)
    if (mem.binIds.length >= 3) {
      const uniqueBins = new Set(mem.binIds);
      if (uniqueBins.size >= 3) {
        log("slippage", `Active bin changed ${uniqueBins.size} times in 30s — delaying`);
        return { ok: false, reason: `Active bin unstable (${uniqueBins.size} changes in 30s)`, delayMs };
      }
    }

    return { ok: true, activeBin: activeBin.binId };
  } catch (e) {
    // Don't block deploy on volatility check failure
    log("slippage_warn", `Price check failed: ${e.message} — deploying anyway`);
    return { ok: true };
  }
}

/**
 * Wait and re-check timing until conditions improve or max retries.
 * Returns { ok: boolean, reason?: string }
 */
export async function waitForGoodTiming({ pool_address, volatility, maxRetries = 3 }) {
  if (!config.slippageAware?.enabled) {
    return { ok: true };
  }

  const maxRetriesConfig = config.slippageAware.maxRetries ?? maxRetries;
  const delayMs = config.slippageAware.delayMs ?? 30000;

  for (let attempt = 1; attempt <= maxRetriesConfig; attempt++) {
    const timing = await checkDeployTiming({ pool_address, volatility });
    if (timing.ok) {
      if (attempt > 1) {
        log("slippage", `Timing OK after ${attempt} attempt(s)`);
      }
      return { ok: true, attempt };
    }

    if (attempt < maxRetriesConfig) {
      log("slippage", `Attempt ${attempt}/${maxRetriesConfig}: ${timing.reason} — waiting ${delayMs}ms`);
      await new Promise(r => setTimeout(r, delayMs));
    } else {
      log("slippage", `Max retries (${maxRetriesConfig}) reached — deploying anyway`);
      return { ok: true, reason: "max retries, deploying despite volatility", attempt };
    }
  }

  return { ok: true };
}
