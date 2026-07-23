import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";
import { repoPath } from "./repo-root.js";

const STATE_FILE = repoPath("state.json");
const LESSONS_FILE = repoPath("lessons.json");

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at) > last24h);

  // 2. Performance Activity (from performance log)
  const perfLast24h = (lessonsData.performance || []).filter(p => new Date(p.recorded_at) > last24h);
  const totalPnLUsd = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);

  // 3. Lessons Learned
  const lessonsLast24h = (lessonsData.lessons || []).filter(l => new Date(l.created_at) > last24h);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();

  // 5. Format Message
  const DSEP = "━━━━━━━━━━━━━━━━━━━━━";
  const SEP_ = "─────────────────────";
  const pnlEmoji = totalPnLUsd > 0 ? "🟢" : totalPnLUsd < 0 ? "🔴" : "🟡";
  const lines = [
    "☀️ <b>MORNING BRIEFING</b>  <i>(Last 24h)</i>",
    DSEP,
    `📊 <b>Activity</b>`,
    `   📥 Opened: <b>${openedLast24h.length}</b>   |   📤 Closed: <b>${closedLast24h.length}</b>`,
    "",
    `💰 <b>Performance</b>`,
    `   ${pnlEmoji} Net PnL: <code>${totalPnLUsd >= 0 ? "+" : ""}$${totalPnLUsd.toFixed(2)}</code>`,
    `   💎 Fees earned: <code>$${totalFeesUsd.toFixed(2)}</code>`,
    perfLast24h.length > 0
      ? `   📈 Win rate: <code>${Math.round((perfLast24h.filter(p => p.pnl_usd > 0).length / perfLast24h.length) * 100)}%</code>`
      : "   📈 Win rate: <i>N/A</i>",
    "",
    `💡 <b>Lessons Learned</b>`,
    lessonsLast24h.length > 0
      ? lessonsLast24h.map(l => `   • ${l.rule}`).join("\n")
      : "   <i>No new lessons recorded overnight.</i>",
    SEP_,
    `📂 <b>Current Portfolio</b>`,
    `   Open positions: <b>${openPositions.length}</b>`,
    perfSummary
      ? `   📊 All-time PnL: <code>$${perfSummary.total_pnl_usd.toFixed(2)}</code>  <i>(${perfSummary.win_rate_pct}% win)</i>`
      : "",
    DSEP
  ];

  return lines.join("\n");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
