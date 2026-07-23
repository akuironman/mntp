/**
 * Web Dashboard — Live PnL + Positions + Charts
 *
 * Built-in HTTP server (zero npm deps) that serves:
 * - / — Dashboard HTML with live PnL, positions, charts
 * - /api/status — JSON snapshot of wallet, positions, config
 * - /api/positions — detailed position data
 *
 * Accessible from phone via Tailscale/ngrok/localhost.
 * Config (user-config.json): "webDashboard": { "enabled": true, "port": 3333 }
 */

import http from "http";
import fs from "fs";
import { config, repoPath } from "./config.js";
import { log } from "./logger.js";
import { getMyPositions } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getPerformanceSummary } from "./lessons.js";

let _server = null;

/**
 * Start the dashboard server.
 */
export function startDashboard() {
  if (!config.webDashboard?.enabled) {
    log("dashboard", "Web dashboard disabled in config");
    return;
  }

  if (_server) return;

  const port = config.webDashboard.port ?? 3333;

  _server = http.createServer(async (req, res) => {
    try {
      if (req.url === "/api/status") {
        await handleApiStatus(req, res);
      } else if (req.url === "/api/positions") {
        await handleApiPositions(req, res);
      } else {
        handleDashboardHtml(req, res);
      }
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
  });

  _server.listen(port, "0.0.0.0", () => {
    log("dashboard", `📊 Dashboard running on http://0.0.0.0:${port}`);
    log("dashboard", `   Local: http://localhost:${port}`);
  });
}

/**
 * Stop the dashboard server.
 */
export function stopDashboard() {
  if (_server) {
    _server.close();
    _server = null;
    log("dashboard", "Dashboard stopped");
  }
}

// ─── HTML Dashboard ─────────────────────────────────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Meridian Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0f; color: #e0e0e0; padding: 20px; }
  .container { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.5em; margin-bottom: 20px; color: #00d4aa; }
  h2 { font-size: 1.1em; margin: 15px 0 10px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 15px; margin-bottom: 20px; }
  .card { background: #14141f; border: 1px solid #222; border-radius: 12px; padding: 16px; }
  .card h3 { font-size: 0.8em; color: #666; margin-bottom: 8px; text-transform: uppercase; }
  .card .value { font-size: 1.8em; font-weight: 700; }
  .card .sub { font-size: 0.85em; color: #888; margin-top: 4px; }
  .green { color: #00d4aa; }
  .red { color: #ff4d6a; }
  .yellow { color: #ffd166; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; padding: 8px 12px; font-size: 0.8em; color: #666; border-bottom: 1px solid #222; text-transform: uppercase; }
  td { padding: 10px 12px; border-bottom: 1px solid #1a1a2e; font-size: 0.9em; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.75em; font-weight: 600; }
  .tag.in-range { background: #00d4aa22; color: #00d4aa; }
  .tag.out-of-range { background: #ff4d6a22; color: #ff4d6a; }
  .tag.spot { background: #4361ee22; color: #4361ee; }
  .tag.bid_ask { background: #ff9e0022; color: #ff9e00; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 3px; font-size: 0.7em; background: #222; }
  .refresh { position: fixed; bottom: 20px; right: 20px; background: #00d4aa; color: #000; border: none; padding: 10px 20px; border-radius: 8px; font-weight: 700; cursor: pointer; }
  .refresh:hover { background: #00b894; }
  .loading { text-align: center; padding: 40px; color: #666; }
  #lastUpdate { font-size: 0.75em; color: #555; margin-top: 10px; }
  @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="container">
  <h1>📊 Meridian Dashboard</h1>
  <div id="loading" class="loading">Loading...</div>
  <div id="content" style="display:none">
    <div class="grid" id="summaryCards"></div>
    <h2>Open Positions</h2>
    <div class="card" style="padding:0;overflow-x:auto">
      <table><thead><tr>
        <th>Pool</th><th>Status</th><th>Strategy</th><th>PnL</th><th>Fees</th><th>Value</th><th>Age</th>
      </tr></thead><tbody id="positionsBody"></tbody></table>
    </div>
    <div class="grid" style="margin-top:15px">
      <div class="card" id="configCard"><h3>Config</h3><pre id="configPre" style="font-size:0.8em;margin-top:8px;line-height:1.5"></pre></div>
      <div class="card"><h3>Performance</h3><pre id="perfPre" style="font-size:0.8em;margin-top:8px;line-height:1.5"></pre></div>
    </div>
    <div id="lastUpdate"></div>
  </div>
</div>
<button class="refresh" onclick="fetchData()" id="refreshBtn">⟳ Refresh</button>
<script>
async function fetchData() {
  const btn = document.getElementById('refreshBtn');
  btn.textContent = '⟳ Loading...';
  try {
    const [status, positions] = await Promise.all([
      fetch('/api/status').then(r => r.json()),
      fetch('/api/positions').then(r => r.json()),
    ]);
    render(status, positions);
  } catch(e) {
    document.getElementById('content').innerHTML = '<div class="loading" style="color:#ff4d6a">Error: ' + e.message + '</div>';
  }
  btn.textContent = '⟳ Refresh';
}
function render(status, positions) {
  document.getElementById('loading').style.display = 'none';
  document.getElementById('content').style.display = 'block';

  // Summary cards
  const cards = document.getElementById('summaryCards');
  const sol = status.wallet?.sol || 0;
  const solUsd = status.wallet?.sol_usd || 0;
  const solPrice = status.wallet?.sol_price || 0;
  const posCount = status.wallet?.open_positions || 0;
  const maxPos = status.config?.maxPositions || 3;
  const strat = status.config?.strategy || '?';
  const mode = status.config?.deployEnabled ? '🟢' : '🔴';
  cards.innerHTML = [
    \`<div class="card"><h3>SOL Balance</h3><div class="value">\${sol.toFixed(3)} SOL</div><div class="sub">$\${solUsd.toFixed(2)}</div></div>\`,
    \`<div class="card"><h3>SOL Price</h3><div class="value green">$\${solPrice.toFixed(2)}</div></div>\`,
    \`<div class="card"><h3>Positions</h3><div class="value">\${posCount}/\${maxPos}</div><div class="sub">\${mode} \${strat}</div></div>\`,
    \`<div class="card"><h3>Total Value</h3><div class="value" id="totalValue"></div></div>\`,
  ].join('');

  // Positions table
  const tbody = document.getElementById('positionsBody');
  if (!positions.positions || positions.positions.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#666;padding:20px">No open positions</td></tr>';
    document.getElementById('totalValue').textContent = '$0.00';
  } else {
    let totalValue = 0;
    tbody.innerHTML = positions.positions.map(p => {
      const pnl = Number(p.pnl_pct || 0);
      const val = Number(p.total_value_usd || 0);
      const fees = Number(p.unclaimed_fees_usd || 0);
      const age = p.age_minutes ? Math.floor(p.age_minutes) + 'm' : '?';
      const statusClass = p.in_range ? 'in-range' : 'out-of-range';
      const statusText = p.in_range ? '✓' : '⚠ OOR';
      const pnlClass = pnl >= 0 ? 'green' : 'red';
      const stratClass = (p.strategy || '?').toLowerCase();
      totalValue += val;
      return \`<tr><td>\${p.pair || p.position?.slice(0,8)} <span class="badge">\${p.position?.slice(0,6)}</span></td><td><span class="tag \${statusClass}">\${statusText}</span></td><td><span class="tag \${stratClass}">\${p.strategy || '?'}</span></td><td class="\${pnlClass}">\${pnl >= 0 ? '+' : ''}\${pnl.toFixed(2)}%</td><td>$\${fees.toFixed(2)}</td><td>$\${val.toFixed(2)}</td><td>\${age}</td></tr>\`;
    }).join('');
    document.getElementById('totalValue').textContent = \`$\${totalValue.toFixed(2)}\`;
  }

  // Config
  const cfg = status.config || {};
  document.getElementById('configPre').textContent = [
    \`Strategy: \${cfg.strategy}\`,
    \`Deploy: \${cfg.deployOn ? 'ON' : 'OFF'}\`,
    \`Bins: \${cfg.binsBelow}-\${cfg.maxBinsBelow}\`,
    \`Dry run: \${cfg.dryRun ? 'YES' : 'no'}\`,
    \`Manage: \${cfg.managementIntervalMin}m | Screen: \${cfg.screeningIntervalMin}m\`,
  ].join('\\n');

  // Performance
  const perf = status.performance;
  document.getElementById('perfPre').textContent = perf ? [
    \`Closed: \${perf.total_positions_closed}\`,
    \`Win rate: \${perf.win_rate_pct}%\`,
    \`Avg PnL: \${perf.avg_pnl_pct}%\`,
    \`Total fees: $\${perf.total_fees_usd || '0'}\`,
  ].join('\\n') : 'No data yet';

  document.getElementById('lastUpdate').textContent = 'Last: ' + new Date().toLocaleTimeString();
}
fetchData();
setInterval(fetchData, 30000);
</script>
</body>
</html>`;

function handleDashboardHtml(req, res) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(DASHBOARD_HTML);
}

// ─── API handlers ────────────────────────────────────────

async function handleApiStatus(req, res) {
  try {
    const [wallet, positionsResult, perf] = await Promise.all([
      getWalletBalances().catch(() => ({ sol: 0, sol_usd: 0, sol_price: 0 })),
      getMyPositions({ force: true, silent: true }).catch(() => ({ positions: [] })),
      getPerformanceSummary().catch(() => null),
    ]);

    const data = {
      wallet: {
        ...wallet,
        open_positions: positionsResult?.positions?.length || 0,
      },
      config: {
        strategy: config.strategy.strategy,
        deployEnabled: config.strategy.deployEnabled,
        deployOn: config.strategy.deployEnabled,
        binsBelow: config.strategy.minBinsBelow,
        maxBinsBelow: config.strategy.maxBinsBelow,
        dryRun: process.env.DRY_RUN === "true",
        managementIntervalMin: config.schedule.managementIntervalMin,
        screeningIntervalMin: config.schedule.screeningIntervalMin,
        maxPositions: config.risk.maxPositions,
        deployAmountSol: config.management.deployAmountSol,
        solMode: config.management.solMode,
      },
      performance: perf,
      timestamp: new Date().toISOString(),
    };

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
}

async function handleApiPositions(req, res) {
  try {
    const result = await getMyPositions({ force: true, silent: true });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result || { positions: [] }));
  } catch (e) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: e.message }));
  }
}
