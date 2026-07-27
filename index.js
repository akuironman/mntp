import "./envcrypt.js";
import cron from "node-cron";
import readline from "readline";
import path from "path";
import { fileURLToPath } from "url";
import { agentLoop } from "./agent.js";
import { log } from "./logger.js";
import { getMyPositions, closePosition, getActiveBin } from "./tools/dlmm.js";
import { getWalletBalances } from "./tools/wallet.js";
import { getTopCandidates, degenScore } from "./tools/screening.js";
import { config, reloadScreeningThresholds, computeDeployAmount } from "./config.js";
import { evolveThresholds, getPerformanceSummary } from "./lessons.js";
import { executeTool, registerCronRestarter } from "./tools/executor.js";
import {
  startPolling,
  stopPolling,
  sendMessage,
  sendMessageWithButtons,
  sendHTML,
  editMessage,
  editMessageWithButtons,
  answerCallbackQuery,
  notifyOutOfRange,
  formatStrategyList,
  formatPositionsList,
  isEnabled as telegramEnabled,
  createLiveMessage,
  escHtml,
  progressBar,
  pnlBar,
  pnlEmoji,
  pnlSign,
  fmtUsd,
  SEP,
  DOUBLE_SEP,
  DOT_SEP,
} from "./telegram.js";
import { generateBriefing } from "./briefing.js";
import { getLastBriefingDate, setLastBriefingDate, getTrackedPosition, getTrackedPositions, setPositionInstruction, updatePnlAndCheckExits, confirmPeak, registerExitSignal } from "./state.js";
import { getActiveStrategy, listStrategies, setActiveStrategy, getStrategy } from "./strategy-library.js";
import { recordPositionSnapshot, recallForPool, addPoolNote } from "./pool-memory.js";
import { checkSmartWalletsOnPool } from "./smart-wallets.js";
import { getTokenNarrative, getTokenInfo } from "./tools/token.js";
import { stageSignals } from "./signal-tracker.js";
import { getWeightsSummary } from "./signal-weights.js";
import { bootstrapHiveMind, ensureAgentId, getHiveMindPullMode, isHiveMindEnabled, pullHiveMindLessons, pullHiveMindPresets, registerHiveMindAgent, startHiveMindBackgroundSync } from "./hivemind.js";
import { appendDecision } from "./decision-log.js";
import { runCompoundCycle } from "./auto-compound.js";
import { runCopyLPCycle, formatCopyLpStatus } from "./copy-lp.js";
import { isPortfolioMode, rotatePortfolio, formatPortfolioStatus } from "./portfolio.js";
import { startPumpSniper, stopPumpSniper, formatPumpSniperStatus } from "./pump-sniper.js";
import { waitForGoodTiming } from "./slippage-aware.js";
import { startDashboard, stopDashboard } from "./web-dashboard.js";

import { REPO_ROOT, repoPath } from "./repo-root.js";

const entrypointPath = process.env.pm_exec_path || process.argv[1];
const indexPath = fileURLToPath(import.meta.url);
const isMain = process.env.pm_id != null
  || (entrypointPath ? path.resolve(entrypointPath) === indexPath : false);

if (isMain) {
  log("startup", "DLMM LP Agent starting...");
  log("startup", `Repo: ${REPO_ROOT} | cwd: ${process.cwd()}${process.env.pm_id ? ` | PM2 id: ${process.env.pm_id}` : ""}`);
  if (path.resolve(process.cwd()) !== path.resolve(REPO_ROOT)) {
    log("startup_warn", `process.cwd() differs from repo root — use "npm run pm2:start" (not "pm2 start index.js" from another directory)`);
  }
  log("startup", `Mode: ${process.env.DRY_RUN === "true" ? "DRY RUN" : "LIVE"}`);
  log("startup", `Model: ${process.env.LLM_MODEL || "hermes-3-405b"}`);
  ensureAgentId();
  bootstrapHiveMind().catch((error) => log("hivemind_warn", `Bootstrap failed: ${error.message}`));
  startHiveMindBackgroundSync();

  // Start Pump.fun sniper
  startPumpSniper();

  // Start Web Dashboard
  startDashboard();
}

const TP_PCT = config.management.takeProfitPct;
const DEPLOY = config.management.deployAmountSol;

// ═══════════════════════════════════════════
//  CYCLE TIMERS
// ═══════════════════════════════════════════
const timers = {
  managementLastRun: null,
  screeningLastRun: null,
};

function nextRunIn(lastRun, intervalMin) {
  if (!lastRun) return intervalMin * 60;
  const elapsed = (Date.now() - lastRun) / 1000;
  return Math.max(0, intervalMin * 60 - elapsed);
}

function formatCountdown(seconds) {
  if (seconds <= 0) return "now";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function buildPrompt() {
  const mgmt = formatCountdown(nextRunIn(timers.managementLastRun, config.schedule.managementIntervalMin));
  const scrn = formatCountdown(nextRunIn(timers.screeningLastRun, config.schedule.screeningIntervalMin));
  return `[manage: ${mgmt} | screen: ${scrn}]\n> `;
}

// ═══════════════════════════════════════════
//  CRON DEFINITIONS
// ═══════════════════════════════════════════
let _cronTasks = [];
let _managementBusy = false; // prevents overlapping management cycles
let _screeningBusy = false;  // prevents overlapping screening cycles
let _screeningLastTriggered = 0; // epoch ms — prevents management from spamming screening
let _lastCopyLpRun = 0;
// Exit/peak confirmation is now done by consecutive-tick counting in state.js
// (registerExitSignal / confirmPeak), driven by the 3s RPC poller — no setTimeout rechecks.

/** Strip <think>...</think> reasoning blocks that some models leak into output */
function stripThink(text) {
  if (!text) return text;
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function sanitizeUntrustedPromptText(text, maxLen = 500) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[<>`]/g, "")
    .trim()
    .slice(0, maxLen);
  return cleaned ? JSON.stringify(cleaned) : null;
}

async function runBriefing() {
  log("cron", "Starting morning briefing");
  try {
    const briefing = await generateBriefing();
    if (telegramEnabled()) {
      await sendHTML(briefing);
    }
    setLastBriefingDate();
  } catch (error) {
    log("cron_error", `Morning briefing failed: ${error.message}`);
  }
}

/**
 * If the agent restarted after the 1:00 AM UTC cron window,
 * fire the briefing immediately on startup so it's never skipped.
 */
async function maybeRunMissedBriefing() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const lastSent = getLastBriefingDate();

  if (lastSent === todayUtc) return; // already sent today

  // Only fire if it's past the scheduled time (1:00 AM UTC)
  const nowUtc = new Date();
  const briefingHourUtc = 1;
  if (nowUtc.getUTCHours() < briefingHourUtc) return; // too early, cron will handle it

  log("cron", `Missed briefing detected (last sent: ${lastSent || "never"}) — sending now`);
  await runBriefing();
}

function stopCronJobs() {
  for (const task of _cronTasks) task.stop();
  if (_cronTasks._pnlPollInterval) clearInterval(_cronTasks._pnlPollInterval);
  if (_cronTasks._opportunityPollInterval) clearInterval(_cronTasks._opportunityPollInterval);
  _cronTasks = [];
}

/**
 * Execute the actions decided by the deterministic rules. CLOSE/CLAIM run directly
 * via executeTool (no LLM) — preserving all post-effects (notify, auto-swap,
 * recordPerformance, decision-log, HiveMind). Only INSTRUCTION positions, whose
 * free-text condition JS can't parse, are handed to the MANAGER LLM. Returns a
 * one-line-per-position result string.
 */
async function executeManagementActions(actionPositions, actionMap, { liveMessage = null, cur = "$" } = {}) {
  const lines = [];
  const instructionPositions = [];

  const mechanical = actionPositions.filter(p => actionMap.get(p.position).action !== "INSTRUCTION");
  if (mechanical.length) {
    log("cron", `Management: executing ${mechanical.length} mechanical action(s) — no LLM`);
  }

  for (const p of actionPositions) {
    const act = actionMap.get(p.position);
    if (act.action === "INSTRUCTION") { instructionPositions.push(p); continue; }

    if (act.action === "CLOSE") {
      const reason = act.reason || (act.rule ? `Rule ${act.rule}` : "rule close");
      await liveMessage?.toolStart("close_position");
      const res = await executeTool("close_position", { position_address: p.position, reason }).catch(e => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      await liveMessage?.toolFinish("close_position", res, ok);
      lines.push(`${p.pair}: ${ok ? `closed (${reason})` : `close FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    } else if (act.action === "CLAIM") {
      await liveMessage?.toolStart("claim_fees");
      const res = await executeTool("claim_fees", { position_address: p.position }).catch(e => ({ error: e.message }));
      const ok = res?.success !== false && !res?.error && !res?.blocked;
      await liveMessage?.toolFinish("claim_fees", res, ok);
      lines.push(`${p.pair}: ${ok ? "fees claimed" : `claim FAILED — ${res?.error || res?.reason || "unknown"}`}`);
    }
  }

  // INSTRUCTION positions need the LLM to evaluate the free-text condition.
  if (instructionPositions.length > 0) {
    log("cron", `Management: ${instructionPositions.length} instruction position(s) — invoking LLM [model: ${config.llm.managementModel}]`);
    const actionBlocks = instructionPositions.map((p) => [
      `POSITION: ${p.pair} (${p.position})`,
      `  pool: ${p.pool}`,
      `  pnl_pct: ${p.pnl_pct}% | unclaimed_fees: ${cur}${p.unclaimed_fees_usd} | value: ${cur}${p.total_value_usd} | fee_per_tvl_24h: ${p.fee_per_tvl_24h ?? "?"}%`,
      `  bins: lower=${p.lower_bin} upper=${p.upper_bin} active=${p.active_bin} | oor_minutes: ${p.minutes_out_of_range ?? 0}`,
      `  instruction: "${p.instruction}"`,
    ].join("\n")).join("\n\n");

    const { content } = await agentLoop(`
INSTRUCTION EVALUATION — ${instructionPositions.length} position(s)

${actionBlocks}

For each position, evaluate the instruction condition against the live data:
- If the condition is MET → call close_position (it claims fees internally; do NOT call claim_fees first).
- If NOT met → HOLD, do nothing.

After evaluating, write a brief one-line result per position.
    `, config.llm.maxSteps, [], "MANAGER", config.llm.managementModel, 2048, {
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    if (content) lines.push(content);
  }

  return lines.join("\n");
}

export async function runManagementCycle({ silent = false } = {}) {
  if (_managementBusy) return null;
  _managementBusy = true;
  timers.managementLastRun = Date.now();
  log("cron", "Starting management cycle");
  let mgmtReport = null;
  let positions = [];
  let liveMessage = null;
  const screeningCooldownMs = 5 * 60 * 1000;

  try {
    if (!silent && telegramEnabled()) {
      liveMessage = await createLiveMessage("🔄 Management Cycle", "Evaluating positions...");
    }
    const livePositions = await getMyPositions({ force: true }).catch(() => null);
    positions = livePositions?.positions || [];

    if (positions.length === 0) {
      log("cron", "No open positions — triggering screening cycle");
      mgmtReport = "No open positions. Triggering screening cycle.";
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
      return mgmtReport;
    }

    // Snapshot + load pool memory
    const positionData = positions.map((p) => {
      recordPositionSnapshot(p.pool, p);
      return { ...p, recall: recallForPool(p.pool) };
    });

    // JS exit checks. Management is the slow cron backstop: raise peak immediately
    // (confirmTicks=1) and act on detected exits directly. Real-time 2-tick
    // confirmation lives in the fast 3s poller below.
    const exitMap = new Map();
    for (const p of positionData) {
      confirmPeak(p.position, p.pnl_pct, 1);
      const exit = updatePnlAndCheckExits(p.position, p, config.management);
      if (exit) {
        exitMap.set(p.position, exit.reason);
        log("state", `Exit alert for ${p.pair}: ${exit.reason}`);
      }
    }

    // ── Deterministic rule checks (no LLM) ──────────────────────────
    // action: CLOSE | CLAIM | STAY | INSTRUCTION (needs LLM)
    const actionMap = new Map();
    for (const p of positionData) {
      // Hard exit — highest priority
      if (exitMap.has(p.position)) {
        actionMap.set(p.position, { action: "CLOSE", rule: "exit", reason: exitMap.get(p.position) });
        continue;
      }
      // Instruction-set — pass to LLM, can't parse in JS
      if (p.instruction) {
        actionMap.set(p.position, { action: "INSTRUCTION" });
        continue;
      }

      const closeRule = getDeterministicCloseRule(p, config.management);
      if (closeRule) {
        actionMap.set(p.position, closeRule);
        continue;
      }
      // Claim rule
      if ((p.unclaimed_fees_usd ?? 0) >= config.management.minClaimAmount) {
        actionMap.set(p.position, { action: "CLAIM" });
        continue;
      }
      actionMap.set(p.position, { action: "STAY" });
    }

    // ── Build JS report ──────────────────────────────────────────────
    const totalValue = positionData.reduce((s, p) => s + (p.total_value_usd ?? 0), 0);
    const totalUnclaimed = positionData.reduce((s, p) => s + (p.unclaimed_fees_usd ?? 0), 0);

    const reportLines = positionData.map((p) => {
      const act = actionMap.get(p.position);
      const inRange = p.in_range ? "🟢 IN" : `🔴 OOR ${p.minutes_out_of_range ?? 0}m`;
      const val = config.management.solMode ? `◎${p.total_value_usd ?? "?"}` : `$${p.total_value_usd ?? "?"}`;
      const unclaimed = config.management.solMode ? `◎${p.unclaimed_fees_usd ?? "?"}` : `$${p.unclaimed_fees_usd ?? "?"}`;
      const statusLabel = act.action === "INSTRUCTION" ? "HOLD (instruction)" : act.action;
      let line = `**${p.pair}** | Age: ${p.age_minutes ?? "?"}m | Val: ${val} | Unclaimed: ${unclaimed} | PnL: ${p.pnl_pct ?? "?"}% | Yield: ${p.fee_per_tvl_24h ?? "?"}% | ${inRange} | ${statusLabel}`;
      if (p.instruction) line += `\nNote: "${p.instruction}"`;
      if (act.action === "CLOSE" && act.rule === "exit") line += `\n⚡ Trailing TP: ${act.reason}`;
      if (act.action === "CLOSE" && act.rule && act.rule !== "exit") line += `\nRule ${act.rule}: ${act.reason}`;
      if (act.action === "CLAIM") line += `\n→ Claiming fees`;
      return line;
    });

    const needsAction = [...actionMap.values()].filter(a => a.action !== "STAY");
    const actionSummary = needsAction.length > 0
      ? needsAction.map(a => a.action === "INSTRUCTION" ? "EVAL instruction" : `${a.action}${a.reason ? ` (${a.reason})` : ""}`).join(", ")
      : "no action";

    const cur = config.management.solMode ? "◎" : "$";
    mgmtReport = reportLines.join("\n\n") +
      `\n\nSummary: 💼 ${positions.length} positions | ${cur}${totalValue.toFixed(4)} | fees: ${cur}${totalUnclaimed.toFixed(4)} | ${actionSummary}`;

    // ── Call LLM only if action needed ──────────────────────────────
    const actionPositions = positionData.filter(p => {
      const a = actionMap.get(p.position);
      return a.action !== "STAY";
    });

    if (actionPositions.length > 0) {
      const execReport = await executeManagementActions(actionPositions, actionMap, { liveMessage, cur });
      if (execReport) mgmtReport += `\n\n${execReport}`;
    } else {
      log("cron", "Management: all positions STAY — skipping");
      await liveMessage?.note("No tool actions needed.");
    }

    // ── Post-management: compound & copy-LP ────────────────
    try {
      const compoundReport = await runCompoundCycle();
      if (compoundReport?.results?.length > 0) {
        const compounded = compoundReport.results.filter(r => r.compounded).length;
        const claimed = compoundReport.results.filter(r => r.claimed && !r.compounded).length;
        log("compound", `Cycle done: ${compounded} compounded, ${claimed} claimed-only`);
        if (liveMessage) await liveMessage.note(`💰 Compound: ${compounded} done, ${claimed} claimed`);
      }
    } catch (e) {
      log("compound_error", `Compound cycle failed: ${e.message}`);
    }

    // Copy top LPers (less frequent — only if enabled and interval has passed)
    if (config.copyLp?.enabled) {
      const copyIntervalMs = (config.copyLp.copyIntervalMin ?? 60) * 60 * 1000;
      if (!_lastCopyLpRun || Date.now() - _lastCopyLpRun > copyIntervalMs) {
        runCopyLPCycle().then(report => {
          if (report?.deployed?.length > 0) {
            log("copylp", `Copied ${report.deployed.length} positions`);
            if (telegramEnabled()) {
              sendMessage(`📋 Copy LP: ${report.deployed.length} positions deployed`).catch(() => {});
            }
          }
          _lastCopyLpRun = Date.now();
        }).catch(e => log("copylp_error", `Copy LP cycle failed: ${e.message}`));
      }
    }

    // Trigger screening after management
    const afterPositions = await getMyPositions({ force: true }).catch(() => null);
    const afterCount = afterPositions?.positions?.length ?? 0;
    if (afterCount < config.risk.maxPositions && Date.now() - _screeningLastTriggered > screeningCooldownMs) {
      log("cron", `Post-management: ${afterCount}/${config.risk.maxPositions} positions — triggering screening`);
      runScreeningCycle().catch((e) => log("cron_error", `Triggered screening failed: ${e.message}`));
    }
  } catch (error) {
    log("cron_error", `Management cycle failed: ${error.message}`);
    mgmtReport = `Management cycle failed: ${error.message}`;
  } finally {
    _managementBusy = false;
    if (!silent && telegramEnabled()) {
      if (mgmtReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(mgmtReport)).catch(() => {});
        else sendMessage(`🔄 Management Cycle\n\n${stripThink(mgmtReport)}`).catch(() => { });
      }
      for (const p of positions) {
        if (!p.in_range && p.minutes_out_of_range >= config.management.outOfRangeWaitMinutes) {
          notifyOutOfRange({ pair: p.pair, minutesOOR: p.minutes_out_of_range }).catch(() => { });
        }
      }
    }
  }
  return mgmtReport;
}

export async function runScreeningCycle({ silent = false } = {}) {
  if (_screeningBusy) {
    log("cron", "Screening skipped — previous cycle still running");
    return null;
  }
  _screeningBusy = true; // set immediately — prevents TOCTOU race with concurrent callers
  _screeningLastTriggered = Date.now();

  // Hard guards — don't even run the agent if preconditions aren't met
  let prePositions, preBalance;
  let liveMessage = null;
  let screenReport = null;
  try {
    [prePositions, preBalance] = await Promise.all([getMyPositions({ force: true }), getWalletBalances()]);
    if (prePositions.total_positions >= config.risk.maxPositions) {
      log("cron", `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`);
      screenReport = `Screening skipped — max positions reached (${prePositions.total_positions}/${config.risk.maxPositions}).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Max positions reached (${prePositions.total_positions}/${config.risk.maxPositions})`,
      });
      _screeningBusy = false;
      return screenReport;
    }
    if (!config.strategy.deployEnabled) {
      log("cron", `Screening skipped — deploy is disabled (deployEnabled=false). Use /deployon to re-enable.`);
      screenReport = `Screening skipped — deploy is disabled. Use /deployon / /deployoff to toggle.`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: "deployEnabled=false",
      });
      _screeningBusy = false;
      return screenReport;
    }
    const minRequired = config.management.deployAmountSol + config.management.gasReserve;
    const isDryRun = process.env.DRY_RUN === "true";
    if (!isDryRun && preBalance.sol < minRequired) {
      log("cron", `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas)`);
      screenReport = `Screening skipped — insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired} needed for deploy + gas).`;
      appendDecision({
        type: "skip",
        actor: "SCREENER",
        summary: "Screening skipped",
        reason: `Insufficient SOL (${preBalance.sol.toFixed(3)} < ${minRequired})`,
      });
      _screeningBusy = false;
      return screenReport;
    }
  } catch (e) {
    log("cron_error", `Screening pre-check failed: ${e.message}`);
    screenReport = `Screening pre-check failed: ${e.message}`;
    _screeningBusy = false;
    return screenReport;
  }
  if (!silent && telegramEnabled()) {
    liveMessage = await createLiveMessage("🔍 Screening Cycle", "Scanning candidates...");
  }
  timers.screeningLastRun = Date.now();
  log("cron", `Starting screening cycle [model: ${config.llm.screeningModel}]`);

  // Multi-strategy portfolio rotation
  if (isPortfolioMode()) {
    const rotation = rotatePortfolio();
    if (rotation) {
      log("cron", `Portfolio rotated → ${rotation.name} (${rotation.deployType}) — cycle ${rotation.cycle}`);
      if (liveMessage) {
        await liveMessage.note(`🎯 ${rotation.name} (${rotation.deployType}) — cycle ${rotation.cycle}/${rotation.total}`);
      }
    }
  }

  try {
    // Reuse pre-fetched balance — no extra RPC call needed
    const currentBalance = preBalance;
    const deployAmount = computeDeployAmount(currentBalance.sol);
    log("cron", `Computed deploy amount: ${deployAmount} SOL (wallet: ${currentBalance.sol} SOL)`);

    // Load active strategy
    const activeStrategy = getActiveStrategy();
    const deployStrategy = config.strategy.strategy;
    const strategyBlock = `DEPLOY STRATEGY: ${deployStrategy} (from config) | bins_above: 0 (FIXED — never change) | deposit: SOL only (amount_y, amount_x=0)`
      + (activeStrategy ? `\nSTRATEGY CONTEXT: ${activeStrategy.name} — entry: ${activeStrategy.entry?.condition || "n/a"} | exit: ${activeStrategy.exit?.notes || "n/a"} | best for: ${activeStrategy.best_for}` : "");

    // Fetch top candidates, then recon each sequentially with a small delay to avoid 429s
    const topCandidates = await getTopCandidates({ limit: 10 }).catch(() => null);
    const candidates = (topCandidates?.candidates || topCandidates?.pools || []).slice(0, 10);
    const earlyFilteredExamples = topCandidates?.filtered_examples || [];

    const allCandidates = [];
    for (const pool of candidates) {
      const mint = pool.base?.mint;
      const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
        checkSmartWalletsOnPool({ pool_address: pool.pool }),
        mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
        mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
      ]);
      allCandidates.push({
        pool,
        sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
        n: narrative.status === "fulfilled" ? narrative.value : null,
        ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
        mem: recallForPool(pool.pool),
      });
      await new Promise(r => setTimeout(r, 150)); // avoid 429s
    }

    // Hard filters after token recon — block launchpads and excessive Jupiter bot holders
    const filteredOut = [];
    const passing = allCandidates.filter(({ pool, ti }) => {
      const launchpad = ti?.launchpad ?? null;
      if (launchpad && config.screening.allowedLaunchpads?.length > 0 && !config.screening.allowedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — launchpad ${launchpad} not in allow-list`);
        filteredOut.push({ name: pool.name, reason: `launchpad ${launchpad} not in allow-list` });
        return false;
      }
      if (launchpad && config.screening.blockedLaunchpads.includes(launchpad)) {
        log("screening", `Skipping ${pool.name} — blocked launchpad (${launchpad})`);
        filteredOut.push({ name: pool.name, reason: `blocked launchpad (${launchpad})` });
        return false;
      }
      const botPct = ti?.audit?.bot_holders_pct;
      const maxBotHoldersPct = config.screening.maxBotHoldersPct;
      if (botPct != null && maxBotHoldersPct != null && botPct > maxBotHoldersPct) {
        log("screening", `Bot-holder filter: dropped ${pool.name} — bots ${botPct}% > ${maxBotHoldersPct}%`);
        filteredOut.push({ name: pool.name, reason: `bot holders ${botPct}% > ${maxBotHoldersPct}%` });
        return false;
      }
      return true;
    });

    if (passing.length === 0) {
      const combined = filteredOut.length > 0 ? filteredOut : earlyFilteredExamples;
      const combinedExamples = combined.slice(0, 3)
        .map((entry) => `- ${entry.name}: ${entry.reason}`)
        .join("\n");
      screenReport = combinedExamples
        ? `No candidates available.\nFiltered examples:\n${combinedExamples}`
        : `No candidates available (all filtered by launchpad / holder-quality rules).`;
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "No candidates available",
        reason: combinedExamples || "All candidates filtered before deploy",
        rejected: combined.slice(0, 5).map((entry) => `${entry.name}: ${entry.reason}`),
      });
      return screenReport;
    }

    if (passing.length === 1) {
      const skipReason = getLoneCandidateSkipReason(passing[0]);
      if (skipReason) {
        const candidateName = passing[0].pool?.name || "unknown";
        screenReport = [
          "⛔ NO DEPLOY",
          "",
          "Cycle finished with no valid entry.",
          "",
          "BEST LOOKING CANDIDATE",
          candidateName,
          "",
          "WHY SKIPPED",
          `Only one candidate survived filtering, but it was not worth deploying: ${skipReason}.`,
          "",
          "REJECTED",
          `- ${candidateName}: ${skipReason}`,
        ].join("\n");
        appendDecision({
          type: "no_deploy",
          actor: "SCREENER",
          summary: "Single candidate skipped",
          reason: skipReason,
          pool: passing[0].pool?.pool,
          pool_name: candidateName,
        });
        return screenReport;
      }
    }

    // Pre-fetch active_bin for all passing candidates in parallel
    const activeBinResults = await Promise.allSettled(
      passing.map(({ pool }) => getActiveBin({ pool_address: pool.pool }))
    );

    // Build compact candidate blocks
    const candidateBlocks = passing.map(({ pool, sw, n, ti, mem }, i) => {
      const botPct = ti?.audit?.bot_holders_pct ?? "?";
      const top10Pct = ti?.audit?.top_holders_pct ?? "?";
      const feesSol = ti?.global_fees_sol ?? "?";
      const launchpad = ti?.launchpad ?? null;
      const priceChange = ti?.stats_1h?.price_change;
      const netBuyers = ti?.stats_1h?.net_buyers;
      const activeBin = activeBinResults[i]?.status === "fulfilled" ? activeBinResults[i].value?.binId : null;

      const pvpLine = pool.is_pvp
        ? `  pvp: HIGH — rival ${pool.pvp_rival_name || pool.pvp_symbol} (${pool.pvp_rival_mint?.slice(0, 8)}...) has pool ${pool.pvp_rival_pool?.slice(0, 8)}..., tvl=$${pool.pvp_rival_tvl}, holders=${pool.pvp_rival_holders}, fees=${pool.pvp_rival_fees}SOL`
        : null;

      const block = [
        `POOL: ${pool.name} (${pool.pool})`,
        `  metrics: bin_step=${pool.bin_step}, fee_pct=${pool.fee_pct}%, fee_tvl=${pool.fee_active_tvl_ratio}, vol=$${pool.volume_window}, tvl=$${pool.tvl ?? pool.active_tvl}, volatility_${pool.volatility_timeframe || "30m"}=${pool.volatility}, mcap=$${pool.mcap}, organic=${pool.organic_score}${pool.token_age_hours != null ? `, age=${pool.token_age_hours}h` : ""}`,
        `  audit: top10=${top10Pct}%, bots=${botPct}%, fees=${feesSol}SOL${launchpad ? `, launchpad=${launchpad}` : ""}`,
        pvpLine,
        `  smart_wallets: ${sw?.in_pool?.length ?? 0} present${sw?.in_pool?.length ? ` → CONFIDENCE BOOST (${sw.in_pool.map(w => w.name).join(", ")})` : ""}`,
        activeBin != null ? `  active_bin: ${activeBin}` : null,
        priceChange != null ? `  1h: price${priceChange >= 0 ? "+" : ""}${priceChange}%, net_buyers=${netBuyers ?? "?"}` : null,
        n?.narrative ? `  narrative_untrusted: ${sanitizeUntrustedPromptText(n.narrative, 500)}` : `  narrative_untrusted: none`,
        mem ? `  memory_untrusted: ${sanitizeUntrustedPromptText(mem, 500)}` : null,
      ].filter(Boolean).join("\n");

      // Stage signals for Darwinian weighting — captured before LLM decides
      if (config.darwin?.enabled) {
        const baseMint = pool.base?.mint || pool.base_mint || ti?.mint || null;
        stageSignals(pool.pool, {
          base_mint:             baseMint,
          organic_score:         pool.organic_score         ?? null,
          fee_tvl_ratio:         pool.fee_active_tvl_ratio  ?? null,
          volume:                pool.volume_window         ?? null,
          mcap:                  pool.mcap                  ?? null,
          holder_count:          ti?.holders                ?? null,
          smart_wallets_present: (sw?.in_pool?.length ?? 0) > 0,
          narrative_quality:     n?.narrative ? "present" : "absent",
          volatility:            pool.volatility            ?? null,
        });
      }

      return block;
    });

    const weightsSummary = config.darwin?.enabled ? getWeightsSummary() : null;

    let deployAttempted = false;
    let deploySucceeded = false;
    const { content } = await agentLoop(`
SCREENING CYCLE
${strategyBlock}
Positions: ${prePositions.total_positions}/${config.risk.maxPositions} | SOL: ${currentBalance.sol.toFixed(3)} | Deploy: ${deployAmount} SOL

PRE-LOADED CANDIDATES (${passing.length} pools):
${candidateBlocks.join("\n\n")}

STEPS:
1. Decide if any candidate is actually worth deploying. One surviving candidate is not automatically good enough.
2. Pick the best candidate based on narrative quality, smart wallets, and pool metrics.
3. Call deploy_position (active_bin is pre-fetched above — no need to call get_active_bin).
   bins_below = round(${config.strategy.minBinsBelow} + (candidate volatility/5)*(${config.strategy.maxBinsBelow - config.strategy.minBinsBelow})) clamped to [${config.strategy.minBinsBelow},${config.strategy.maxBinsBelow}].
   pass deploy_position.volatility = the candidate volatility value.
   For single-side SOL deploys, do not invent upside:
   set amount_y only, keep amount_x = 0, keep bins_above = 0, and let the upper bin stay at the active bin.
4. Report in this exact format (no tables, no extra sections):
   🚀 DEPLOYED

   <pool name>
   <pool address>

   ◎ <deploy amount> SOL | <strategy> | bin <active_bin>
   Range: <minPrice> → <maxPrice>
   Range cover: <downside %> downside | <upside %> upside | <total width %> total

   IMPORTANT:
   - Do NOT calculate the range percentages yourself.
   - Use the actual deploy_position tool result:
     range_coverage.downside_pct
     range_coverage.upside_pct
     range_coverage.width_pct

   MARKET
   Fee/TVL: <x>%
   Volume: $<x>
   TVL: $<x>
   Volatility: <x>
   Organic: <x>
   Mcap: $<x>
   Age: <x>h

   AUDIT
   Top10: <x>%
   Bots: <x>%
   Fees paid: <x> SOL
   Smart wallets: <names or none>

   WHY THIS WON
   <2-4 concise sentences on why this pool won, key risks, and why it still beat the alternatives>
5. If no pool qualifies, report in this exact format instead:
   ⛔ NO DEPLOY

   Cycle finished with no valid entry.

   BEST LOOKING CANDIDATE
   <name or none>

   WHY SKIPPED
   <2-4 concise sentences explaining why nothing was good enough>

   REJECTED
   <short flat list of top candidate names and why they were skipped>
IMPORTANT:
- Keep the whole report compact and highly scannable for Telegram.
      `, config.llm.maxSteps, [], "SCREENER", config.llm.screeningModel, 2048, {
        onToolStart: async ({ name }) => {
          if (name === "deploy_position") deployAttempted = true;
          await liveMessage?.toolStart(name);
        },
        onToolFinish: async ({ name, result, success }) => {
          if (name === "deploy_position") {
            deployAttempted = true;
            deploySucceeded = Boolean(success && result?.success !== false && !result?.error && !result?.blocked);
          }
          await liveMessage?.toolFinish(name, result, success);
        },
      });
    screenReport = content;
    if (/⛔\s*NO DEPLOY/i.test(content)) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "LLM chose no deploy",
        reason: stripThink(content).slice(0, 500),
      });
    } else if (!deploySucceeded) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: deployAttempted ? "Deploy attempt did not succeed" : "No successful deploy in screening cycle",
        reason: stripThink(content).slice(0, 500),
      });
    }
  } catch (error) {
    log("cron_error", `Screening cycle failed: ${error.message}`);
    screenReport = `Screening cycle failed: ${error.message}`;
  } finally {
    _screeningBusy = false;
    if (!silent && telegramEnabled()) {
      if (screenReport) {
        if (liveMessage) await liveMessage.finalize(stripThink(screenReport)).catch(() => {});
        else sendMessage(`🔍 Screening Cycle\n\n${stripThink(screenReport)}`).catch(() => { });
      }
    }
  }
  return screenReport;
}

export function startCronJobs() {
  stopCronJobs(); // stop any running tasks before (re)starting

  const mgmtTask = cron.schedule(`*/${Math.max(1, config.schedule.managementIntervalMin)} * * * *`, async () => {
    if (_managementBusy) return;
    timers.managementLastRun = Date.now();
    await runManagementCycle();
  });

  const screenTask = cron.schedule(`*/${Math.max(1, config.schedule.screeningIntervalMin)} * * * *`, runScreeningCycle);

  const healthTask = cron.schedule(`0 * * * *`, async () => {
    if (_managementBusy) return;
    _managementBusy = true;
    log("cron", "Starting health check");
    try {
      await agentLoop(`
HEALTH CHECK

Summarize the current portfolio health, total fees earned, and performance of all open positions. Recommend any high-level adjustments if needed.
      `, config.llm.maxSteps, [], "MANAGER");
    } catch (error) {
      log("cron_error", `Health check failed: ${error.message}`);
    } finally {
      _managementBusy = false;
    }
  });

  // Morning Briefing at 8:00 AM UTC+7 (1:00 AM UTC)
  const briefingTask = cron.schedule(`0 1 * * *`, async () => {
    await runBriefing();
  }, { timezone: 'UTC' });

  // Every 6h — catch up if briefing was missed (agent restart, crash, etc.)
  const briefingWatchdog = cron.schedule(`0 */6 * * *`, async () => {
    await maybeRunMissedBriefing();
  }, { timezone: 'UTC' });

  // Fast PnL poller — the real-time exit path between management cycles, no LLM.
  // Runs on public infra (RPC + Jupiter + Meteora deposits) so it can poll aggressively.
  // Exits require `confirmTicks` consecutive confirming polls (registerExitSignal) so a
  // single noisy tick can't close a position; confirmed exits close DIRECTLY here (no
  // management-interval cooldown gate that used to swallow rule hits).
  const pnlPollMs = Math.max(1, Number(config.pnl.pollIntervalSec ?? 3)) * 1000;
  const confirmTicks = Math.max(1, Number(config.pnl.confirmTicks ?? 2));
  let _pnlPollBusy = false;
  const pnlPollInterval = setInterval(async () => {
    if (_managementBusy || _screeningBusy || _pnlPollBusy) return;
    if (getTrackedPositions(true).length === 0) return;
    _pnlPollBusy = true;
    try {
      const result = await getMyPositions({ force: true, silent: true }).catch(() => null);
      if (!result?.positions?.length) return;
      for (const p of result.positions) {
        confirmPeak(p.position, p.pnl_pct, confirmTicks);

        // Detect an exit signal this tick (rule-based exits, then deterministic close rules).
        const exit = updatePnlAndCheckExits(p.position, p, config.management);
        const closeRule = exit ? null : getDeterministicCloseRule(p, config.management);
        let signal = null, reason = null, rule = "exit";
        if (exit) { signal = exit.action; reason = exit.reason; }
        else if (closeRule) { signal = `RULE_${closeRule.rule}`; reason = closeRule.reason; rule = closeRule.rule; }

        // Require N consecutive confirming ticks before acting.
        const { fire } = registerExitSignal(p.position, signal, confirmTicks);
        if (!signal || !fire) continue;

        log("state", `[PnL poll] ${signal} confirmed (${confirmTicks} ticks): ${p.pair} — ${reason} — closing directly`);
        // Hold the management lock so the cron cycle can't double-act on this position.
        _managementBusy = true;
        try {
          const actMap = new Map([[p.position, { action: "CLOSE", rule, reason }]]);
          const rpt = await executeManagementActions([p], actMap, {});
          log("state", `[PnL poll] ${p.pair}: ${rpt || "closed"}`);
        } catch (e) {
          log("cron_error", `Poll-triggered close failed: ${e.message}`);
        } finally {
          _managementBusy = false;
        }
        break; // one action per tick
      }
    } finally {
      _pnlPollBusy = false;
    }
  }, pnlPollMs);

  // Opportunity poller — catches strong pools between the (slow) screening cycles.
  // Reuses the getTopCandidates pipeline (discovery + holder audit + filters + score);
  // when the best candidate clears the score pre-gate it triggers the existing screening
  // deploy decision (runScreeningCycle), which re-checks guards and forces the deploy LLM.
  let opportunityPollInterval = null;
  if (config.opportunity.enabled) {
    const oppMs = Math.max(15, Number(config.opportunity.pollIntervalSec ?? 45)) * 1000;
    const oppCooldownMs = 5 * 60 * 1000; // don't re-trigger the deploy LLM more than every 5m
    let _opportunityPollBusy = false;
    opportunityPollInterval = setInterval(async () => {
      if (_screeningBusy || _managementBusy || _opportunityPollBusy) return;
      if (Date.now() - _screeningLastTriggered < oppCooldownMs) return;
      _opportunityPollBusy = true;
      try {
        const [positions, balance] = await Promise.all([
          getMyPositions({ force: true, silent: true }).catch(() => null),
          getWalletBalances().catch(() => null),
        ]);
        if (!positions || (positions.total_positions ?? 0) >= config.risk.maxPositions) return;
        const minRequired = config.management.deployAmountSol + config.management.gasReserve;
        if (process.env.DRY_RUN !== "true" && (!balance || balance.sol < minRequired)) return;

        const top = await getTopCandidates({ limit: config.opportunity.limit }).catch(() => null);
        const candidates = (top?.candidates || []).slice().sort((a, b) => degenScore(b, config.opportunity) - degenScore(a, config.opportunity));
        if (!candidates.length) return;

        const minScore = config.opportunity.minScore;
        const bonus = Number(config.opportunity.smartWalletScoreBonus ?? 0);
        const floor = minScore - bonus; // lowest degen that could qualify, only WITH a smart wallet

        // A pool qualifies if degen >= minScore, OR it's borderline (floor..minScore) AND a
        // tracked smart wallet sits on it (checkSmartWalletsOnPool, on-chain positions of our
        // tracked KOL list). The smart-wallet lookup runs only for borderline pools to keep
        // the 45s poll cheap.
        let trigger = null;
        for (const c of candidates) {
          const s = degenScore(c, config.opportunity);
          if (s < floor) break; // sorted desc — nothing below can qualify either
          if (s >= minScore) { trigger = { c, s, smart: [] }; break; }
          if (bonus <= 0) continue; // borderline but smart-wallet rescue disabled
          const smart = (await checkSmartWalletsOnPool({ pool_address: c.pool }).catch(() => null))?.in_pool || [];
          if (smart.length > 0) { trigger = { c, s, smart }; break; }
        }
        if (!trigger) return;

        const smartTag = trigger.smart.length
          ? ` + smart wallet [${trigger.smart.map((w) => w.name || w.address?.slice(0, 4)).join(", ")}] (bar lowered ${minScore}→${floor})`
          : "";
        log("cron", `[Opportunity] ${trigger.c.name} degen ${trigger.s.toFixed(1)} >= ${trigger.smart.length ? floor : minScore}${smartTag} — triggering screening deploy decision`);
        runScreeningCycle({ silent: true }).catch((e) => log("cron_error", `Opportunity-triggered screening failed: ${e.message}`));
      } catch (e) {
        log("cron_error", `Opportunity poll failed: ${e.message}`);
      } finally {
        _opportunityPollBusy = false;
      }
    }, oppMs);
  }

  _cronTasks = [mgmtTask, screenTask, healthTask, briefingTask, briefingWatchdog];
  // Store interval refs so stopCronJobs can clear them
  _cronTasks._pnlPollInterval = pnlPollInterval;
  _cronTasks._opportunityPollInterval = opportunityPollInterval;
  log("cron", `Cycles started — management every ${config.schedule.managementIntervalMin}m, screening every ${config.schedule.screeningIntervalMin}m${config.opportunity.enabled ? `, opportunity poll every ${config.opportunity.pollIntervalSec}s` : ""}`);
}

// ═══════════════════════════════════════════
//  GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════
let _shuttingDown = false;

function withTimeout(promise, ms) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function shutdown(signal) {
  if (_shuttingDown) {
    log("shutdown", `Received ${signal} while shutdown is already in progress.`);
    return;
  }
  _shuttingDown = true;

  log("shutdown", `Received ${signal}. Shutting down...`);
  stopPolling();
  stopCronJobs();
  stopPumpSniper();
  stopDashboard();

  const positions = await withTimeout(
    getMyPositions({ force: true, silent: true }).catch((error) => {
      log("shutdown", `Position snapshot failed during shutdown: ${error.message}`);
      return null;
    }),
    5000
  );
  if (positions) {
    log("shutdown", `Open positions at shutdown: ${positions.total_positions}`);
  } else {
    log("shutdown", "Open position snapshot skipped during shutdown timeout");
  }
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// ═══════════════════════════════════════════
//  FORMAT CANDIDATES TABLE
// ═══════════════════════════════════════════
function formatCandidates(candidates) {
  if (!candidates.length) return "  No eligible pools found right now.";

  const lines = candidates.map((p, i) => {
    const name = (p.name || "unknown").padEnd(20);
    const ftvl = `${p.fee_active_tvl_ratio ?? p.fee_tvl_ratio}%`.padStart(8);
    const vol = `$${((p.volume_window || 0) / 1000).toFixed(1)}k`.padStart(8);
    const active = `${p.active_pct}%`.padStart(6);
    const org = String(p.organic_score).padStart(4);
    return `  [${i + 1}]  ${name}  fee/aTVL:${ftvl}  vol:${vol}  in-range:${active}  organic:${org}`;
  });

  return [
    "  #   pool                  fee/aTVL     vol    in-range  organic",
    "  " + "─".repeat(68),
    ...lines,
  ].join("\n");
}

function getDeterministicCloseRule(position, managementConfig) {
  const tracked = getTrackedPosition(position.position);
  const pnlSuspect = (() => {
    // Couldn't-price-this-tick flag (e.g. Jupiter outage) — never act on PnL rules.
    if (position.pnl_pct_suspicious) return true;
    if (position.pnl_pct == null) return false;
    if (position.pnl_pct > -90) return false;
    if (tracked?.amount_sol && (position.total_value_usd ?? 0) > 0.01) {
      log("cron_warn", `Suspect PnL for ${position.pair}: ${position.pnl_pct}% but position still has value — skipping PnL rules`);
      return true;
    }
    return false;
  })();

  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct <= managementConfig.stopLossPct) {
    return { action: "CLOSE", rule: 1, reason: "stop loss" };
  }
  if (!pnlSuspect && position.pnl_pct != null && position.pnl_pct >= managementConfig.takeProfitPct) {
    return { action: "CLOSE", rule: 2, reason: "take profit" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin + managementConfig.outOfRangeBinsToClose
  ) {
    return { action: "CLOSE", rule: 3, reason: "pumped far above range" };
  }
  if (
    position.active_bin != null &&
    position.upper_bin != null &&
    position.active_bin > position.upper_bin &&
    (position.minutes_out_of_range ?? 0) >= managementConfig.outOfRangeWaitMinutes
  ) {
    return { action: "CLOSE", rule: 4, reason: "OOR" };
  }
  if (
    position.fee_per_tvl_24h != null &&
    position.fee_per_tvl_24h < managementConfig.minFeePerTvl24h &&
    (position.age_minutes ?? 0) >= 60
  ) {
    return { action: "CLOSE", rule: 5, reason: "low yield" };
  }
  return null;
}

// ═══════════════════════════════════════════
//  INTERACTIVE REPL
// ═══════════════════════════════════════════
const isTTY = process.stdin.isTTY;
let cronStarted = false;
let busy = false;
const _telegramQueue = []; // queued messages received while agent was busy
const sessionHistory = []; // persists conversation across REPL turns
const MAX_HISTORY = 20;    // keep last 20 messages (10 exchanges)
let _ttyInterface = null;
let _latestCandidates = [];
let _latestCandidatesAt = null;

function setLatestCandidates(candidates = []) {
  _latestCandidates = Array.isArray(candidates) ? candidates : [];
  _latestCandidatesAt = new Date().toISOString();
}

function getLatestCandidatesMeta() {
  return {
    candidates: _latestCandidates,
    count: _latestCandidates.length,
    updatedAt: _latestCandidatesAt,
  };
}

function describeLatestCandidates(limit = 5) {
  if (!_latestCandidates.length) return "📭 <b>No cached candidates yet.</b>\n\n<i>Run</i> <code>/screen</code> <i>first.</i>";
  const lines = _latestCandidates.slice(0, limit).map((pool, i) => {
    const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
    const vol = pool.volume_window ?? pool.volume_24h ?? "?";
    const active = pool.active_pct ?? "?";
    const organic = pool.organic_score ?? "?";
    return [
      `🔹 <b>${i + 1}. ${escHtml(pool.name)}</b>`,
      `   💸 fee/aTVL: <code>${escHtml(feeTvl)}%</code>  |  📊 vol: <code>${fmtUsd(vol)}</code>`,
      `   🎯 in-range: <code>${escHtml(active)}%</code>  |  🌱 organic: <code>${escHtml(organic)}</code>`,
    ].join("\n");
  });
  const age = _latestCandidatesAt ? new Date(_latestCandidatesAt).toLocaleString("en-US", { hour12: false }) : "unknown";
  return `🗂️ <b>CACHED CANDIDATES</b>  <i>(${_latestCandidates.length})</i>\n${DOUBLE_SEP}\n${lines.join("\n\n")}\n${SEP}\n🕐 <i>Updated ${escHtml(age)}</i>  ·  <code>/deploy &lt;n&gt;</code>`;
}

function formatWalletStatus(wallet, positions) {
  const deployAmount = computeDeployAmount(wallet.sol);
  const hive = isHiveMindEnabled();
  const dry = process.env.DRY_RUN === "true";
  const maxPos = config.risk.maxPositions;
  const openPos = positions.total_positions ?? 0;
  const slotBar = progressBar((openPos / Math.max(1, maxPos)) * 100, 8);
  const autoDeploy = config.strategy.deployEnabled;
  return [
    `👛 <b>WALLET STATUS</b>`,
    DOUBLE_SEP,
    `💎 Balance:  <b>${escHtml(wallet.sol)} SOL</b>  <i>(${fmtUsd(wallet.sol_usd)})</i>`,
    `📈 SOL price:  <code>${fmtUsd(wallet.sol_price)}</code>`,
    `🎯 Next deploy:  <code>${escHtml(deployAmount)} SOL</code>`,
    SEP,
    `📊 Positions:  <b>${openPos}/${maxPos}</b>  <code>${slotBar}</code>`,
    `${dry ? "🧪" : "🔴"} Mode:  <b>${dry ? "DRY RUN" : "LIVE"}</b>`,
    `${autoDeploy ? "▶️" : "⏸"} Auto-deploy:  <b>${autoDeploy ? "ON" : "OFF"}</b>`,
    `${hive ? "🧠" : "💤"} HiveMind:  <b>${hive ? "connected" : "off"}</b>`,
  ].join("\n");
}

function formatConfigSnapshot() {
  const m = config.management;
  const s = config.strategy;
  const scr = config.screening;
  const sch = config.schedule;
  return [
    `⚙️ <b>CONFIG SNAPSHOT</b>`,
    DOUBLE_SEP,
    `🎯 <b>Strategy</b>`,
    `   Type: <code>${escHtml(s.strategy)}</code>  |  Auto-deploy: <b>${s.deployEnabled ? "ON" : "OFF"}</b>`,
    `   binsBelow: <code>${s.minBinsBelow}–${s.maxBinsBelow}</code>  (default <code>${s.defaultBinsBelow}</code>)`,
    ``,
    `💰 <b>Deploy &amp; Risk</b>`,
    `   Amount: <code>${m.deployAmountSol} SOL</code>  |  gasReserve: <code>${m.gasReserve}</code>`,
    `   Max positions: <code>${config.risk.maxPositions}</code>`,
    ``,
    `🚪 <b>Exits</b>`,
    `   TP: <code>${m.takeProfitPct}%</code>  |  SL: <code>${m.stopLossPct}%</code>`,
    `   Trailing: <b>${m.trailingTakeProfit ? "on" : "off"}</b>  (trigger <code>${m.trailingTriggerPct}%</code> / drop <code>${m.trailingDropPct}%</code>)`,
    ``,
    `⏱️ <b>Timing</b>`,
    `   OOR wait: <code>${m.outOfRangeWaitMinutes}m</code>  |  cooldown <code>${m.oorCooldownTriggerCount}×</code> / <code>${m.oorCooldownHours}h</code>`,
    `   Redeploy cd: <b>${m.repeatDeployCooldownEnabled ? "on" : "off"}</b>  <code>${m.repeatDeployCooldownTriggerCount}×</code> / <code>${m.repeatDeployCooldownHours}h</code>`,
    `   Yield floor: <code>${m.minFeePerTvl24h}%</code>  |  min age <code>${m.minAgeBeforeYieldCheck}m</code>`,
    ``,
    `🔍 <b>Screening</b>`,
    `   ${escHtml(scr.category)} / ${escHtml(scr.timeframe)}  |  TVL <code>${scr.minTvl}–${scr.maxTvl}</code>`,
    `   Intervals: manage <code>${sch.managementIntervalMin}m</code> · screen <code>${sch.screeningIntervalMin}m</code>`,
    SEP,
    `🧠 HiveMind: <b>${isHiveMindEnabled() ? "enabled" : "disabled"}</b>${config.hiveMind.agentId ? `  <code>${escHtml(config.hiveMind.agentId)}</code>` : ""}`,
  ].join("\n");
}

function parseConfigValue(raw) {
  const value = String(raw ?? "").trim();
  if (!value.length) return "";
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  if (/^null$/i.test(value)) return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith("[") && value.endsWith("]")) || (value.startsWith("{") && value.endsWith("}"))) {
    return JSON.parse(value);
  }
  return value;
}

function settingValue(key) {
  const values = {
    solMode: config.management.solMode,
    lpAgentRelayEnabled: config.api.lpAgentRelayEnabled,
    chartIndicatorsEnabled: config.indicators.enabled,
    trailingTakeProfit: config.management.trailingTakeProfit,
    useDiscordSignals: config.screening.useDiscordSignals,
    blockPvpSymbols: config.screening.blockPvpSymbols,
    strategy: config.strategy.strategy,
    minBinsBelow: config.strategy.minBinsBelow,
    maxBinsBelow: config.strategy.maxBinsBelow,
    defaultBinsBelow: config.strategy.defaultBinsBelow,
    deployEnabled: config.strategy.deployEnabled,
    deployAmountSol: config.management.deployAmountSol,
    gasReserve: config.management.gasReserve,
    maxPositions: config.risk.maxPositions,
    maxDeployAmount: config.risk.maxDeployAmount,
    takeProfitPct: config.management.takeProfitPct,
    stopLossPct: config.management.stopLossPct,
    trailingTriggerPct: config.management.trailingTriggerPct,
    trailingDropPct: config.management.trailingDropPct,
    repeatDeployCooldownEnabled: config.management.repeatDeployCooldownEnabled,
    repeatDeployCooldownTriggerCount: config.management.repeatDeployCooldownTriggerCount,
    repeatDeployCooldownHours: config.management.repeatDeployCooldownHours,
    repeatDeployCooldownMinFeeEarnedPct: config.management.repeatDeployCooldownMinFeeEarnedPct,
    managementIntervalMin: config.schedule.managementIntervalMin,
    screeningIntervalMin: config.schedule.screeningIntervalMin,
    indicatorEntryPreset: config.indicators.entryPreset,
    indicatorExitPreset: config.indicators.exitPreset,
    rsiLength: config.indicators.rsiLength,
    indicatorIntervals: config.indicators.intervals,
    requireAllIntervals: config.indicators.requireAllIntervals,
  };
  return values[key];
}

function fmtSettingValue(value) {
  if (Array.isArray(value)) return value.join(",");
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function settingButton(label, data) {
  return { text: label, callback_data: data };
}

function toggleButton(key, label) {
  return settingButton(`${label}: ${fmtSettingValue(settingValue(key))}`, `cfg:toggle:${key}`);
}

function stepButtons(key, label, step, { digits = 2 } = {}) {
  const value = Number(settingValue(key));
  const shown = Number.isFinite(value) ? value.toFixed(digits).replace(/\.?0+$/, "") : "?";
  return [
    settingButton(`- ${label}`, `cfg:step:${key}:${-step}`),
    settingButton(`${label}: ${shown}`, `cfg:noop`),
    settingButton(`+ ${label}`, `cfg:step:${key}:${step}`),
  ];
}

function renderSettingsMenu(page = "main") {
  const title = page === "main" ? "Settings menu" : `Settings: ${page}`;
  const summary = [
    title,
    "",
    `Mode: ${config.management.solMode ? "SOL" : "USD"} | Relay: ${config.api.lpAgentRelayEnabled ? "on" : "off"}`,
    `Strategy: ${config.strategy.strategy} | bins ${config.strategy.minBinsBelow}-${config.strategy.maxBinsBelow} | deploy ${config.management.deployAmountSol} SOL`,
    `TP/SL: ${config.management.takeProfitPct}% / ${config.management.stopLossPct}% | trailing ${config.management.trailingTakeProfit ? "on" : "off"}`,
    `Indicators: ${config.indicators.enabled ? "on" : "off"} | entry ${config.indicators.entryPreset} | ${fmtSettingValue(config.indicators.intervals)}`,
  ].join("\n");

  const nav = [
    [
      settingButton("Main", "cfg:page:main"),
      settingButton("Risk", "cfg:page:risk"),
      settingButton("Screen", "cfg:page:screen"),
      settingButton("Indicators", "cfg:page:indicators"),
    ],
  ];

  const footer = [
    [
      settingButton("Refresh", `cfg:page:${page}`),
      settingButton("Close", "cfg:close"),
    ],
  ];

  let rows;
  if (page === "risk") {
    rows = [
      stepButtons("deployAmountSol", "Deploy", 0.1),
      stepButtons("gasReserve", "Gas", 0.05),
      stepButtons("maxPositions", "Max pos", 1, { digits: 0 }),
      stepButtons("maxDeployAmount", "Max SOL", 1, { digits: 0 }),
      stepButtons("takeProfitPct", "TP %", 1, { digits: 0 }),
      stepButtons("stopLossPct", "SL %", 5, { digits: 0 }),
      [toggleButton("trailingTakeProfit", "Trailing TP")],
      stepButtons("trailingTriggerPct", "Trail trigger", 0.5, { digits: 1 }),
      stepButtons("trailingDropPct", "Trail drop", 0.5, { digits: 1 }),
      [toggleButton("repeatDeployCooldownEnabled", "Repeat cooldown")],
      stepButtons("repeatDeployCooldownTriggerCount", "Repeat count", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownHours", "Repeat hrs", 1, { digits: 0 }),
      stepButtons("repeatDeployCooldownMinFeeEarnedPct", "Fee earned %", 0.1, { digits: 1 }),
    ];
  } else if (page === "screen") {
    rows = [
      [toggleButton("useDiscordSignals", "Discord signals"), toggleButton("blockPvpSymbols", "PVP hard block")],
      [
        settingButton(`Strategy: spot`, "cfg:set:strategy:spot"),
        settingButton(`Strategy: bid_ask`, "cfg:set:strategy:bid_ask"),
      ],
      [toggleButton("deployEnabled", "Auto-deploy")],
      stepButtons("minBinsBelow", "Min bins", 1, { digits: 0 }),
      stepButtons("maxBinsBelow", "Max bins", 1, { digits: 0 }),
      stepButtons("defaultBinsBelow", "Default bins", 1, { digits: 0 }),
      stepButtons("managementIntervalMin", "Manage min", 1, { digits: 0 }),
      stepButtons("screeningIntervalMin", "Screen min", 5, { digits: 0 }),
    ];
  } else if (page === "indicators") {
    rows = [
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("requireAllIntervals", "Require all TF")],
      [
        settingButton("TF: 5m", "cfg:set:indicatorIntervals:5_MINUTE"),
        settingButton("TF: 15m", "cfg:set:indicatorIntervals:15_MINUTE"),
        settingButton("TF: both", "cfg:set:indicatorIntervals:both"),
      ],
      [
        settingButton("Entry: ST", "cfg:set:indicatorEntryPreset:supertrend_break"),
        settingButton("Entry: RSI", "cfg:set:indicatorEntryPreset:rsi_reversal"),
        settingButton("Entry: ST/RSI", "cfg:set:indicatorEntryPreset:supertrend_or_rsi"),
      ],
      [
        settingButton("Exit: ST", "cfg:set:indicatorExitPreset:supertrend_break"),
        settingButton("Exit: RSI", "cfg:set:indicatorExitPreset:rsi_reversal"),
        settingButton("Exit: BB+RSI", "cfg:set:indicatorExitPreset:bb_plus_rsi"),
      ],
      stepButtons("rsiLength", "RSI len", 1, { digits: 0 }),
    ];
  } else {
    rows = [
      [toggleButton("solMode", "SOL mode"), toggleButton("lpAgentRelayEnabled", "LPAgent relay")],
      [toggleButton("chartIndicatorsEnabled", "Chart indicators"), toggleButton("trailingTakeProfit", "Trailing TP")],
      [
        settingButton("Risk / deploy", "cfg:page:risk"),
        settingButton("Screening", "cfg:page:screen"),
      ],
      [
        settingButton("Indicators", "cfg:page:indicators"),
        settingButton("Show config", "cfg:show"),
      ],
    ];
  }

  return { text: summary, keyboard: [...nav, ...rows, ...footer] };
}

async function showSettingsMenu({ messageId = null, page = "main" } = {}) {
  const menu = renderSettingsMenu(page);
  if (messageId) {
    await editMessageWithButtons(menu.text, messageId, menu.keyboard);
  } else {
    await sendMessageWithButtons(menu.text, menu.keyboard);
  }
}

function normalizeMenuValue(key, raw) {
  if (key === "indicatorIntervals") {
    if (raw === "both") return ["5_MINUTE", "15_MINUTE"];
    return [raw];
  }
  return parseConfigValue(raw);
}

async function applySettingsMenuCallback(msg) {
  const data = msg.callbackData || msg.text || "";
  const parts = data.split(":");
  const action = parts[1];
  let page = "main";

  if (action === "noop") {
    await answerCallbackQuery(msg.callbackQueryId);
    return;
  }
  if (action === "close") {
    await answerCallbackQuery(msg.callbackQueryId, "Closed");
    await editMessage("Settings menu closed.", msg.messageId);
    return;
  }
  if (action === "show") {
    await answerCallbackQuery(msg.callbackQueryId);
    await editMessageWithButtons(formatConfigSnapshot(), msg.messageId, [[settingButton("Back", "cfg:page:main")]]);
    return;
  }
  if (action === "page") {
    page = parts[2] || "main";
    await answerCallbackQuery(msg.callbackQueryId);
    await showSettingsMenu({ messageId: msg.messageId, page });
    return;
  }

  const key = parts[2];
  let value;
  if (action === "toggle") {
    value = !Boolean(settingValue(key));
  } else if (action === "step") {
    const current = Number(settingValue(key));
    const delta = Number(parts[3]);
    if (!Number.isFinite(current) || !Number.isFinite(delta)) {
      await answerCallbackQuery(msg.callbackQueryId, "Invalid setting");
      return;
    }
    value = Number((current + delta).toFixed(4));
    if (key === "maxPositions") value = Math.max(1, Math.round(value));
    if (key === "rsiLength") value = Math.max(2, Math.round(value));
    if (key === "repeatDeployCooldownTriggerCount") value = Math.max(1, Math.round(value));
    if (key === "repeatDeployCooldownHours") value = Math.max(0, Math.round(value));
    if (key === "repeatDeployCooldownMinFeeEarnedPct") value = Math.max(0, value);
    if (["minBinsBelow", "maxBinsBelow", "defaultBinsBelow"].includes(key)) value = Math.max(35, Math.round(value));
    if (["deployAmountSol", "gasReserve", "maxDeployAmount"].includes(key)) value = Math.max(0, value);
  } else if (action === "set") {
    value = normalizeMenuValue(key, parts.slice(3).join(":"));
  } else {
    await answerCallbackQuery(msg.callbackQueryId, "Unknown action");
    return;
  }

  const result = await executeTool("update_config", {
    changes: { [key]: value },
    reason: "Telegram settings menu",
  });
  if (!result?.success) {
    await answerCallbackQuery(msg.callbackQueryId, "Config update failed");
    return;
  }
  page = key.startsWith("indicator") || key === "chartIndicatorsEnabled" || key === "rsiLength" || key === "requireAllIntervals"
    ? "indicators"
    : ["useDiscordSignals", "blockPvpSymbols", "strategy", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow", "managementIntervalMin", "screeningIntervalMin"].includes(key)
      ? "screen"
      : "risk";
  await answerCallbackQuery(msg.callbackQueryId, `Updated ${key}`);
  await showSettingsMenu({ messageId: msg.messageId, page });
}

function formatHelpText() {
  const cmd = (c, desc) => `<code>${c}</code> — ${desc}`;
  return [
    `🤖 <b>MERIDIAN — COMMAND CENTER</b>`,
    DOUBLE_SEP,
    ``,
    `📊 <b>Monitoring</b>`,
    cmd("/status", "wallet + positions snapshot"),
    cmd("/wallet", "balance, deploy amount, HiveMind"),
    cmd("/positions", "list open positions"),
    cmd("/pool &lt;n&gt;", "detailed info for one position"),
    cmd("/portfolio", "multi-strategy portfolio status"),
    cmd("/briefing", "morning performance briefing"),
    ``,
    `💧 <b>Positions</b>`,
    cmd("/close &lt;n&gt;", "close one position by index"),
    cmd("/closeall", "close all open positions"),
    cmd("/set &lt;n&gt; &lt;note&gt;", "set instruction on position"),
    cmd("/compound", "trigger fee compounding now"),
    ``,
    `🔍 <b>Screening &amp; Deploy</b>`,
    cmd("/screen", "refresh candidate list"),
    cmd("/candidates", "show cached candidates"),
    cmd("/deploy &lt;n&gt;", "deploy candidate by index"),
    ``,
    `🎯 <b>Strategy</b>`,
    cmd("/strategy", "list all LP strategies"),
    cmd("/strategy set &lt;id&gt;", "switch active strategy"),
    cmd("/strategy get &lt;id&gt;", "show strategy details"),
    ``,
    `⚙️ <b>Config</b>`,
    cmd("/config", "runtime config snapshot"),
    cmd("/settings", "button menu for config"),
    cmd("/setcfg &lt;key&gt; &lt;val&gt;", "update persisted config"),
    ``,
    `🚀 <b>Automation</b>`,
    cmd("/copylp", "copy-LP status  ·  /copylp scan"),
    cmd("/pump", "pump.fun sniper  ·  /pump scan"),
    cmd("/hive", "HiveMind status  ·  /hive pull"),
    cmd("/dashboard", "web dashboard URL"),
    ``,
    `🎛️ <b>Control</b>`,
    cmd("/pause", "stop cron cycles"),
    cmd("/resume", "resume cron cycles"),
    cmd("/deployoff", "stop auto-deploy (bot stays on)"),
    cmd("/deployon", "re-enable auto-deploy"),
    cmd("/stop", "shut down agent"),
    SEP,
    `💬 <i>Or just chat — ask me to deploy, close, or analyze.</i>`,
  ].join("\n");
}

async function runDeterministicScreen(limit = 5) {
  const top = await getTopCandidates({ limit });
  const candidates = (top?.candidates || top?.pools || []).slice(0, limit);
  setLatestCandidates(candidates);
  if (candidates.length > 0) {
    const lines = candidates.map((pool, i) => {
      const feeTvl = pool.fee_active_tvl_ratio ?? pool.fee_tvl_ratio ?? "?";
      const vol = pool.volume_window ?? pool.volume_24h ?? "?";
      return [
        `🔹 <b>${i + 1}. ${escHtml(pool.name)}</b>`,
        `   💸 fee/aTVL: <code>${escHtml(feeTvl)}%</code>  |  📊 vol: <code>${fmtUsd(vol)}</code>  |  🌱 organic: <code>${escHtml(pool.organic_score ?? "?")}</code>`,
        `   🏊 <code>${escHtml(pool.pool)}</code>`,
      ].join("\n");
    });
    return `🔍 <b>TOP CANDIDATES</b>  <i>(${candidates.length})</i>\n${DOUBLE_SEP}\n${lines.join("\n\n")}\n${SEP}\n<i>Deploy with</i> <code>/deploy &lt;n&gt;</code>`;
  }
  const examples = (top?.filtered_examples || []).slice(0, 3)
    .map((entry) => `• <b>${escHtml(entry.name)}</b>: <i>${escHtml(entry.reason)}</i>`)
    .join("\n");
  return examples
    ? `📭 <b>No candidates available.</b>\n${SEP}\n<b>Filtered examples:</b>\n${examples}`
    : "📭 <b>No candidates available right now.</b>";
}

async function deployLatestCandidate(index) {
  const candidate = _latestCandidates[index];
  if (!candidate) {
    throw new Error("Invalid candidate index. Run /screen first.");
  }
  if (_latestCandidates.length === 1) {
    const mint = candidate.base?.mint || candidate.base_mint || null;
    const [smartWallets, narrative, tokenInfo] = await Promise.allSettled([
      checkSmartWalletsOnPool({ pool_address: candidate.pool }),
      mint ? getTokenNarrative({ mint }) : Promise.resolve(null),
      mint ? getTokenInfo({ query: mint }) : Promise.resolve(null),
    ]);
    const context = {
      pool: candidate,
      sw: smartWallets.status === "fulfilled" ? smartWallets.value : null,
      n: narrative.status === "fulfilled" ? narrative.value : null,
      ti: tokenInfo.status === "fulfilled" ? tokenInfo.value?.results?.[0] : null,
    };
    const skipReason = getLoneCandidateSkipReason(context);
    if (skipReason) {
      appendDecision({
        type: "no_deploy",
        actor: "SCREENER",
        summary: "Single cached candidate skipped",
        reason: skipReason,
        pool: candidate.pool,
        pool_name: candidate.name,
      });
      throw new Error(`NO DEPLOY: only cached candidate ${candidate.name} is not worth deploying — ${skipReason}`);
    }
  }
  const deployAmount = computeDeployAmount((await getWalletBalances()).sol);
  const binsBelow = computeBinsBelow(candidate.volatility);

  // Slippage-aware timing check
  const timing = await waitForGoodTiming({
    pool_address: candidate.pool,
    volatility: candidate.volatility,
  });
  if (!timing.ok) {
    throw new Error(`Slippage check failed: ${timing.reason}`);
  }

  const result = await executeTool("deploy_position", {
    pool_address: candidate.pool,
    amount_y: deployAmount,
    strategy: config.strategy.strategy,
    bins_below: binsBelow,
    bins_above: 0,
    pool_name: candidate.name,
    base_mint: candidate.base?.mint || candidate.base_mint || null,
    bin_step: candidate.bin_step,
    base_fee: candidate.base_fee,
    volatility: candidate.volatility,
    fee_tvl_ratio: candidate.fee_active_tvl_ratio ?? candidate.fee_tvl_ratio,
    organic_score: candidate.organic_score,
    initial_value_usd: candidate.tvl ?? candidate.active_tvl ?? null,
  });
  if (result?.success === false || result?.error) {
    throw new Error(result.error || "Deploy failed");
  }
  return { result, candidate, deployAmount, binsBelow };
}

function appendHistory(userMsg, assistantMsg) {
  sessionHistory.push({ role: "user", content: userMsg });
  sessionHistory.push({ role: "assistant", content: assistantMsg });
  // Trim to last MAX_HISTORY messages
  if (sessionHistory.length > MAX_HISTORY) {
    sessionHistory.splice(0, sessionHistory.length - MAX_HISTORY);
  }
}

function refreshPrompt() {
  if (!_ttyInterface) return;
  _ttyInterface.setPrompt(buildPrompt());
  _ttyInterface.prompt(true);
}

async function drainTelegramQueue() {
  while (_telegramQueue.length > 0 && !_managementBusy && !_screeningBusy && !busy) {
    const queued = _telegramQueue.shift();
    await telegramHandler(queued);
  }
}

async function telegramHandler(msg) {
  const text = msg?.text?.trim();
  if (!text) return;
  if (msg?.isCallback && text.startsWith("cfg:")) {
    try {
      await applySettingsMenuCallback(msg);
    } catch (e) {
      await answerCallbackQuery(msg.callbackQueryId, e.message).catch(() => {});
    }
    return;
  }
  if (text === "/settings" || text === "/menu" || text === "/configmenu") {
    await showSettingsMenu().catch((e) => sendMessage(`Settings error: ${e.message}`).catch(() => {}));
    return;
  }
  if (_managementBusy || _screeningBusy || busy) {
    if (_telegramQueue.length < 5) {
      _telegramQueue.push(msg);
    }
    return;
  }

  if (text === "/briefing") {
    try {
      const briefing = await generateBriefing();
      await sendHTML(briefing);
    } catch (e) {
      await sendMessage(`Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/help") {
    await sendHTML(formatHelpText()).catch(() => {});
    return;
  }

  if (text === "/wallet" || text === "/status") {
    try {
      const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
      const suffix = text === "/status" && positions.total_positions
        ? `\n${SEP}\n💡 <i>Use</i> <code>/positions</code> <i>for the numbered list.</i>`
        : "";
      await sendHTML(`${formatWalletStatus(wallet, positions)}${suffix}`).catch(() => {});
    } catch (e) {
      await sendMessage(`⚠️ Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/config") {
    await sendHTML(formatConfigSnapshot()).catch(() => {});
    return;
  }

  if (text === "/positions") {
    try {
      const { positions, total_positions } = await getMyPositions({ force: true });
      if (total_positions === 0) { await sendHTML("📭 <b>No open positions.</b>\n\n<i>Run</i> <code>/screen</code> <i>to find candidates.</i>"); return; }
      const cur = config.management.solMode ? "◎" : "$";
      let totalValue = 0;
      let totalPnl = 0;
      const cards = positions.map((p, i) => {
        const emoji = pnlEmoji(p.pnl_usd);
        const s = pnlSign(p.pnl_usd);
        const age = p.age_minutes != null ? `${p.age_minutes}m` : "?";
        const status = p.in_range ? "🟩 in range" : `⚠️ OOR ${p.minutes_out_of_range ?? 0}m`;
        totalValue += Number(p.total_value_usd) || 0;
        totalPnl += Number(p.pnl_usd) || 0;
        return [
          `${emoji} <b>${i + 1}. ${escHtml(p.pair)}</b>   <code>${pnlBar(p.pnl_pct)}</code>`,
          `   💵 Value: <code>${cur}${escHtml(p.total_value_usd)}</code>   |   PnL: <code>${s}${cur}${Math.abs(Number(p.pnl_usd) || 0)}</code> (<code>${s}${Math.abs(Number(p.pnl_pct) || 0)}%</code>)`,
          `   💎 Fees: <code>${cur}${escHtml(p.unclaimed_fees_usd)}</code>   |   ⏱️ ${age}   |   ${status}`,
        ].join("\n");
      });
      const totEmoji = pnlEmoji(totalPnl);
      const totSign = pnlSign(totalPnl);
      await sendHTML(
        `📊 <b>OPEN POSITIONS</b>  <i>(${total_positions})</i>\n` +
        `${DOUBLE_SEP}\n` +
        `${cards.join("\n\n")}\n` +
        `${SEP}\n` +
        `${totEmoji} <b>Total</b>: <code>${cur}${totalValue.toFixed(2)}</code>  |  PnL <code>${totSign}${cur}${Math.abs(totalPnl).toFixed(2)}</code>\n` +
        `${DOT_SEP}\n` +
        `<i>Manage:</i> <code>/close &lt;n&gt;</code> · <code>/pool &lt;n&gt;</code> · <code>/set &lt;n&gt; &lt;note&gt;</code>`
      );
    } catch (e) { await sendMessage(`⚠️ Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const poolMatch = text.match(/^\/pool\s+(\d+)$/i);
  if (poolMatch) {
    try {
      const idx = parseInt(poolMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("⚠️ Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      const cur = config.management.solMode ? "◎" : "$";
      const emoji = pnlEmoji(pos.pnl_usd);
      const s = pnlSign(pos.pnl_usd);
      const status = pos.in_range ? "🟩 <b>IN RANGE</b>" : `⚠️ <b>OUT OF RANGE</b> (${pos.minutes_out_of_range ?? 0}m)`;
      await sendHTML([
        `${emoji} <b>POSITION #${idx + 1} — ${escHtml(pos.pair)}</b>`,
        DOUBLE_SEP,
        `📈 PnL: <code>${s}${Math.abs(Number(pos.pnl_pct) || 0)}%</code>   <code>${pnlBar(pos.pnl_pct)}</code>`,
        `💵 Value: <code>${cur}${escHtml(pos.total_value_usd ?? "?")}</code>`,
        `💎 Unclaimed fees: <code>${cur}${escHtml(pos.unclaimed_fees_usd ?? "?")}</code>`,
        `⏱️ Age: <code>${escHtml(pos.age_minutes ?? "?")}m</code>   |   ${status}`,
        SEP,
        `📐 Bins: <code>${escHtml(pos.lower_bin)} → ${escHtml(pos.upper_bin)}</code>  (active <code>${escHtml(pos.active_bin)}</code>)`,
        `🏊 Pool: <code>${escHtml(pos.pool)}</code>`,
        `📍 Position: <code>${escHtml(pos.position)}</code>`,
        pos.instruction ? `${SEP}\n📝 Note: <i>${escHtml(pos.instruction)}</i>` : null,
      ].filter(Boolean).join("\n"));
    } catch (e) {
      await sendMessage(`⚠️ Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const closeMatch = text.match(/^\/close\s+(\d+)$/i);
  if (closeMatch) {
    try {
      const idx = parseInt(closeMatch[1]) - 1;
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      await sendMessage(`⏳ Closing ${pos.pair}...`);
      const result = await closePosition({ position_address: pos.position });
      if (result.success) {
        const cur = config.management.solMode ? "◎" : "$";
        const closeTxs = result.close_txs?.length ? result.close_txs : result.txs;
        const emoji = pnlEmoji(result.pnl_usd);
        const s = pnlSign(result.pnl_usd);
        const claimNote = result.claim_txs?.length ? `\n💎 Claim tx: <code>${escHtml(result.claim_txs[0]?.slice(0, 16))}…</code>` : "";
        await sendHTML(
          `🔒 <b>POSITION CLOSED</b>\n` +
          `${DOUBLE_SEP}\n` +
          `💧 Pair: <b>${escHtml(pos.pair)}</b>\n` +
          `${emoji} PnL: <code>${s}${cur}${Math.abs(Number(result.pnl_usd) || 0)}</code>\n` +
          `🔗 Close tx: <code>${escHtml(closeTxs?.[0]?.slice(0, 16) || "n/a")}…</code>${claimNote}`
        );
      } else {
        await sendHTML(`❌ <b>Close failed</b>\n${SEP}\n<code>${escHtml(result.error || result.reason || JSON.stringify(result).slice(0, 300))}</code>`);
      }
    } catch (e) { await sendMessage(`⚠️ Error: ${e.message}`).catch(() => {}); }
    return;
  }

  if (text === "/closeall") {
    try {
      const { positions } = await getMyPositions({ force: true });
      if (!positions.length) { await sendHTML("📭 <b>No open positions.</b>"); return; }
      await sendMessage(`⏳ Closing ${positions.length} position(s)...`);
      const results = [];
      let okCount = 0;
      for (const pos of positions) {
        try {
          const result = await closePosition({ position_address: pos.position });
          if (result.success) okCount++;
          results.push(`${result.success ? "✅" : "❌"} <b>${escHtml(pos.pair)}</b>${result.success ? "" : ` — <i>${escHtml(result.error || "unknown")}</i>`}`);
        } catch (error) {
          results.push(`❌ <b>${escHtml(pos.pair)}</b> — <i>${escHtml(error.message)}</i>`);
        }
      }
      await sendHTML(
        `🔒 <b>CLOSE-ALL COMPLETE</b>  <i>(${okCount}/${positions.length})</i>\n` +
        `${DOUBLE_SEP}\n${results.join("\n")}`
      ).catch(() => {});
    } catch (e) {
      await sendMessage(`⚠️ Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  const setMatch = text.match(/^\/set\s+(\d+)\s+(.+)$/i);
  if (setMatch) {
    try {
      const idx = parseInt(setMatch[1]) - 1;
      const note = setMatch[2].trim();
      const { positions } = await getMyPositions({ force: true });
      if (idx < 0 || idx >= positions.length) { await sendMessage("Invalid number. Use /positions first."); return; }
      const pos = positions[idx];
      setPositionInstruction(pos.position, note);
      await sendHTML(`📝 <b>Note set</b> — ${escHtml(pos.pair)}\n${SEP}\n<i>${escHtml(note)}</i>`);
    } catch (e) { await sendMessage(`⚠️ Error: ${e.message}`).catch(() => {}); }
    return;
  }

  const setCfgMatch = text.match(/^\/setcfg\s+([A-Za-z0-9_]+)\s+(.+)$/i);
  if (setCfgMatch) {
    try {
      const key = setCfgMatch[1];
      const value = parseConfigValue(setCfgMatch[2]);
      const result = await executeTool("update_config", {
        changes: { [key]: value },
        reason: "Telegram slash command /setcfg",
      });
      if (!result?.success) {
        await sendHTML(`❌ <b>Config update failed</b>\n${SEP}\nUnknown key(s): <code>${escHtml((result?.unknown || []).join(", ") || "none")}</code>`).catch(() => {});
        return;
      }
      await sendHTML(`✅ <b>Config updated</b>\n${SEP}\n<code>${escHtml(key)}</code> = <code>${escHtml(JSON.stringify(value))}</code>`).catch(() => {});
    } catch (e) {
      await sendMessage(`⚠️ Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/screen") {
    try {
      await sendHTML(await runDeterministicScreen(5)).catch(() => {});
    } catch (e) {
      await sendMessage(`⚠️ Error: ${e.message}`).catch(() => {});
    }
    return;
  }

  if (text === "/candidates") {
    await sendHTML(describeLatestCandidates(5)).catch(() => {});
    return;
  }

  const deployMatch = text.match(/^\/deploy\s+(\d+)$/i);
  if (deployMatch) {
    try {
      const idx = parseInt(deployMatch[1]) - 1;
      // executeTool emits the canonical premium deploy notification after the
      // confirmed transaction. Do not send a second, divergent card here.
      await deployLatestCandidate(idx);
    } catch (e) {
      await sendHTML(`❌ <b>Deploy failed</b>\n${SEP}\n<i>${escHtml(e.message)}</i>`).catch(() => {});
    }
    return;
  }

  // ── /strategy - list, set, get strategies ────────────────────
  const STRAT_DOUBLE_SEP = "═══════════════════";
  if (text === "/strategy" || text === "/strategies" || text.startsWith("/strategy ")) {
    const parts = text.trim().split(/\s+/);
    const action = parts[1] || "list";

    if (action === "list" || action === "ls") {
      try {
        const list = listStrategies();
        await sendHTML(formatStrategyList(list)).catch(() => {});
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => {});
      }
      return;
    }

    if (action === "set" || action === "use") {
      const id = parts[2];
      if (!id) {
        await sendMessage("Usage: /strategy set <id>\n\nRun /strategy to see available IDs.").catch(() => {});
        return;
      }
      try {
        const result = setActiveStrategy({ id });
        if (result.error) {
          await sendMessage(`❌ ${result.error}`).catch(() => {});
          if (result.available) {
            await sendMessage(`Available:\n${result.available.map(a => `• ${a}`).join("\n")}`).catch(() => {});
          }
        } else {
          // Show deploy type sync info
          const deployType = result.deployType || config.strategy.strategy;
          await sendHTML(
            `✅ <b>Strategy switched</b>\n` +
            `${STRAT_DOUBLE_SEP}\n` +
            `Now active: <b>${result.name}</b>\n` +
            `ID: <code>${result.active}</code>\n` +
            `Deploy type: <code>${deployType}</code> | Auto-deploy: ${config.strategy.deployEnabled ? "<b>ON</b>" : "<b>OFF</b>"}\n\n` +
            `Will be used on next screening cycle.`
          ).catch(() => {});
        }
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => {});
      }
      return;
    }

    if (action === "get" || action === "info") {
      const id = parts[2];
      if (!id) {
        await sendMessage("Usage: /strategy get <id>\n\nRun /strategy to see available IDs.").catch(() => {});
        return;
      }
      try {
        const s = getStrategy({ id });
        if (s.error) {
          await sendMessage(`❌ ${s.error}`).catch(() => {});
          return;
        }
        const tc = s.token_criteria ? Object.entries(s.token_criteria)
          .filter(([k]) => k !== "notes")
          .map(([k, v]) => `   ${k}: ${v}`).join("\n") : "";
        const entry = s.entry?.condition ? `   Condition: ${s.entry.condition}\n` : "";
        const range = s.range?.type ? `   Type: ${s.range.type}${s.range.bins_below_pct ? ` | below: ${s.range.bins_below_pct}%` : ""}${s.range.bins_above_pct ? ` | above: ${s.range.bins_above_pct}%` : ""}\n` : "";
        const exit = s.exit?.take_profit_pct ? `   TP: ${s.exit.take_profit_pct}%` : "";
        const sl = s.exit?.stop_loss_pct ? ` | SL: ${s.exit.stop_loss_pct}%` : "";
        await sendHTML(
          `📋 <b>${s.name}</b> ${s.is_active ? "✅" : ""}\n` +
          `${STRAT_DOUBLE_SEP}\n` +
          `Author: ${s.author}\n` +
          `Type: <code>${s.lp_strategy}</code>\n` +
          (s.author_url ? `Source: ${s.author_url}\n` : "") +
          (tc ? `\n📊 <b>Token Criteria</b>\n${tc}\n` : "") +
          (s.token_criteria?.notes ? `\n💬 ${s.token_criteria.notes}\n` : "") +
          (entry ? `\n🎯 <b>Entry</b>\n${entry}` : "") +
          (range ? `\n📐 <b>Range</b>\n${range}` : "") +
          (exit || sl ? `\n🚪 <b>Exit</b>\n${exit}${sl}\n` : "") +
          (s.best_for ? `\n💡 ${s.best_for}` : "")
        ).catch(() => {});
      } catch (e) {
        await sendMessage(`Error: ${e.message}`).catch(() => {});
      }
      return;
    }

    await sendMessage("Usage: /strategy [list|set <id>|get <id>]").catch(() => {});
    return;
  }

  if (text === "/pause") {
    stopCronJobs();
    cronStarted = false;
    await sendHTML("⏸ <b>Autonomous cycles paused</b>\n" + SEP + "\n<i>Telegram control still works. Use</i> <code>/resume</code> <i>to start again.</i>").catch(() => {});
    return;
  }

  if (text === "/resume") {
    if (!cronStarted) {
      cronStarted = true;
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      await sendHTML("▶️ <b>Autonomous cycles resumed.</b>").catch(() => {});
    } else {
      await sendHTML("ℹ️ <i>Autonomous cycles are already running.</i>").catch(() => {});
    }
    return;
  }

  if (text === "/deployoff") {
    config.strategy.deployEnabled = false;
    try {
      let ucfg = fs.existsSync(repoPath("user-config.json")) ? JSON.parse(fs.readFileSync(repoPath("user-config.json"), "utf8")) : {};
      ucfg.deployEnabled = false;
      fs.writeFileSync(repoPath("user-config.json"), JSON.stringify(ucfg, null, 2));
    } catch (e) {}
    await sendHTML("⏸ <b>Auto-deploy disabled</b>\n" + SEP + "\n<i>Bot still runs management/harvest. Use</i> <code>/deployon</code> <i>to re-enable.</i>").catch(() => {});
    return;
  }

  if (text === "/deployon") {
    config.strategy.deployEnabled = true;
    try {
      let ucfg = fs.existsSync(repoPath("user-config.json")) ? JSON.parse(fs.readFileSync(repoPath("user-config.json"), "utf8")) : {};
      ucfg.deployEnabled = true;
      fs.writeFileSync(repoPath("user-config.json"), JSON.stringify(ucfg, null, 2));
    } catch (e) {}
    await sendHTML("▶️ <b>Auto-deploy enabled</b>\n" + SEP + "\n<i>Bot will deploy on next screening cycle.</i>").catch(() => {});
    return;
  }

  if (text === "/compound") {
    await runBusy(async () => {
      const report = await runCompoundCycle();
      const lines = [`💰 <b>AUTO-COMPOUND REPORT</b>`, DOUBLE_SEP];
      if (report?.skipped) {
        lines.push(`⏭ Skipped: <i>${escHtml(report.reason)}</i>`);
      } else if (report?.results) {
        const good = report.results.filter(r => r.compounded);
        const claim = report.results.filter(r => r.claimed && !r.compounded);
        lines.push(`✅ Compounded: <b>${good.length}</b>  |  💎 Claimed-only: <b>${claim.length}</b>  |  ❌ Failed: <b>${report.failed}</b>`);
        lines.push(SEP);
        for (const r of report.results) {
          const status = r.compounded ? `✅ <code>${escHtml(r.amount_sol)} SOL</code>` : r.skipped ? `⏭ <i>${escHtml(r.note || "")}</i>` : `❌ <i>${escHtml(r.error || "")}</i>`;
          lines.push(`   <b>${escHtml(r.pair)}</b>: ${status}`);
        }
      }
      await sendHTML(lines.join("\n")).catch(() => {});
    });
    return;
  }

  if (text === "/portfolio") {
    await sendHTML(formatPortfolioStatus()).catch(() => {});
    return;
  }

  if (text === "/copylp" || text === "/copylp status") {
    await sendHTML(formatCopyLpStatus() + (config.copyLp?.enabled ? `\n${SEP}\n<i>Run</i> <code>/copylp scan</code> <i>to trigger a scan now.</i>` : "")).catch(() => {});
    return;
  }

  if (text === "/copylp scan") {
    if (!config.copyLp?.enabled) {
      await sendHTML("⚠️ <b>Copy LP is disabled.</b>\n<i>Enable it in config first.</i>").catch(() => {});
      return;
    }
    await runBusy(async () => {
      const report = await runCopyLPCycle();
      if (report?.skipped) {
        await sendHTML(`📋 <b>Copy LP</b>: <i>${escHtml(report.reason)}</i>`).catch(() => {});
      } else {
        const lines = [`📋 <b>COPY LP SCAN</b>`, DOUBLE_SEP, `👥 LPers: <i>${escHtml(report.lpers.map(l => `${l.name} (${l.wr}% WR)`).join(", "))}</i>`];
        if (report.poolsDiscovered > 0) lines.push(`🔍 Discovered: <b>${report.poolsDiscovered}</b>`);
        if (report.poolsPassed > 0) lines.push(`✅ Passed screening: <b>${report.poolsPassed}</b>`);
        if (report.deployed?.length > 0) {
          lines.push(SEP);
          lines.push(`🚀 Deployed: <b>${report.deployed.length}</b>`);
          for (const d of report.deployed) {
            lines.push(`   ✅ <b>${escHtml(d.pair)}</b> <i>(${escHtml(d.strategy)})</i> — copy of ${escHtml(d.lper)}`);
          }
        } else {
          lines.push(`<i>No pools met screening criteria this cycle.</i>`);
        }
        await sendHTML(lines.join("\n")).catch(() => {});
      }
    });
    return;
  }

  if (text === "/pump" || text === "/pump status") {
    await sendHTML(formatPumpSniperStatus()).catch(() => {});
    return;
  }

  if (text === "/pump scan") {
    if (!config.pumpSniper?.enabled) {
      await sendHTML("⚠️ <b>Pump.fun sniper is disabled.</b>\n<i>Enable it in config first.</i>").catch(() => {});
      return;
    }
    await runBusy(async () => {
      const report = await (await import("./pump-sniper.js")).runSniperTick();
      await sendHTML(`🚀 <b>Pump scan complete</b>\n${SEP}\n🔎 Checked <b>${report.checked || 0}</b> tokens`).catch(() => {});
    });
    return;
  }

  if (text === "/dashboard") {
    const port = config.webDashboard?.port ?? 3333;
    await sendHTML(`📊 <b>WEB DASHBOARD</b>\n${SEP}\n🔗 <code>http://localhost:${port}</code>\n\n💡 <i>Akses dari HP via Tailscale / ngrok / LAN IP</i>`).catch(() => {});
    return;
  }

  if (text === "/hive" || text === "/hive pull") {
    try {
      const enabled = isHiveMindEnabled();
      const agentId = ensureAgentId();
      if (!enabled) {
        await sendHTML(`🧠 <b>HiveMind</b>: <i>disabled</i>\n${SEP}\n🆔 Agent ID: <code>${escHtml(agentId)}</code>\n💡 <i>Set</i> <code>hiveMindApiKey</code> <i>to connect.</i>`).catch(() => {});
        return;
      }
      const isManualPull = text === "/hive pull";
      const pullMode = getHiveMindPullMode();
      const [registerResult, lessons, presets] = await Promise.all([
        registerHiveMindAgent({ reason: isManualPull ? "telegram_pull" : "telegram_status" }),
        (pullMode === "auto" || isManualPull) ? pullHiveMindLessons(12) : Promise.resolve(null),
        (pullMode === "auto" || isManualPull) ? pullHiveMindPresets() : Promise.resolve(null),
      ]);
      await sendHTML([
        `🧠 <b>HIVEMIND</b>  <i>(connected)</i>`,
        DOUBLE_SEP,
        `🆔 Agent: <code>${escHtml(agentId)}</code>`,
        `🌐 URL: <code>${escHtml(config.hiveMind.url)}</code>`,
        `🔁 Pull mode: <b>${escHtml(pullMode)}</b>`,
        `${registerResult ? "✅" : "⚠️"} Register: <b>${registerResult ? "ok" : "warn"}</b>`,
        SEP,
        `📚 Shared lessons: <b>${Array.isArray(lessons) ? lessons.length : (pullMode === "manual" ? "manual" : 0)}</b>`,
        `🎛️ Presets: <b>${Array.isArray(presets) ? presets.length : (pullMode === "manual" ? "manual" : 0)}</b>`,
        isManualPull ? `${SEP}\n✅ <i>Manual pull completed</i>` : null,
      ].filter(Boolean).join("\n")).catch(() => {});
    } catch (e) {
      await sendMessage(`⚠️ HiveMind error: ${e.message}`).catch(() => {});
    }
    return;
  }

  busy = true;
  let liveMessage = null;
  try {
    log("telegram", `Incoming: ${text}`);
    const hasCloseIntent = /\bclose\b|\bsell\b|\bexit\b|\bwithdraw\b/i.test(text);
    const isDeployRequest = !hasCloseIntent && /\bdeploy\b|\bopen position\b|\blp into\b|\badd liquidity\b/i.test(text);
    const agentRole = isDeployRequest ? "SCREENER" : "GENERAL";
    const agentModel = agentRole === "SCREENER" ? config.llm.screeningModel : config.llm.generalModel;
    liveMessage = await createLiveMessage("🤖 Live Update", `Request: ${text.slice(0, 240)}`);
    const { content } = await agentLoop(text, config.llm.maxSteps, sessionHistory, agentRole, agentModel, null, {
      interactive: true,
      onToolStart: async ({ name }) => { await liveMessage?.toolStart(name); },
      onToolFinish: async ({ name, result, success }) => { await liveMessage?.toolFinish(name, result, success); },
    });
    appendHistory(text, content);
    if (liveMessage) await liveMessage.finalize(stripThink(content));
    else await sendMessage(stripThink(content));
  } catch (e) {
    const clean = cleanErrorMessage(e.message);
    log("telegram_error", `Handler failed: ${String(e.message).slice(0, 300)}`);
    if (liveMessage) await liveMessage.fail(clean).catch(() => {});
    else await sendMessage(`⚠️ ${clean}`).catch(() => {});
  } finally {
    busy = false;
    refreshPrompt();
    drainTelegramQueue().catch(() => {});
  }
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}

/**
 * Turn a raw error message into a clean, user-friendly one-liner.
 * Strips leaked HTML error pages (nginx/cloudflare 502/503/504) so the user
 * never sees a wall of markup — maps them to a plain "provider unavailable" note.
 */
function cleanErrorMessage(raw) {
  const msg = String(raw ?? "").trim();
  if (!msg) return "unknown error";
  // Detect leaked HTML gateway error pages
  if (/<html|<\/html>|<head>|nginx|cloudflare/i.test(msg)) {
    const codeMatch = msg.match(/\b(502|503|504|520|521|522|524)\b/);
    const code = codeMatch ? codeMatch[1] : null;
    const labels = {
      "502": "Bad Gateway", "503": "Service Unavailable", "504": "Gateway Timeout",
      "520": "Server Error", "521": "Server Down", "522": "Connection Timed Out", "524": "Timeout",
    };
    const label = code ? `${code} ${labels[code] || ""}`.trim() : "gateway error";
    return `Provider temporarily unavailable (${label}). Please try again in a moment.`;
  }
  // Collapse whitespace and cap length
  return msg.replace(/\s+/g, " ").slice(0, 400);
}

function getLoneCandidateSkipReason({ pool, sw, n, ti } = {}) {
  if (!pool) return "missing candidate data";
  const tokenInfo = ti || {};
  const hasNarrative = !!n?.narrative;
  // Degen Score is the conviction signal for a solo deploy. Smart wallet is NO LONGER a
  // gate here — it's a confidence boost surfaced to the LLM, not a requirement.
  const degen = degenScore(pool, config.opportunity);
  const degenStrong = degen >= (config.screening.loneCandidateMinDegen ?? 50);
  const globalFeesSol = Number(tokenInfo.global_fees_sol ?? pool.gmgn_total_fee_sol);
  const top10Pct = Number(tokenInfo.audit?.top_holders_pct ?? pool.gmgn_token_info_top10_pct ?? pool.gmgn_top10_holder_pct);
  const botPct = Number(tokenInfo.audit?.bot_holders_pct ?? pool.gmgn_bot_degen_pct);

  // Hard fundamental gates — no override.
  if (Number.isFinite(globalFeesSol) && globalFeesSol < config.screening.minTokenFeesSol) {
    return `token fees ${globalFeesSol} SOL below minimum ${config.screening.minTokenFeesSol} SOL`;
  }
  if (Number.isFinite(top10Pct) && top10Pct > config.screening.maxTop10Pct) {
    return `top10 concentration ${top10Pct}% above maximum ${config.screening.maxTop10Pct}%`;
  }
  if (Number.isFinite(botPct) && botPct > config.screening.maxBotHoldersPct) {
    return `bot holders ${botPct}% above maximum ${config.screening.maxBotHoldersPct}%`;
  }

  // PVP conflict needs strong conviction (degen) to deploy solo.
  if (pool.is_pvp && !degenStrong) {
    return `PVP symbol conflict without strong degen conviction (degen ${degen.toFixed(1)} < ${config.screening.loneCandidateMinDegen ?? 50})`;
  }
  // Conviction: a solo deploy needs a narrative OR a strong degen score.
  if (!hasNarrative && !degenStrong) {
    return `only candidate has no narrative and weak degen score (${degen.toFixed(1)} < ${config.screening.loneCandidateMinDegen ?? 50})`;
  }
  return null;
}

function computeBinsBelow(volatility) {
  const parsedVolatility = Number(volatility);
  if (!Number.isFinite(parsedVolatility) || parsedVolatility <= 0) {
    throw new Error(`Invalid volatility ${volatility ?? "unknown"} — refusing volatility-scaled deploy.`);
  }
  const lo = config.strategy.minBinsBelow;
  const hi = config.strategy.maxBinsBelow;
  return Math.max(lo, Math.min(hi, Math.round(lo + (parsedVolatility / 5) * (hi - lo))));
}

// Register restarter — when update_config changes intervals, running cron jobs get replaced
registerCronRestarter(() => { if (cronStarted) startCronJobs(); });

if (isMain && isTTY) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: buildPrompt(),
  });
  _ttyInterface = rl;

  // Update prompt countdown every 10 seconds
  setInterval(() => {
    if (!busy) {
      rl.setPrompt(buildPrompt());
      rl.prompt(true); // true = preserve current line
    }
  }, 10_000);

  function launchCron() {
    if (!cronStarted) {
      cronStarted = true;
      // Seed timers so countdown starts from now
      timers.managementLastRun = Date.now();
      timers.screeningLastRun = Date.now();
      startCronJobs();
      console.log("Autonomous cycles are now running.\n");
      rl.setPrompt(buildPrompt());
      rl.prompt(true);
    }
  }

  async function runBusy(fn) {
    if (busy) { console.log("Agent is busy, please wait..."); rl.prompt(); return; }
    busy = true; rl.pause();
    try { await fn(); }
    catch (e) { console.error(`Error: ${e.message}`); }
    finally { busy = false; rl.setPrompt(buildPrompt()); rl.resume(); rl.prompt(); }
  }

  // ── Startup: show wallet + top candidates ──
  console.log(`
╔═══════════════════════════════════════════╗
║         DLMM LP Agent — Ready             ║
╚═══════════════════════════════════════════╝
`);

  console.log("Fetching wallet and top pool candidates...\n");

  busy = true;
  try {
    const [wallet, positions, { candidates, total_eligible, total_screened }] = await Promise.all([
      getWalletBalances(),
      getMyPositions({ force: true }),
      getTopCandidates({ limit: 5 }),
    ]);

    setLatestCandidates(candidates);

    console.log(`Wallet:    ${wallet.sol} SOL  ($${wallet.sol_usd})  |  SOL price: $${wallet.sol_price}`);
    console.log(`Positions: ${positions.total_positions} open\n`);

    if (positions.total_positions > 0) {
      console.log("Open positions:");
      for (const p of positions.positions) {
        const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
        console.log(`  ${p.pair.padEnd(16)} ${status}  fees: $${p.unclaimed_fees_usd}`);
      }
      console.log();
    }

    console.log(`Top pools (${total_eligible} eligible from ${total_screened} screened):\n`);
    console.log(formatCandidates(candidates));

  } catch (e) {
    console.error(`Startup fetch failed: ${e.message}`);
  } finally {
    busy = false;
  }

  // Always start autonomous cycles on launch
  launchCron();
  maybeRunMissedBriefing().catch(() => { });

  startPolling(telegramHandler);

  console.log(`
Commands:
  1 / 2 / 3 ...  Deploy ${DEPLOY} SOL into that pool
  auto           Let the agent pick and deploy automatically
  /status        Refresh wallet + positions
  /candidates    Refresh top pool list
  /briefing      Show morning briefing (last 24h)
  /learn         Study top LPers from the best current pool and save lessons
  /learn <addr>  Study top LPers from a specific pool address
  /thresholds    Show current screening thresholds + performance stats
  /evolve        Manually trigger threshold evolution from performance data
  /stop          Shut down
`);

  rl.prompt();

  rl.on("line", async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    // ── Number pick: deploy into pool N ─────
    const pick = parseInt(input);
    const latest = getLatestCandidatesMeta().candidates;
    if (!isNaN(pick) && pick >= 1 && pick <= latest.length) {
      await runBusy(async () => {
        const pool = latest[pick - 1];
        console.log(`\nDeploying ${DEPLOY} SOL into ${pool.name}...\n`);
        const { content: reply } = await agentLoop(
          `Deploy ${DEPLOY} SOL into pool ${pool.pool} (${pool.name}). Call get_active_bin first then deploy_position. Report result.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── auto: agent picks and deploys ───────
    if (input.toLowerCase() === "auto") {
      await runBusy(async () => {
        console.log("\nAgent is picking and deploying...\n");
        const { content: reply } = await agentLoop(
          `get_top_candidates and deploy only if a candidate is clearly worth it. If there is only one weak candidate, report NO DEPLOY. For a valid deploy, use amount_y=${DEPLOY}, amount_x=0, bins_above=0, and bins_below from positive volatility. Execute now, don't ask.`,
          config.llm.maxSteps,
          [],
          "SCREENER"
        );
        console.log(`\n${reply}\n`);
        launchCron();
      });
      return;
    }

    // ── go: start cron without deploying ────
    if (input.toLowerCase() === "go") {
      launchCron();
      rl.prompt();
      return;
    }

    // ── Slash commands ───────────────────────
    if (input === "/stop") { await shutdown("user command"); return; }

    if (input === "/status") {
      await runBusy(async () => {
        const [wallet, positions] = await Promise.all([getWalletBalances(), getMyPositions({ force: true })]);
        console.log(`\nWallet: ${wallet.sol} SOL  ($${wallet.sol_usd})`);
        console.log(`Positions: ${positions.total_positions}`);
        for (const p of positions.positions) {
          const status = p.in_range ? "in-range ✓" : "OUT OF RANGE ⚠";
          console.log(`  ${p.pair.padEnd(16)} ${status}  fees: ${config.management.solMode ? "◎" : "$"}${p.unclaimed_fees_usd}`);
        }
        console.log();
      });
      return;
    }

    if (input === "/briefing") {
      await runBusy(async () => {
        const briefing = await generateBriefing();
        console.log(`\n${briefing.replace(/<[^>]*>/g, "")}\n`);
      });
      return;
    }

    if (input === "/candidates") {
      await runBusy(async () => {
        const { candidates, total_eligible, total_screened } = await getTopCandidates({ limit: 5 });
        setLatestCandidates(candidates);
        console.log(`\nTop pools (${total_eligible} eligible from ${total_screened} screened):\n`);
        console.log(formatCandidates(candidates));
        console.log();
      });
      return;
    }

    if (input === "/thresholds") {
      const s = config.screening;
      console.log("\nCurrent screening thresholds:");
      console.log(`  minFeeActiveTvlRatio: ${s.minFeeActiveTvlRatio}`);
      console.log(`  minOrganic:           ${s.minOrganic}`);
      console.log(`  minHolders:           ${s.minHolders}`);
      console.log(`  minTvl:               ${s.minTvl}`);
      console.log(`  maxTvl:               ${s.maxTvl}`);
      console.log(`  minVolume:            ${s.minVolume}`);
      console.log(`  minTokenFeesSol:      ${s.minTokenFeesSol}`);
      console.log(`  maxBotHoldersPct:     ${s.maxBotHoldersPct}`);
      console.log(`  maxTop10Pct:          ${s.maxTop10Pct}`);
      console.log(`  timeframe:            ${s.timeframe}`);
      const perf = getPerformanceSummary();
      if (perf) {
        console.log(`\n  Based on ${perf.total_positions_closed} closed positions`);
        console.log(`  Win rate: ${perf.win_rate_pct}%  |  Avg PnL: ${perf.avg_pnl_pct}%`);
      } else {
        console.log("\n  No closed positions yet — thresholds are preset defaults.");
      }
      console.log();
      rl.prompt();
      return;
    }

    if (input.startsWith("/learn")) {
      await runBusy(async () => {
        const parts = input.split(" ");
        const poolArg = parts[1] || null;

        let poolsToStudy = [];

        if (poolArg) {
          poolsToStudy = [{ pool: poolArg, name: poolArg }];
        } else {
          // Fetch top 10 candidates across all eligible pools
          console.log("\nFetching top pool candidates to study...\n");
          const { candidates } = await getTopCandidates({ limit: 10 });
          if (!candidates.length) {
            console.log("No eligible pools found to study.\n");
            return;
          }
          poolsToStudy = candidates.map((c) => ({ pool: c.pool, name: c.name }));
        }

        console.log(`\nStudying top LPers across ${poolsToStudy.length} pools...\n`);
        for (const p of poolsToStudy) console.log(`  • ${p.name || p.pool}`);
        console.log();

        const poolList = poolsToStudy
          .map((p, i) => `${i + 1}. ${p.name} (${p.pool})`)
          .join("\n");

        const { content: reply } = await agentLoop(
          `Study top LPers across these ${poolsToStudy.length} pools by calling study_top_lpers for each:

${poolList}

For each pool, call study_top_lpers then move to the next. After studying all pools:
1. Identify patterns that appear across multiple pools (hold time, scalping vs holding, win rates).
2. Note pool-specific patterns where behaviour differs significantly.
3. Derive 4-8 concrete, actionable lessons using add_lesson. Prioritize cross-pool patterns — they're more reliable.
4. Summarize what you learned.

Focus on: hold duration, entry/exit timing, what win rates look like, whether scalpers or holders dominate.`,
          config.llm.maxSteps,
          [],
          "GENERAL"
        );
        console.log(`\n${reply}\n`);
      });
      return;
    }

    if (input === "/evolve") {
      await runBusy(async () => {
        const perf = getPerformanceSummary();
        if (!perf || perf.total_positions_closed < 5) {
          const needed = 5 - (perf?.total_positions_closed || 0);
          console.log(`\nNeed at least 5 closed positions to evolve. ${needed} more needed.\n`);
          return;
        }
        const fs = await import("fs");
        const lessonsData = JSON.parse(fs.default.readFileSync(repoPath("lessons.json"), "utf8"));
        const result = evolveThresholds(lessonsData.performance, config);
        if (!result || Object.keys(result.changes).length === 0) {
          console.log("\nNo threshold changes needed — current settings already match performance data.\n");
        } else {
          reloadScreeningThresholds();
          console.log("\nThresholds evolved:");
          for (const [key, val] of Object.entries(result.changes)) {
            console.log(`  ${key}: ${result.rationale[key]}`);
          }
          console.log("\nSaved to user-config.json. Applied immediately.\n");
        }
      });
      return;
    }

    // ── Free-form chat ───────────────────────
    await runBusy(async () => {
      log("user", input);
      const { content } = await agentLoop(input, config.llm.maxSteps, sessionHistory, "GENERAL", config.llm.generalModel, null, { interactive: true });
      appendHistory(input, content);
      console.log(`\n${content}\n`);
    });
  });

  rl.on("close", () => shutdown("stdin closed"));

} else if (isMain) {
  // Non-TTY: start immediately
  log("startup", "Non-TTY mode — starting cron cycles immediately.");
  startCronJobs();
  maybeRunMissedBriefing().catch(() => { });
  startPolling(telegramHandler);
  (async () => {
    try {
      await runScreeningCycle({ silent: false });
    } catch (e) {
      log("startup_error", e.message);
    }
  })();
}
