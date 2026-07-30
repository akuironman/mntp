import assert from "node:assert/strict";
import { classifyRegime, getAdaptivePlan } from "../regime-adaptive.js";

const base = {
  volatility: 4,
  fee_active_tvl_ratio: 0.2,
  volume_change_pct: 8,
  fee_change_pct: 5,
  price_change_pct: 4,
  absorption_score: { scaled: 60 },
};

assert.equal(classifyRegime(base).regime, "ACCUMULATION");
assert.equal(getAdaptivePlan(base).bins_below, 24);
assert.equal(classifyRegime({ ...base, price_change_pct: 30 }).regime, "OVEREXTENDED");
assert.equal(getAdaptivePlan({ ...base, price_change_pct: 30 }).strategy, "none");
assert.equal(classifyRegime({ ...base, volume_change_pct: -45 }).regime, "DECAYING");
assert.equal(classifyRegime({ ...base, volatility: 15 }).regime, "HIGH_VOLATILITY");
assert.equal(classifyRegime({}).regime, "INSUFFICIENT_DATA");

console.log("Regime-adaptive strategy tests passed");