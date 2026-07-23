/**
 * Copy Top LPers Engine
 *
 * Tracks top-performing LPs (from TrackLP / Meteora) and mirrors their positions.
 *
 * How it works:
 * 1. Fetch top LPs from TrackLP API or Agent Meridian
 * 2. For each top LP, check what pools they recently deployed in
 * 3. If a pool passes our screening, auto-deploy with matching strategy/range
 *
 * Config (user-config.json):
 * {
 *   "copyLp": {
 *     "enabled": true,
 *     "maxPools": 3,
 *     "minLpWinRate": 70,
 *     "minLpPositions": 5,
 *     "copyIntervalMin": 60,
 *     "strategy": "copy_ratio",
 *     "followOnly": []
 *   }
 * }
 *
 * Data sources:
 * - TrackLP: https://tracklp.com/api
 * - Agent Meridian: /top-lp + /study-top-lp
 * - Meteora DLMM API: /positions
 */
import fs from "fs";
import { config, repoPath } from "./config.js";
import { log } from "./logger.js";
import { getTopCandidates } from "./tools/screening.js";
import { deployPosition } from "./tools/dlmm.js";

const COPY_STATE_FILE = repoPath("copylp-state.json");

let state = { trackedLps: {}, deployedPools: [] };
try {
  state = JSON.parse(fs.readFileSync(COPY_STATE_FILE, "utf8"));
} catch {}

function saveState() {
  try {
    fs.writeFileSync(COPY_STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

// ─── Data Sources ─────────────────────────────────────────

/**
 * Fetch top LPers from TrackLP public API.
 * Falls back to Agent Meridian if TrackLP fails.
 */
async function fetchTopLPersFromTrackLP(limit = 20) {
  try {
    const res = await fetch(`https://api.tracklp.com/v1/top-lps?limit=${limit}&sort=win_rate`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`TrackLP HTTP ${res.status}`);
    const data = await res.json();
    return (data?.lps || data?.data || []).map(lp => ({
      address: lp.address || lp.owner || lp.wallet,
      name: lp.name || `LP ${(lp.address || "").slice(0, 6)}`,
      winRate: lp.win_rate ?? lp.winRate ?? lp.stats?.winRate,
      totalPositions: lp.total_positions ?? lp.positions ?? lp.stats?.totalPositions,
      totalPnl: lp.total_pnl ?? lp.pnl ?? lp.stats?.totalPnl,
      avgHoldHours: lp.avg_hold_hours ?? lp.avgHoldHours,
      preferredStrategy: lp.preferred_strategy ?? lp.strategy,
      platform: "tracklp",
    }));
  } catch (e) {
    log("copylp_warn", `TrackLP fetch failed: ${e.message}`);
    return [];
  }
}

/**
 * Fetch top LPers from Agent Meridian.
 */
async function fetchTopLPersFromMeridian(limit = 20) {
  try {
    const baseUrl = config.api.url || "https://api.agentmeridian.xyz/api";
    const res = await fetch(`${baseUrl}/top-lp?limit=${limit}`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Meridian HTTP ${res.status}`);
    const data = await res.json();
    return (data?.lpers || data?.data || []).map(lp => ({
      address: lp.address || lp.wallet || lp.id,
      name: lp.name || `LP ${(lp.address || "").slice(0, 6)}`,
      winRate: lp.win_rate ?? lp.winRate,
      totalPositions: lp.total_positions ?? lp.positions,
      totalPnl: lp.total_pnl ?? lp.pnl,
      avgHoldHours: lp.avg_hold_hours,
      preferredStrategy: lp.preferred_strategy ?? lp.lp_strategy,
      platform: "meridian",
    }));
  } catch (e) {
    log("copylp_warn", `Meridian top-lp fetch failed: ${e.message}`);
    return [];
  }
}

/**
 * Fetch a specific LPer's recent positions to mirror.
 */
async function fetchLpPositions(lpAddress, platform) {
  try {
    let url;
    if (platform === "meridian") {
      const baseUrl = config.api.url || "https://api.agentmeridian.xyz/api";
      url = `${baseUrl}/study-top-lp?address=${lpAddress}&limit=5`;
    } else if (platform === "tracklp") {
      url = `https://api.tracklp.com/v1/lp/${lpAddress}/positions?limit=5&status=open`;
    } else {
      return [];
    }

    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`LP positions HTTP ${res.status}`);
    const data = await res.json();
    const positions = data?.positions || data?.data || [];

    return positions.map(p => ({
      poolAddress: p.pool || p.pool_address || p.poolId,
      poolName: p.pair || p.name || p.pool_name,
      strategy: p.strategy || p.lp_strategy,
      binsBelow: p.bins_below ?? p.min_bin_id ? null : null,
      binsAbove: p.bins_above ?? 0,
      amountSol: p.amount_sol ?? p.deposited_sol ?? p.amount_y ?? 0,
      minBinId: p.min_bin_id ?? p.lower_bin ?? null,
      maxBinId: p.max_bin_id ?? p.upper_bin ?? null,
      timestamp: p.created_at || p.timestamp,
    }));
  } catch (e) {
    log("copylp_warn", `Failed to fetch positions for ${lpAddress.slice(0, 8)}: ${e.message}`);
    return [];
  }
}

// ─── Main Logic ──────────────────────────────────────────

/**
 * Run the copy-LP cycle.
 * Returns summary of what was found and deployed.
 */
export async function runCopyLPCycle() {
  if (!config.copyLp?.enabled) {
    return { skipped: true, reason: "Copy LP disabled" };
  }

  const cfg = config.copyLp;
  const minWinRate = cfg.minLpWinRate ?? 70;
  const minPositions = cfg.minLpPositions ?? 5;
  const maxPools = cfg.maxPools ?? 3;
  const followOnly = cfg.followOnly || [];

  // 1. Fetch top LPers from both sources
  const [tracklpLps, meridianLps] = await Promise.all([
    fetchTopLPersFromTrackLP(20),
    fetchTopLPersFromMeridian(20),
  ]);

  // Merge and deduplicate
  const allLps = [...tracklpLps, ...meridianLps];
  const seen = new Set();
  const uniqueLps = allLps.filter(lp => {
    if (!lp.address || seen.has(lp.address)) return false;
    seen.add(lp.address);
    return true;
  });

  if (uniqueLps.length === 0) {
    return { skipped: true, reason: "No top LPers found from any source" };
  }

  // 2. Filter LPers by criteria
  let filteredLps = uniqueLps.filter(lp => {
    const wr = lp.winRate ?? 0;
    const totalPos = lp.totalPositions ?? 0;
    if (followOnly.length > 0) return followOnly.includes(lp.address) || followOnly.includes(lp.name);
    return wr >= minWinRate && totalPos >= minPositions;
  });

  if (filteredLps.length === 0) {
    // Fallback: take top 5 regardless
    filteredLps = uniqueLps.slice(0, 5);
  }

  log("copylp", `Found ${filteredLps.length} qualifying LPers to copy (from ${uniqueLps.length} total)`);

  // 3. Fetch recent positions from top LPers
  let allPositions = [];
  for (const lp of filteredLps.slice(0, 5)) {
    const positions = await fetchLpPositions(lp.address, lp.platform);
    log("copylp", `${lp.name}: ${positions.length} recent positions`);
    allPositions.push(...positions.map(p => ({ ...p, lper: lp })));
  }

  // 4. Deduplicate by pool address
  const poolSeen = new Set();
  const uniquePools = allPositions.filter(p => {
    if (!p.poolAddress || poolSeen.has(p.poolAddress)) return false;
    if (state.deployedPools.includes(p.poolAddress)) return false; // already copied
    poolSeen.add(p.poolAddress);
    return true;
  });

  if (uniquePools.length === 0) {
    return { skipped: true, reason: "No new pools found from tracked LPers" };
  }

  log("copylp", `${uniquePools.length} new pools discovered: ${uniquePools.map(p => p.poolName || p.poolAddress.slice(0, 8)).join(", ")}`);

  // 5. For each pool, check if it passes our screening thresholds
  const candidates = [];
  for (const pool of uniquePools.slice(0, maxPools)) {
    try {
      const topCandidates = await getTopCandidates({ limit: 20 });
      const matches = (topCandidates?.candidates || [])
        .filter(c => c.pool === pool.poolAddress || c.name === pool.poolName);

      if (matches.length > 0) {
        candidates.push({ pool, match: matches[0] });
        log("copylp", `Pool ${pool.poolName || pool.poolAddress.slice(0, 8)} passed screening`);
      } else {
        log("copylp", `Pool ${pool.poolName || pool.poolAddress.slice(0, 8)} did NOT pass screening — skipping`);
      }
    } catch (e) {
      log("copylp_warn", `Screening check failed for ${pool.poolAddress.slice(0, 8)}: ${e.message}`);
    }
  }

  // 6. Deploy to matching pools
  const deployed = [];
  for (const { pool, match } of candidates) {
    try {
      const strategyToUse = pool.strategy || config.strategy.strategy;
      const binsBelow = pool.binsBelow ?? config.strategy.defaultBinsBelow;
      const deployAmount = config.management.deployAmountSol;

      const result = await deployPosition({
        pool_address: pool.poolAddress,
        amount_y: deployAmount,
        amount_x: 0,
        strategy: strategyToUse,
        bins_below: binsBelow,
        bins_above: 0,
        pool_name: pool.poolName || match.name,
        bin_step: match.bin_step,
        volatility: match.volatility,
        fee_tvl_ratio: match.fee_active_tvl_ratio,
        organic_score: match.organic_score,
        initial_value_usd: match.tvl ?? match.active_tvl,
      });

      if (result?.error) {
        log("copylp_warn", `Deploy failed for ${pool.poolName}: ${result.error}`);
        continue;
      }

      state.deployedPools.push(pool.poolAddress);
      deployed.push({
        pool: pool.poolAddress,
        pair: pool.poolName || "unknown",
        strategy: strategyToUse,
        position: result.position,
        lper: pool.lper?.name,
        lperWinRate: pool.lper?.winRate,
      });

      log("copylp", `✅ Copied ${pool.lper?.name} → ${pool.poolName}: ${strategyToUse} @ ${deployAmount} SOL`);
    } catch (e) {
      log("copylp_error", `Deploy error for ${pool.poolName}: ${e.message}`);
    }
  }

  saveState();

  return {
    lpers: filteredLps.map(l => ({ name: l.name, wr: l.winRate, pos: l.totalPositions })),
    poolsDiscovered: uniquePools.length,
    poolsPassed: candidates.length,
    deployed,
  };
}

/**
 * Format copy-LP status for display.
 */
export function formatCopyLpStatus() {
  if (!config.copyLp?.enabled) return "Copy LP: disabled";

  return [
    `Copy LP: enabled`,
    `Tracked pools: ${state.deployedPools.length}`,
    `Sources: TrackLP + Meridian`,
    `Min win rate: ${config.copyLp.minWinRate ?? 70}%`,
    `Max pools/cycle: ${config.copyLp.maxPools ?? 3}`,
  ].join("\n");
}
