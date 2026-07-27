import test from "node:test";
import assert from "node:assert/strict";

import { buildDeployNotification } from "../telegram.js";

test("deploy notification renders the selected library strategy and Meteora deploy type", () => {
  const html = buildDeployNotification({
    pair: "SalaryCat-SOL",
    amountSol: 1,
    position: "F3huacAF123456789",
    tx: "2ub3UWeasMgH65mA123456789",
    strategy: "spot",
    strategyName: "MavourG Alpha Spot",
  });

  assert.match(html, /Strategy: <code>MavourG Alpha Spot \(SPOT\)<\/code>/);
  assert.doesNotMatch(html, /BID-ASK \(single-sided\)/);
});

test("deploy notification falls back to the actual Meteora strategy type", () => {
  const html = buildDeployNotification({
    pair: "SalaryCat-SOL",
    amountSol: 1,
    position: "F3huacAF123456789",
    tx: "2ub3UWeasMgH65mA123456789",
    strategy: "bid_ask",
  });

  assert.match(html, /<code>BID ASK<\/code>/);
});
