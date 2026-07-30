import fs from "fs";
import { repoPath } from "./repo-root.js";
import { getPerformanceHistory } from "./lessons.js";

const OPS_FILE = repoPath("telegram-ops.json");

function load() {
  try {
    if (fs.existsSync(OPS_FILE)) return JSON.parse(fs.readFileSync(OPS_FILE, "utf8"));
  } catch {}
  return { alerts: { deploy: true, close: true, stoploss: true, takeprofit: true, oor: true, lowyield: true, health: true }, watchlist: [] };
}
function save(data) { fs.writeFileSync(OPS_FILE, JSON.stringify(data, null, 2)); }
const n = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
const esc = (v) => String(v ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

export function getAlertSettings() { return load().alerts; }
export function setAlert(name, enabled) { const d = load(); if (!(name in d.alerts)) return false; d.alerts[name] = Boolean(enabled); save(d); return true; }
export function getWatchlist() { return load().watchlist || []; }
export function addWatch(item) { const d = load(); if (!d.watchlist.some((x) => x.pool === item.pool)) d.watchlist.push({ ...item, added_at: new Date().toISOString() }); save(d); return d.watchlist; }
export function removeWatch(pool) { const d = load(); d.watchlist = d.watchlist.filter((x) => x.pool !== pool); save(d); return d.watchlist; }

export function buildStats(hours = 24) {
  const result = getPerformanceHistory({ hours, limit: 1000 });
  const rows = result.positions || [];
  const wins = rows.filter((x) => n(x.pnl_usd) > 0);
  const losses = rows.filter((x) => n(x.pnl_usd) < 0);
  const grossWin = wins.reduce((s, x) => s + n(x.pnl_usd), 0);
  const grossLoss = Math.abs(losses.reduce((s, x) => s + n(x.pnl_usd), 0));
  return { ...result, gross_win_usd: grossWin, gross_loss_usd: grossLoss, profit_factor: grossLoss ? Number((grossWin / grossLoss).toFixed(2)) : null, average_win_usd: wins.length ? grossWin / wins.length : 0, average_loss_usd: losses.length ? -grossLoss / losses.length : 0, max_drawdown_usd: calculateMaxDrawdown(rows) };
}
function calculateMaxDrawdown(rows) { let equity = 0, peak = 0, dd = 0; for (const r of rows) { equity += n(r.pnl_usd); peak = Math.max(peak, equity); dd = Math.min(dd, equity - peak); } return Number(dd.toFixed(2)); }

export function formatRisk(config, activeStrategy) {
  const r = config.risk, m = config.management, s = config.strategy;
  return `🛡 <b>RISK CONFIG</b>\n━━━━━━━━━━━━\nMax positions: <code>${r.maxPositions}</code>\nPosition size: <code>${m.positionSizePct * 100}%</code>\nMax deploy: <code>${m.deployAmountSol} SOL</code>\nGas reserve: <code>${m.gasReserve} SOL</code>\n\nTP: <code>+${m.takeProfitPct}%</code>\nSL: <code>${m.stopLossPct}%</code>\nTrailing: <code>${m.trailingTakeProfit ? "ON" : "OFF"}</code> (${m.trailingTriggerPct}% / ${m.trailingDropPct}%)\nOOR close: <code>${m.outOfRangeWaitMinutes}m</code>\n\nAuto-deploy: <code>${s.deployEnabled ? "ON" : "OFF"}</code>\nActive strategy: <code>${esc(activeStrategy?.id || s.strategy)}</code>`;
}

export function formatStats(stats, hours) { if (!stats.count) return `📈 <b>PERFORMANCE — ${hours}h</b>\n━━━━━━━━━━━━\nNo closed positions in this period.`; return `📈 <b>PERFORMANCE — ${hours}h</b>\n━━━━━━━━━━━━\nTrades: <code>${stats.count}</code>\nWin rate: <code>${stats.win_rate_pct}%</code>\nNet PnL: <code>${stats.total_pnl_usd}</code>\nAverage win: <code>${stats.average_win_usd.toFixed(2)}</code>\nAverage loss: <code>${stats.average_loss_usd.toFixed(2)}</code>\nProfit factor: <code>${stats.profit_factor ?? "n/a"}</code>\nMax drawdown: <code>${stats.max_drawdown_usd}</code>`; }

export function formatHistory(rows) { if (!rows.length) return "📭 <b>No performance history.</b>"; return `📚 <b>HISTORY</b>\n━━━━━━━━━━━━\n${rows.map((r, i) => `${i + 1}. <b>${esc(r.pool_name || r.pool)}</b> · ${esc(r.strategy)} · PnL <code>${n(r.pnl_pct).toFixed(2)}%</code> · ${esc(r.close_reason || "closed")}`).join("\n")}`; }

export function pendingConfirmation(type, value, ttlMs = 60_000) { return { type, value, expires_at: Date.now() + ttlMs }; }
export function isConfirmationValid(confirm, type, value) { return Boolean(confirm && confirm.type === type && confirm.value === value && confirm.expires_at > Date.now()); }
