import test from "node:test";
import assert from "node:assert/strict";

import { buildDeployNotification } from "../telegram.js";

const DETAILS = {
  pair: "SalaryCat-SOL",
  amountSol: 1,
  position: "F3huacAF123456789",
  tx: "2ub3UWeasMgH65mA123456789",
  strategy: "spot",
  strategyName: "MavourG Alpha Spot",
  priceRange: { min: 0.001732, max: 0.003341 },
  rangeCoverage: { downside_pct: 48.15, upside_pct: 0, width_pct: 92.85 },
  binRange: { min: 1000, max: 1069, active: 1035 },
  binsBelow: 35,
  binsAbove: 34,
  binStep: 100,
  baseFee: 2,
  status: "confirmed",
};

test("deploy notification renders a premium sectioned card", () => {
  const html = buildDeployNotification(DETAILS);

  assert.match(html, /🚀 <b>NEW POSITION DEPLOYED<\/b>/);
  assert.match(html, /💧 <b>SalaryCat \/ SOL<\/b>/);
  assert.match(html, /🟢 <code>MavourG Alpha Spot · SPOT<\/code>/);
  assert.match(html, /💰 <b>CAPITAL<\/b>\n◎ <code>1\.000 SOL<\/code>/);
  assert.match(html, /📐 <b>POSITION RANGE<\/b>/);
  assert.match(html, /<code>0\.001732 ├.*●.*┤ 0\.003341<\/code>/);
  assert.match(html, /↓ 48\.15% · ↑ 0\.00% · Width 92\.85%/);
  assert.match(html, /⚙️ <b>METEORA DLMM<\/b>/);
  assert.match(html, /Bin step <code>100<\/code> · Base fee <code>2%<\/code>/);
  assert.match(html, /Bins <code>35 below · 34 above · 70 total<\/code>/);
  assert.match(html, /✅ <b>CONFIRMED<\/b> · Solana Mainnet/);
});

test("deploy notification links full position and transaction on Solscan", () => {
  const html = buildDeployNotification(DETAILS);

  assert.match(html, /href="https:\/\/solscan\.io\/account\/F3huacAF123456789"/);
  assert.match(html, /href="https:\/\/solscan\.io\/tx\/2ub3UWeasMgH65mA123456789"/);
  assert.match(html, /Position\s+F3hu…6789 ↗/);
  assert.match(html, /Transaction\s+2ub3…6789 ↗/);
});

test("deploy notification falls back to the actual Meteora strategy type", () => {
  const html = buildDeployNotification({
    ...DETAILS,
    strategy: "bid_ask",
    strategyName: null,
    status: null,
  });

  assert.match(html, /🟣 <code>BID ASK<\/code>/);
  assert.doesNotMatch(html, /MavourG Alpha Spot/);
  assert.match(html, /⏳ <b>SUBMITTED<\/b> · Solana Mainnet/);
});

test("deploy notification escapes untrusted pair and strategy labels", () => {
  const html = buildDeployNotification({
    ...DETAILS,
    pair: "CAT<script>-SOL",
    strategyName: "Alpha & <Beta>",
  });

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /CAT&lt;script&gt; \/ SOL/);
  assert.match(html, /Alpha &amp; &lt;Beta&gt; · SPOT/);
});

test("deploy notification omits unavailable optional rows without broken links", () => {
  const html = buildDeployNotification({
    pair: "CAT-SOL",
    amountSol: 0.5,
    strategy: "spot",
  });

  assert.doesNotMatch(html, /undefined|NaN|href="[^\"]*(undefined|null)/);
  assert.doesNotMatch(html, /🔗 <b>ON-CHAIN<\/b>/);
  assert.match(html, /◎ <code>0\.500 SOL<\/code>/);
});
