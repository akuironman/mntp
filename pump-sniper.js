/**
 * Pump.fun → Meteora Bridge Sniper
 *
 * Monitors pump.fun trending / bonding-curve tokens.
 * When a token graduates from pump.fun (bonding curve completes),
 * it creates a Meteora pool. This module detects that migration
 * and auto-deploys before retail catches on.
 *
 * Flow:
 * 1. Poll pump.fun API (via GMGN) for tokens approaching graduation
 * 2. Track their mint addresses
 * 3. Poll Meteora DLMM API for new pools with those mints
 * 4. When pool detected + screening passes → deploy immediately
 *
 * Config (user-config.json):
 * "pumpSniper": {
 *   "enabled": true,
 *   "pollIntervalMs": 15000,
 *   "minMarketCap": 30000,
 *   "minVolumeSol": 5,
 *   "maxAgeMinutes": 30,
 *   "deployAmountSol": 0.3,
 *   "strategy": "spot",
 *   "bins_below": 35
 * }
 */

import fs from "fs";
import { config, repoPath, computeDeployAmount } from "./config.js";
import { log } from "./logger.js";
import { deployPosition } from "./tools/dlmm.js";

const SNIPER_STATE_FILE = repoPath("pump-sniper-state.json");
const DEFAULT_SNIPER_CONFIG = {
  enabled: false,
  pollIntervalMs: 15_000,
  minMarketCap: 30_000,
  minVolumeSol: 5,
  maxAgeMinutes: 30,
  deployAmountSol: 0.3,
  strategy: "spot",
  bins_below: 35,
};

// ─── State ──────────────────────────────────────────────

let state = { tracked: {}, deployed: [] };
try {
  state = JSON.parse(fs.readFileSync(SNIPER_STATE_FILE, "utf8"));
} catch {}

function saveState() {
  try {
    fs.writeFileSync(SNIPER_STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

// ─── GMGN / Meteora helpers ─────────────────────────────

const GMGN_BASE = "https://openapi.gmgn.ai";
const METEORA_DLMM_API = "https://dlmm.datapi.meteora.ag";
const PUMP_BONDING_CURVE = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

function gmgnApiKey() {
  return config.gmgn?.apiKey || process.env.GMGN_API_KEY || "";
}

/**
 * Fetch trending/most-active tokens from GMGN.
 * Returns tokens with pump.fun metadata (bonding curve progress, market cap).
 */
async function fetchPumpTrending(limit = 30) {
  try {
    const headers = { Accept: "application/json" };
    const apiKey = gmgnApiKey();
    if (apiKey) headers["X-API-Key"] = apiKey;

    const res = await fetch(
      `${GMGN_BASE}/defi/v1/tokens/trending?limit=${limit}&orderby=volume&direction=desc`,
      { headers, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) throw new Error(`GMGN trending HTTP ${res.status}`);
    const data = await res.json();
    return (data?.data || []).map(t => ({
      mint: t.address || t.mint,
      symbol: t.symbol,
      name: t.name,
      marketCap: t.market_cap || t.mcap,
      volume24h: t.volume_24h || t.volume,
      liquidity: t.liquidity || t.liquidity_usd,
      price: t.price_usd || t.price,
      ageMinutes: t.age_minutes || t.created_at ? Math.floor((Date.now() - new Date(t.created_at).getTime()) / 60000) : null,
      source: "gmgn_trending",
    }));
  } catch (e) {
    log("pump_warn", `GMGN trending fetch failed: ${e.message}`);
    return [];
  }
}

/**
 * Fetch pump.fun new tokens from GMGN.
 */
async function fetchPumpNewTokens(limit = 20) {
  try {
    const headers = { Accept: "application/json" };
    const apiKey = gmgnApiKey();
    if (apiKey) headers["X-API-Key"] = apiKey;

    const res = await fetch(
      `${GMGN_BASE}/defi/v1/tokens/new?limit=${limit}&source=pump`,
      { headers, signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) throw new Error(`GMGN new tokens HTTP ${res.status}`);
    const data = await res.json();
    return (data?.data || []).map(t => ({
      mint: t.address || t.mint,
      symbol: t.symbol,
      name: t.name,
      marketCap: t.market_cap || t.mcap,
      volume24h: t.volume_24h || t.volume,
      liquidity: t.liquidity || t.liquidity_usd,
      price: t.price_usd || t.price,
      liquidity_sol: t.liquidity_sol,
      holderCount: t.holder_count,
      ageMinutes: t.age_minutes || t.created_at ? Math.floor((Date.now() - new Date(t.created_at).getTime()) / 60000) : null,
      source: "gmgn_new",
    }));
  } catch (e) {
    log("pump_warn", `GMGN new tokens fetch failed: ${e.message}`);
    return [];
  }
}

/**
 * Check if a mint has a Meteora DLMM pool.
 */
async function checkMeteoraPool(mint) {
  try {
    const res = await fetch(
      `${METEORA_DLMM_API}/pools?token_x=${mint}&limit=5`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const data = await res.json();
    const pools = data?.pools || data?.data || [];
    return pools.find(p => p.address || p.pool) || pools[0] || null;
  } catch {
    return null;
  }
}

/**
 * Check if a mint + symbol pair has a pool on Meteora via search.
 */
async function searchMeteoraByMint(mint) {
  try {
    const res = await fetch(
      `https://dlmm.datapi.meteora.ag/pools?mint=${mint}&limit=5`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.data?.[0] || null;
  } catch {
    return null;
  }
}

/**
 * Get the pool address from Meteora for a token.
 */
async function findPoolForToken(mint) {
  // Try multiple Meteora endpoints
  const endpoints = [
    `https://dlmm.datapi.meteora.ag/pools/find?base_mint=${mint}`,
    `${METEORA_DLMM_API}/pair?mintX=${mint}`,
  ];

  for (const url of endpoints) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) continue;
      const data = await res.json();
      const pool = data?.pools?.[0] || data?.data?.[0] || data;
      if (pool?.address || pool?.pool || pool?.pubkey) {
        return {
          poolAddress: pool.address || pool.pool || pool.pubkey,
          name: pool.name,
          binStep: pool.bin_step || pool.dlmm_params?.bin_step,
          tvl: pool.tvl || pool.active_tvl || pool.liquidity,
          feePct: pool.fee_pct || pool.base_fee_percentage,
          volume: pool.volume || pool.volume_24h,
        };
      }
    } catch {}
  }
  return null;
}

// ─── Screening ──────────────────────────────────────────

function passesPumpScreening(token) {
  const cfg = config.pumpSniper || DEFAULT_SNIPER_CONFIG;
  if (!cfg.enabled) return false;

  const mc = Number(token.marketCap ?? 0);
  const vol = Number(token.volume24h ?? 0);
  const age = Number(token.ageMinutes ?? 999);

  if (mc < (cfg.minMarketCap ?? 30000)) return false;
  if (vol < (cfg.minVolumeSol ?? 5) * 200) return false; // rough SOL→USD
  if (age > (cfg.maxAgeMinutes ?? 30)) return false;
  if (state.deployed.includes(token.mint)) return false;

  return true;
}

// ─── Main Sniper Cycle ─────────────────────────────────

let _sniperPollTimer = null;

/**
 * Start the pump.fun sniper polling loop.
 */
export function startPumpSniper() {
  if (!config.pumpSniper?.enabled) {
    log("pump", "Pump.fun sniper disabled in config");
    return;
  }

  if (_sniperPollTimer) return; // already running

  const interval = config.pumpSniper.pollIntervalMs ?? 15000;
  log("pump", `Starting sniffer — poll every ${interval}ms`);

  const poll = async () => {
    try {
      await runSniperTick();
    } catch (e) {
      log("pump_error", `Sniper tick error: ${e.message}`);
    }
  };

  poll(); // immediate first tick
  _sniperPollTimer = setInterval(poll, interval);
}

/**
 * Stop the sniper polling loop.
 */
export function stopPumpSniper() {
  if (_sniperPollTimer) {
    clearInterval(_sniperPollTimer);
    _sniperPollTimer = null;
    log("pump", "Sniper stopped");
  }
}

/**
 * Run a single sniper tick — scan pump.fun tokens, check for Meteora pools.
 */
export async function runSniperTick() {
  const cfg = config.pumpSniper || DEFAULT_SNIPER_CONFIG;
  if (!cfg.enabled) return { skipped: true };

  // 1. Fetch pump.fun trending + new tokens
  const [trending, newTokens] = await Promise.all([
    fetchPumpTrending(20),
    fetchPumpNewTokens(20),
  ]);
  const allTokens = [...trending, ...newTokens];
  const seen = new Set();
  const unique = allTokens.filter(t => {
    if (!t.mint || seen.has(t.mint)) return false;
    seen.add(t.mint);
    return true;
  });

  if (unique.length === 0) return { skipped: true, reason: "No pump tokens found" };

  // 2. Filter by screening criteria AND only check tokens we haven't found pools for yet
  const candidates = unique.filter(t => passesPumpScreening(t) && !state.tracked[t.mint]);

  if (candidates.length === 0) return { skipped: true, reason: "No new candidates pass screening" };

  log("pump", `Checking ${candidates.length} pump tokens for Meteora pools...`);

  // 3. For each candidate, check if Meteora pool exists
  for (const token of candidates) {
    const pool = await findPoolForToken(token.mint);
    if (pool) {
      log("pump", `🎯 PUMP→METEORA: ${token.symbol || token.mint.slice(0, 8)} — pool ${pool.poolAddress.slice(0, 8)}`);

      // Mark as tracked so we don't re-check
      state.tracked[token.mint] = {
        symbol: token.symbol,
        poolAddress: pool.poolAddress,
        detectedAt: new Date().toISOString(),
        deployed: false,
      };
      saveState();

      // 4. Deploy!
      try {
        const deployAmount = cfg.deployAmountSol ?? computeDeployAmount(1);
        const strategyType = cfg.strategy || config.strategy.strategy;
        const binsBelow = cfg.bins_below ?? config.strategy.defaultBinsBelow;

        const result = await deployPosition({
          pool_address: pool.poolAddress,
          amount_y: deployAmount,
          amount_x: 0,
          strategy: strategyType,
          bins_below: binsBelow,
          bins_above: 0,
          pool_name: pool.name || token.name || token.symbol || token.mint.slice(0, 8),
          bin_step: pool.binStep,
          volatility: null,
          fee_tvl_ratio: null,
          organic_score: null,
        });

        if (result?.error) {
          log("pump_error", `Deploy failed for ${token.symbol}: ${result.error}`);
          state.tracked[token.mint].error = result.error;
        } else {
          state.deployed.push(token.mint);
          state.tracked[token.mint].deployed = true;
          state.tracked[token.mint].position = result.position;
          log("pump", `✅ SNIPED ${token.symbol || token.mint.slice(0, 8)} — ${result.position?.slice(0, 8)}`);
        }
        saveState();
      } catch (e) {
        log("pump_error", `Deploy error for ${token.symbol}: ${e.message}`);
      }
    } else {
      // Track it with timestamp for age check later
      if (!state.tracked[token.mint]) {
        state.tracked[token.mint] = {
          symbol: token.symbol,
          poolAddress: null,
          firstSeen: new Date().toISOString(),
        };
        saveState();
      }
    }
  }

  // Cleanup old tracked tokens (>1 hour old, no pool found)
  const oneHourAgo = Date.now() - 3600000;
  let cleaned = 0;
  for (const [mint, info] of Object.entries(state.tracked)) {
    const seenTime = info.firstSeen ? new Date(info.firstSeen).getTime() : 0;
    if (!info.poolAddress && seenTime > 0 && seenTime < oneHourAgo) {
      delete state.tracked[mint];
      cleaned++;
    }
  }
  if (cleaned > 0) {
    saveState();
    log("pump", `Cleaned ${cleaned} stale tracked tokens`);
  }

  return {
    checked: candidates.length,
    poolFound: candidates.filter(t => state.tracked[t.mint]?.poolAddress).length,
    deployed: state.deployed.length - (state.deployed.length - candidates.filter(t => state.tracked[t.mint]?.deployed).length),
  };
}

/**
 * Format sniper status for display.
 */
export function formatPumpSniperStatus() {
  if (!config.pumpSniper?.enabled) return "Pump.fun sniper: disabled";

  const cfg = config.pumpSniper;
  const tracked = Object.keys(state.tracked).length;
  const deployed = state.deployed.length;
  const withPool = Object.values(state.tracked).filter(t => t.poolAddress).length;

  return [
    "🚀 Pump.fun → Meteora Sniper",
    `Status: ${_sniperPollTimer ? "scanning" : "stopped"}`,
    `Tracked: ${tracked} tokens | With pools: ${withPool} | Deployed: ${deployed}`,
    `Interval: ${cfg.pollIntervalMs}ms | Min MC: $${cfg.minMarketCap}`,
    `Strategy: ${cfg.strategy || config.strategy.strategy} | bins: ${cfg.bins_below ?? config.strategy.defaultBinsBelow}`,
  ].join("\n");
}
