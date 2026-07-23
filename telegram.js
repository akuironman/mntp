import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const USER_CONFIG_PATH = repoPath("user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

let chatId = null;
let _offset  = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;

function nonEmptyChatId(value) {
  if (value == null) return null;
  const trimmed = String(value).trim();
  return trimmed || null;
}

// ─── chatId persistence ──────────────────────────────────────────
function resolveChatId() {
  const fromEnv = nonEmptyChatId(process.env.TELEGRAM_CHAT_ID);
  let fromConfig = null;
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      fromConfig = nonEmptyChatId(cfg.telegramChatId);
    }
  } catch (error) {
    log("telegram_warn", `Invalid user-config.json; chatId not loaded: ${error.message}`);
  }
  // user-config wins when set; otherwise fall back to .env
  const resolved = fromConfig || fromEnv || null;
  return resolved != null ? String(resolved) : null;
}

function loadChatId() {
  chatId = resolveChatId();
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const chatType = msg.chat?.type || "unknown";

  if (!chatId) {
    if (!_warnedMissingChatId) {
      log("telegram_warn", "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety.");
      _warnedMissingChatId = true;
    }
    return false;
  }

  if (incomingChatId !== String(chatId)) return false;

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log("telegram_warn", "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control.");
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
  }

  return true;
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

async function postTelegram(method, body) {
  if (!TOKEN || !chatId) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) {
        log("telegram_error", `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN in .env (invalid, revoked, or encrypted without .envrypt key)`);
      } else {
        log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

async function postTelegramRaw(method, body) {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      if (res.status === 401) {
        log("telegram_error", `${method} 401 Unauthorized — check TELEGRAM_BOT_TOKEN in .env (invalid, revoked, or encrypted without .envrypt key)`);
      } else {
        log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      }
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

export async function sendMessage(text) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendMessageWithButtons(text, inlineKeyboard) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", {
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function sendHTML(html) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: html.slice(0, 4096), parse_mode: "HTML" });
}

export async function editMessage(text, messageId) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
  });
}

export async function editMessageWithButtons(text, messageId, inlineKeyboard) {
  if (!TOKEN || !chatId || !messageId) return null;
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!TOKEN || !callbackQueryId) return null;
  return postTelegramRaw("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

export function hasActiveLiveMessage() {
  return _liveMessageDepth > 0;
}

function createTypingIndicator() {
  if (!TOKEN || !chatId) {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" });
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function toolLabel(name) {
  const labels = {
    get_token_info: "get token info",
    get_token_narrative: "get token narrative",
    get_token_holders: "get token holders",
    get_top_candidates: "get top candidates",
    get_pool_detail: "get pool detail",
    get_active_bin: "get active bin",
    deploy_position: "deploy position",
    close_position: "close position",
    claim_fees: "claim fees",
    swap_token: "swap token",
    update_config: "update config",
    get_my_positions: "get positions",
    get_wallet_balance: "get wallet balance",
    check_smart_wallets_on_pool: "check smart wallets",
    study_top_lpers: "study top LPers",
    get_top_lpers: "get top LPers",
    search_pools: "search pools",
    discover_pools: "discover pools",
  };
  return labels[name] || name.replace(/_/g, " ");
}

function summarizeToolResult(name, result) {
  if (!result) return "";
  if (result.error) return result.error;
  if (result.reason && result.blocked) return result.reason;
  switch (name) {
    case "deploy_position":
      return result.position ? `position ${String(result.position).slice(0, 8)}...` : "submitted";
    case "close_position":
      return result.success ? "closed" : (result.reason || "failed");
    case "claim_fees":
      return result.claimed_amount != null ? `claimed ${result.claimed_amount}` : "done";
    case "update_config":
      return Object.keys(result.applied || {}).join(", ") || "updated";
    case "get_top_candidates":
      return `${result.candidates?.length ?? 0} candidates`;
    case "get_my_positions":
      return `${result.total_positions ?? result.positions?.length ?? 0} positions`;
    case "get_wallet_balance":
      return `${result.sol ?? "?"} SOL`;
    case "study_top_lpers":
    case "get_top_lpers":
      return `${result.lpers?.length ?? 0} LPers`;
    default:
      return result.success === false ? "failed" : "done";
  }
}

export async function createLiveMessage(title, intro = "Starting...") {
  if (!TOKEN || !chatId) return null;
  const typing = createTypingIndicator();

  const state = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
  };

  function render() {
    const sections = [state.title];
    if (state.intro) sections.push(state.intro);
    if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
    if (state.footer) sections.push(state.footer);
    return sections.join("\n\n").slice(0, 4096);
  }

  async function flushNow() {
    state.flushTimer = null;
    state.flushRequested = false;
    const text = render();
    if (!state.messageId) {
      const sent = await sendMessage(text);
      state.messageId = sent?.result?.message_id ?? null;
      return;
    }
    await editMessage(text, state.messageId);
  }

  function scheduleFlush(delay = 300) {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => null);
    }, delay);
  }

  async function upsertToolLine(name, icon, suffix = "") {
    const label = toolLabel(name);
    const line = `${icon} ${label}${suffix ? ` ${suffix}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name) {
      await upsertToolLine(name, "ℹ️", "...");
    },
    async toolFinish(name, result, success) {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result);
      await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
    },
    async note(text) {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${errorText}`;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const callback = update.callback_query;
        if (callback?.data && callback?.message) {
          const callbackMsg = {
            chat: callback.message.chat,
            from: callback.from,
            text: callback.data,
          };
          if (!isAuthorizedIncomingMessage(callbackMsg)) continue;
          await onMessage({
            ...callbackMsg,
            isCallback: true,
            callbackQueryId: callback.id,
            callbackData: callback.data,
            messageId: callback.message.message_id,
          });
          continue;
        }
        const msg = update.message;
        if (!msg?.text) continue;
        if (!isAuthorizedIncomingMessage(msg)) continue;
        await onMessage(msg);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

const BOT_COMMANDS = [
  { command: "help",       description: "📖 Show all commands" },
  { command: "status",     description: "📊 Wallet + positions snapshot" },
  { command: "wallet",     description: "👛 Balance, deploy amount, HiveMind" },
  { command: "positions",  description: "💧 List open positions" },
  { command: "pool",       description: "🔎 Detailed info for one position" },
  { command: "portfolio",  description: "📦 Multi-strategy portfolio status" },
  { command: "briefing",   description: "☀️ Morning performance briefing" },
  { command: "close",      description: "🔒 Close one position by index" },
  { command: "closeall",   description: "🔒 Close all open positions" },
  { command: "set",        description: "📝 Set note/instruction on position" },
  { command: "compound",   description: "💰 Trigger fee compounding now" },
  { command: "screen",     description: "🔍 Refresh candidate list" },
  { command: "candidates", description: "🗂️ Show cached candidates" },
  { command: "deploy",     description: "🚀 Deploy candidate by index" },
  { command: "strategy",   description: "🎯 List / set / get LP strategies" },
  { command: "config",     description: "⚙️ Runtime config snapshot" },
  { command: "settings",   description: "🎛️ Button menu for config" },
  { command: "setcfg",     description: "🔧 Update persisted config key" },
  { command: "copylp",     description: "📋 Copy-LP status / scan" },
  { command: "pump",       description: "🚀 Pump.fun sniper status / scan" },
  { command: "hive",       description: "🧠 HiveMind sync status / pull" },
  { command: "dashboard",  description: "📊 Web dashboard URL" },
  { command: "pause",      description: "⏸ Stop cron cycles" },
  { command: "resume",     description: "▶️ Resume cron cycles" },
  { command: "deployoff",  description: "⏸ Stop auto-deploy (bot stays on)" },
  { command: "deployon",   description: "▶️ Re-enable auto-deploy" },
  { command: "stop",       description: "🛑 Shut down agent" },
];

async function registerCommands() {
  if (!BASE) return;
  try {
    await fetch(`${BASE}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    });
    log("telegram", "Bot commands registered");
  } catch (e) {
    log("telegram_warn", `Failed to register bot commands: ${e.message}`);
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  loadChatId();
  if (!chatId) {
    log("telegram_warn", "TELEGRAM_CHAT_ID not set in .env or user-config.telegramChatId — outbound notifications and inbound control disabled until configured.");
  }
  _polling = true;
  poll(onMessage); // fire-and-forget
  registerCommands();
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────

/**
 * PnL emoji helper - green for profit, red for loss, yellow for flat.
 */
function pnlEmoji(usd) {
  if (usd > 0) return "🟢";
  if (usd < 0) return "🔴";
  return "🟡";
}

/**
 * PnL sign helper for display.
 */
function pnlSign(usd) {
  if (usd > 0) return "+";
  if (usd < 0) return "-";
  return "";
}

/**
 * Format USD value compactly.
 */
function fmtUsd(usd) {
  const n = Number(usd ?? 0);
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

/**
 * Thin separator line.
 */
export const SEP = "─────────────────────";
export const DOUBLE_SEP = "━━━━━━━━━━━━━━━━━━━━━";
export const DOT_SEP = "· · · · · · · · · · · · · · · · ·";

/**
 * Escape a string for safe use in Telegram HTML parse_mode.
 * Only &, <, > need escaping per Bot API.
 */
export function escHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Render a compact unicode progress/PnL bar.
 * pct is clamped to [0,100]. Filled portion uses █, empty uses ░.
 */
export function progressBar(pct, width = 10) {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  const filled = Math.round((p / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/**
 * Signed PnL bar centred on 0. Negative fills red side, positive green side.
 * Used for at-a-glance position health.
 */
export function pnlBar(pnlPct, width = 8) {
  const p = Number(pnlPct) || 0;
  const mag = Math.min(Math.abs(p), 100);
  const blocks = Math.round((mag / 100) * width);
  if (p >= 0) return "▪".repeat(width) + " " + "▰".repeat(Math.max(1, blocks));
  return "▱".repeat(Math.max(1, blocks)) + " " + "▪".repeat(width);
}

/**
 * Export the PnL helpers so command handlers can build consistent cards.
 */
export { pnlEmoji, pnlSign, fmtUsd };

export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, rangeCoverage, binStep, baseFee, strategy }) {
  if (hasActiveLiveMessage()) return;
  const priceStr = priceRange
    ? `📊 Price: <code>${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)}</code> → <code>${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}</code>\n`
    : "";
  const coverageStr = rangeCoverage
    ? `📐 Range: ${fmtPct(rangeCoverage.downside_pct)} ↓ | ${fmtPct(rangeCoverage.upside_pct)} ↑ | ${fmtPct(rangeCoverage.width_pct)} total\n`
    : "";
  const poolStr = (binStep || baseFee)
    ? `⚙️ Bin step: <code>${binStep ?? "?"}</code>  |  Fee: <code>${baseFee != null ? baseFee + "%" : "?"}</code>\n`
    : "";
  const stratStr = strategy ? `🎯 Strategy: <code>${strategy}</code>\n` : "";
  await sendHTML(
    `🚀 <b>NEW POSITION DEPLOYED</b>\n` +
    `${DOUBLE_SEP}\n` +
    `💧 Pair: <b>${pair}</b>\n` +
    `💰 Amount: <code>${amountSol} SOL</code>\n` +
    stratStr +
    priceStr +
    coverageStr +
    poolStr +
    `📍 Position: <code>${position?.slice(0, 8)}…</code>\n` +
    `🔗 Tx: <code>${tx?.slice(0, 16)}…</code>`
  );
}

export async function notifyClose({ pair, pnlUsd, pnlPct, strategy }) {
  if (hasActiveLiveMessage()) return;
  const s = pnlSign(pnlUsd);
  const emoji = pnlEmoji(pnlUsd);
  const stratStr = strategy ? `🎯 Strategy: <code>${strategy}</code>\n` : "";
  await sendHTML(
    `🔒 <b>POSITION CLOSED</b>\n` +
    `${DOUBLE_SEP}\n` +
    `💧 Pair: <b>${pair}</b>\n` +
    stratStr +
    `${emoji} PnL: <code>${s}$${Math.abs(pnlUsd ?? 0).toFixed(2)}</code> (<code>${s}${Math.abs(pnlPct ?? 0).toFixed(2)}%</code>)`
  );
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
    `🔄 <b>TOKEN SWAP</b>\n` +
    `${SEP}\n` +
    `📥 In: <code>${amountIn ?? "?"} ${inputSymbol}</code>\n` +
    `📤 Out: <code>${amountOut ?? "?"} ${outputSymbol}</code>\n` +
    `🔗 Tx: <code>${tx?.slice(0, 16)}…</code>`
  );
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  if (hasActiveLiveMessage()) return;
  const urgency = minutesOOR > 120 ? "🚨" : minutesOOR > 60 ? "⚠️" : "📍";
  await sendHTML(
    `${urgency} <b>OUT OF RANGE</b>\n` +
    `${SEP}\n` +
    `💧 Pair: <b>${pair}</b>\n` +
    `⏱️ OOR for: <code>${minutesOOR} min</code>\n` +
    `💡 Consider re-deploying or closing`
  );
}

/**
 * Notify when a position crosses a PnL threshold (like the screenshot).
 * @param {object} opts - { pair, positionId, pnlPct, pnlUsd, threshold, strategy }
 */
export async function notifyPnLThreshold({ pair, positionId, pnlPct, pnlUsd, threshold, strategy }) {
  if (hasActiveLiveMessage()) return;
  const s = pnlSign(pnlUsd);
  const emoji = pnlEmoji(pnlUsd);
  const stratStr = strategy ? `🎯 Strategy: <code>${strategy}</code>\n` : "";
  await sendHTML(
    `${emoji} <b>Position #${positionId ?? "?"} ${pair}</b>\n` +
    `${SEP}\n` +
    `📈 crossed <code>${threshold}%</code>\n` +
    `${stratStr}` +
    `Current PnL: <code>${s}${Math.abs(pnlPct ?? 0).toFixed(1)}%</code> (<code>${s}$${Math.abs(pnlUsd ?? 0).toFixed(2)}</code>)`
  );
}

/**
 * Format a positions list message (like the screenshot - table-like layout).
 * @param {Array} positions - array of { pair, pnlUsd, pnlPct, rangeMin, rangeMax, strategy }
 */
export function formatPositionsList(positions) {
  if (!positions || positions.length === 0) return "📭 No open positions.";
  const lines = positions.map((p, i) => {
    const emoji = pnlEmoji(p.pnlUsd);
    const s = pnlSign(p.pnlUsd);
    const rangeStr = (p.rangeMin != null && p.rangeMax != null)
      ? `<code>${fmtUsd(p.rangeMin)} – ${fmtUsd(p.rangeMax)}</code>`
      : "-";
    return `${emoji} <b>${i + 1}. ${p.pair}</b>\n   Range: ${rangeStr}\n   PnL: <code>${s}$${Math.abs((p.pnlUsd ?? 0)).toFixed(2)}</code> (<code>${s}${Math.abs(p.pnlPct ?? 0).toFixed(1)}%</code>)`;
  });
  return `📊 <b>OPEN POSITIONS (${positions.length})</b>\n${DOUBLE_SEP}\n${lines.join("\n\n")}`;
}

/**
 * Format a strategy list message for Telegram.
 * @param {object} listResult - result from strategy-library.listStrategies()
 */
export function formatStrategyList(listResult) {
  if (!listResult || !listResult.strategies) return "No strategies found.";
  const lines = listResult.strategies.map((s) => {
    const active = s.active ? " ✅" : "";
    const author = s.author !== "meridian" ? ` by ${s.author}` : "";
    return `🔹 <b>${s.name}</b>${active}\n   <code>${s.id}</code>${author}\n   ${s.lp_strategy} | ${s.best_for?.slice(0, 80) ?? ""}`;
  });
  return `📚 <b>STRATEGY LIBRARY</b> (${listResult.count})\n${DOUBLE_SEP}\n` +
    `Active: <code>${listResult.active ?? "none"}</code>\n${SEP}\n` +
    `${lines.join("\n\n")}\n${SEP}\n` +
    `💡 Use <code>/strategy set &lt;id&gt;</code> to switch`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fmtPct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : "?";
}
