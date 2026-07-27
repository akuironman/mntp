/**
 * Test the Absorption Score module.
 * Run: node test/test-absorption-score.js
 */

import { absorptionScore, formatAbsorptionScore, rankByAbsorption, DEFAULT_WEIGHTS, DEFAULT_TARGETS } from "../absorption-score.js";

// ─── Test 1: Basic scoring with fast-mode pool data ─────────────

console.log("=== Test 1: Basic scoring (fast mode) ===\n");

const poolA = {
  name: "BONK-SOL",
  volume_active_tvl_ratio: 25,    // high volume relative to TVL = strong demand
  unique_lps_change_pct: 60,      // 60% LP growth = strong liquidity
  positions_created: 10,
  price_change_pct: 5,            // 5% price change = moderate penalty
  max_price: 1.5,
  min_price: 0.8,
  swap_count: 200,
  unique_traders: 80,
};

const poolB = {
  name: "WIF-SOL",
  volume_active_tvl_ratio: 8,     // low demand
  unique_lps_change_pct: 10,      // weak liquidity growth
  positions_created: 3,
  price_change_pct: 45,           // 45% already pumped = BIG penalty
  max_price: 2.5,
  min_price: 1.0,
  swap_count: 500,
  unique_traders: 150,
};

const poolC = {
  name: "PEPE-SOL",
  volume_active_tvl_ratio: 30,    // very high demand
  unique_lps_change_pct: 80,      // strong liquidity
  positions_created: 20,
  price_change_pct: 2,            // barely moved = minimal penalty
  max_price: 2.0,
  min_price: 0.5,                 // 4x range = proven runner
  swap_count: 400,
  unique_traders: 200,
};

const scoreA = absorptionScore(poolA);
const scoreB = absorptionScore(poolB);
const scoreC = absorptionScore(poolC);

console.log("Pool A (BONK-SOL):");
console.log(formatAbsorptionScore(scoreA));
console.log();

console.log("Pool B (WIF-SOL — already pumped):");
console.log(formatAbsorptionScore(scoreB));
console.log();

console.log("Pool C (PEPE-SOL — fresh runner):");
console.log(formatAbsorptionScore(scoreC));
console.log();

// Assertions
console.log("--- Assertions ---");
console.assert(scoreC.scaled > scoreA.scaled, "Pool C (fresh) should score higher than Pool A");
console.assert(scoreA.scaled > scoreB.scaled, "Pool A should score higher than Pool B (pumped)");
console.assert(scoreB.components.price_response > scoreA.components.price_response, "Pool B should have higher price_response penalty");
console.assert(scoreC.components.price_response < scoreA.components.price_response, "Pool C should have lower price_response penalty");
console.assert(scoreC.components.demand > scoreB.components.demand, "Pool C should have higher demand");
console.log("✓ All assertions passed\n");

// ─── Test 2: Full mode with enrichment ──────────────────────────

console.log("=== Test 2: Full mode with enrichment ===\n");

const poolD = {
  name: "DEGEN-SOL",
  volume_active_tvl_ratio: 15,
  unique_lps_change_pct: 30,
  positions_created: 5,
  price_change_pct: 10,
  max_price: 1.8,
  min_price: 0.7,
  swap_count: 100,
  unique_traders: 50,
};

const enrichmentD = {
  smart_wallets: {
    in_pool: [
      { name: "alpha_whale", address: "abc123" },
      { name: "degen_lp", address: "def456" },
    ],
    confidence_boost: true,
  },
  token_info: {
    stats_1h: {
      buy_vol: 50000,
      sell_vol: 20000,
      net_buyers: 35,
    },
  },
};

const scoreD = absorptionScore(poolD, enrichmentD);
console.log("Pool D (DEGEN-SOL with enrichment):");
console.log(formatAbsorptionScore(scoreD));
console.log();

console.log("--- Assertions ---");
const scoreD_noEnrich = absorptionScore(poolD);
console.assert(scoreD.scaled > scoreD_noEnrich.scaled, "Enriched score should be higher (smart wallets + buy pressure data)");
console.assert(scoreD.components.smart_wallet === 1, "Smart wallet should be fully saturated (2 wallets / target 2)");
console.assert(scoreD.components.demand > scoreD_noEnrich.components.demand, "Demand should be higher with real buy/sell data (71% buys)");
console.log("✓ All assertions passed\n");

// ─── Test 3: Rank multiple pools ────────────────────────────────

console.log("=== Test 3: rankByAbsorption ===\n");

const pools = [poolA, poolB, poolC, poolD];
const ranked = await rankByAbsorption(pools);
console.log("Ranked by absorption score (desc):");
for (const p of ranked) {
  console.log(`  ${p.name.padEnd(12)} ${p.absorption_score.scaled.toFixed(1)}/100  (raw ${p.absorption_score.score})`);
}
console.log();

console.log("--- Assertions ---");
console.assert(ranked[0].name === "PEPE-SOL", "PEPE-SOL should rank first (fresh runner, high demand)");
console.assert(ranked[ranked.length - 1].name === "WIF-SOL", "WIF-SOL should rank last (already pumped)");
console.log("✓ All assertions passed\n");

// ─── Test 4: Custom weights ─────────────────────────────────────

console.log("=== Test 4: Custom weights ===\n");

const customWeights = {
  demand: 0.50,         // demand is king
  liquidity: 0.10,
  runner_history: 0.10,
  smart_wallet: 0.10,
  price_response: -0.20, // bigger penalty for pumped tokens
};

const scoreA_custom = absorptionScore(poolA, {}, { weights: customWeights });
console.log("Pool A with custom weights (demand-heavy, bigger price penalty):");
console.log(formatAbsorptionScore(scoreA_custom));
console.log();

console.log("--- Assertions ---");
console.assert(scoreA_custom.weights.demand === 0.50, "Custom demand weight should be applied");
console.assert(scoreA_custom.weights.price_response === -0.20, "Custom price_response weight should be applied");
console.log("✓ All assertions passed\n");

// ─── Test 5: Edge cases ─────────────────────────────────────────

console.log("=== Test 5: Edge cases ===\n");

const emptyPool = {};
const scoreEmpty = absorptionScore(emptyPool);
console.log("Empty pool:", scoreEmpty.scaled, "/100");
console.assert(scoreEmpty.scaled === 15, "Empty pool should have baseline 15/100 (only price_response=0, all others=0)");

const zeroPool = {
  volume_active_tvl_ratio: 0,
  unique_lps_change_pct: 0,
  price_change_pct: 0,
  max_price: 0,
  min_price: 0,
};
const scoreZero = absorptionScore(zeroPool);
console.log("Zero pool:", scoreZero.scaled, "/100");
console.assert(scoreZero.scaled === 15, "Zero pool should also have baseline 15/100");
console.log("✓ All assertions passed\n");

console.log("=== All tests passed ===");
