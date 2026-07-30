import assert from "node:assert/strict";
import { chooseAgeSizePlan } from "../age-size-adaptive.js";
const common = { token_age_hours: 24, volatility: 4, fee_active_tvl_ratio: 0.2, volume_change_pct: 5, fee_change_pct: 5, price_change_pct: 2 };
assert.equal(chooseAgeSizePlan(common, 0.5).strategy, "spot");
assert.equal(chooseAgeSizePlan({ ...common, token_age_hours: 240 }, 2).strategy, "bid_ask");
assert.equal(chooseAgeSizePlan({ ...common, token_age_hours: 240 }, 2).minimum_hold_minutes, 60);
assert.equal(chooseAgeSizePlan({ ...common, token_age_hours: 6 }, 0.5).eligible, false);
assert.equal(chooseAgeSizePlan({ ...common, token_age_hours: 240, price_change_pct: 30 }, 2).eligible, false);
console.log("Age-size adaptive strategy tests passed");