/**
 * Auto-Compound Engine v1
 *
 * Flow:
 * 1. Scan open positions for unclaimed fees > threshold
 * 2. Claim fees → returns token X + Y
 * 3. Swap claimed token X → SOL via Jupiter
 * 4. Add liquidity back to the SAME position
 *
 * Integrated into management cycle.
 */
import fs from "fs";
import { config, repoPath } from "./config.js";
import { log } from "./logger.js";
import { claimFees, getMyPositions } from "./tools/dlmm.js";
import { swapToken, getWalletBalances } from "./tools/wallet.js";
import { addLiquidityToPosition, addLiquidityChunkable } from "./tools/dlmm-additions.js";

const STATE_FILE = repoPath("compound-state.json");
const MIN_ADD_SOL = 0.01;

let state = {};
try {
  state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
} catch { state = {}; }

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    log("compound_warn", `State save failed: ${e.message}`);
  }
}

/**
 * Run one compound cycle. Returns summary.
 */
export async function runCompoundCycle() {
  if (!config.compound?.enabled) {
    return { skipped: true, reason: "Auto-compound disabled" };
  }

  const minClaim = config.compound.minClaimAmount ?? 1;
  const maxPerCycle = config.compound.maxPerCycle ?? 3;
  const cooldownMin = config.compound.cooldownMinutes ?? 120;
  const keepPct = config.compound.keepPct ?? 0.8; // 80% of claimed value back in

  const posResult = await getMyPositions({ force: true });
  const positions = posResult?.positions || [];

  const eligible = positions
    .filter(p => {
      if (!p.position) return false;
      const last = state[p.position];
      if (last && (Date.now() - new Date(last).getTime()) / 60000 < cooldownMin) return false;
      return Number(p.unclaimed_fees_usd ?? 0) >= minClaim;
    })
    .sort((a, b) => (b.unclaimed_fees_usd ?? 0) - (a.unclaimed_fees_usd ?? 0))
    .slice(0, maxPerCycle);

  if (!eligible.length) return { skipped: true, reason: "No compoundable positions" };

  log("compound", `Eligible: ${eligible.map(p => `${p.pair} ($${p.unclaimed_fees_usd})`).join(", ")}`);

  const results = [];
  for (const pos of eligible) {
    try {
      results.push(await compoundOne(pos, keepPct));
    } catch (e) {
      log("compound_error", `${pos.pair}: ${e.message}`);
      results.push({ position: pos.position, pair: pos.pair, success: false, error: e.message });
    }
  }

  saveState();
  return {
    results,
    compounded: results.filter(r => r.success).length,
    skipped: results.filter(r => !r.success && r.skipped).length,
    failed: results.filter(r => !r.success && !r.skipped).length,
  };
}

async function compoundOne(pos, keepPct) {
  const posAddr = pos.position;
  const feeUsd = Number(pos.unclaimed_fees_usd ?? 0);

  state[posAddr] = new Date().toISOString();

  // 1. Claim fees
  log("compound", `Claiming $${feeUsd.toFixed(2)} from ${pos.pair}`);
  const claim = await claimFees({ position_address: posAddr });
  if (!claim?.success) throw new Error(`Claim failed: ${claim?.error}`);

  // 2. Swap claimed token X → SOL
  const baseMint = claim.base_mint;
  let addedSol = 0;

  if (baseMint && baseMint !== config.tokens.SOL) {
    try {
      const bal = await getWalletBalances({});
      const token = bal.tokens?.find(t => t.mint === baseMint);
      if (token && token.balance > 0.001) {
        const swap = await swapToken({ input_mint: baseMint, output_mint: "SOL", amount: token.balance });
        if (swap?.success !== false && !swap?.error) {
          log("compound", `Swapped ${token.symbol || "token"} → SOL for ${pos.pair}`);
          // Re-fetch balance after swap
          const bal2 = await getWalletBalances({});
          addedSol = Math.max(0, bal2.sol - config.management.gasReserve - 0.05);
        }
      }
    } catch (e) {
      log("compound_warn", `Swap failed for ${pos.pair}: ${e.message} — claimed but not compounded`);
      return { position: posAddr, pair: pos.pair, success: true, claimed: feeUsd, note: "Claimed, swap failed" };
    }
  }

  // 3. Calculate re-add amount (80% of claimed value, limited by available SOL)
  if (addedSol <= 0) {
    const bal = await getWalletBalances({});
    addedSol = Math.max(0, bal.sol - config.management.gasReserve - 0.05);
  }
  const solToAdd = Math.min(addedSol * keepPct, feeUsd / (await getWalletBalances({})).sol_price * keepPct);
  if (solToAdd < MIN_ADD_SOL) {
    log("compound", `Too little SOL to compound ${pos.pair}: ${solToAdd.toFixed(4)} < ${MIN_ADD_SOL}`);
    return { position: posAddr, pair: pos.pair, success: true, claimed: feeUsd, skipped: true, note: "Fees claimed, skipped add" };
  }

  // 4. Add liquidity back
  const totalBins = (pos.upper_bin ?? 0) - (pos.lower_bin ?? 0);
  const addFn = totalBins > 69 ? addLiquidityChunkable : addLiquidityToPosition;
  const add = await addFn({
    pool_address: pos.pool,
    position_address: posAddr,
    amount_sol: solToAdd,
    strategy: config.strategy.strategy,
  });

  if (!add?.success) throw new Error(`Add liquidity failed: ${add?.error}`);

  log("compound", `✅ Compounded ${solToAdd.toFixed(4)} SOL into ${pos.pair}`);
  return { position: posAddr, pair: pos.pair, success: true, claimed: feeUsd, compounded: true, amount_sol: solToAdd };
}
