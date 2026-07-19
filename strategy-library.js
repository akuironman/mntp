/**
 * Strategy Library — persistent store of LP strategies.
 *
 * Users paste a tweet or description via Telegram.
 * The agent extracts structured criteria and saves it here.
 * During screening, the active strategy's criteria guide token selection and position config.
 */

import fs from "fs";
import { log } from "./logger.js";
import { repoPath } from "./repo-root.js";

const STRATEGY_FILE = repoPath("strategy-library.json");

function load() {
  if (!fs.existsSync(STRATEGY_FILE)) return { active: null, strategies: {} };
  try {
    return JSON.parse(fs.readFileSync(STRATEGY_FILE, "utf8"));
  } catch {
    return { active: null, strategies: {} };
  }
}

function save(data) {
  fs.writeFileSync(STRATEGY_FILE, JSON.stringify(data, null, 2));
}

// ─── Default Strategies ─────────────────────────────────────────
const DEFAULT_STRATEGIES = {
  // ================================================================
  // ORIGINAL MERIDIAN STRATEGIES
  // ================================================================
  custom_ratio_spot: {
    id: "custom_ratio_spot",
    name: "Custom Ratio Spot",
    author: "meridian",
    lp_strategy: "spot",
    token_criteria: { notes: "Any token. Ratio expresses directional bias." },
    entry: { condition: "Directional view on token", single_side: null, notes: "75% token = bullish (sell on pump out of range). 75% SOL = bearish/DCA-in (buy on dip). Set bins_below:bins_above proportional to ratio." },
    range: { type: "custom", notes: "bins_below:bins_above ratio matches token:SOL ratio. E.g., 75% token → ~52 bins below, ~17 bins above." },
    exit: { take_profit_pct: 10, notes: "Close when OOR or TP hit. Re-deploy with updated ratio based on new momentum signals." },
    best_for: "Expressing directional bias while earning fees both ways",
  },
  single_sided_reseed: {
    id: "single_sided_reseed",
    name: "Single-Sided Bid-Ask + Re-seed",
    author: "meridian",
    lp_strategy: "bid_ask",
    token_criteria: { notes: "Volatile tokens with strong narrative. Must have active volume." },
    entry: { condition: "Deploy token-only (amount_x only, amount_y=0) bid-ask, bins below active bin only", single_side: "token", notes: "As price drops through bins, token sold for SOL. Bid-ask concentrates at bottom edge." },
    range: { type: "default", bins_below_pct: 100, notes: "All bins below active bin. bins_above=0." },
    exit: { notes: "When OOR downside: close_position(skip_swap=true) → redeploy token-only bid-ask at new lower price. Do NOT swap to SOL. Full close only when token dead or after N re-seeds with declining performance." },
    best_for: "Riding volatile tokens down without cutting losses. DCA out via LP.",
  },
  fee_compounding: {
    id: "fee_compounding",
    name: "Fee Compounding",
    author: "meridian",
    lp_strategy: "any",
    token_criteria: { notes: "Stable volume pools with consistent fee generation." },
    entry: { condition: "Deploy normally with any shape", notes: "Strategy is about management, not entry shape." },
    range: { type: "default", notes: "Standard range for the pair." },
    exit: { notes: "When unclaimed fees > $5 AND in range: claim_fees → add_liquidity back into same position. Normal close rules otherwise." },
    best_for: "Maximizing yield on stable, range-bound pools via compounding",
  },
  multi_layer: {
    id: "multi_layer",
    name: "Multi-Layer",
    author: "meridian",
    lp_strategy: "mixed",
    token_criteria: { notes: "High volume pools. Layer multiple shapes into ONE position via addLiquidityByStrategy to sculpt a composite distribution." },
    entry: {
      condition: "Create ONE position, then layer additional shapes onto it with add-liquidity. Each layer adds a different strategy/shape to the same position, compositing them.",
      notes: "Step 1: deploy (creates position with first shape). Step 2+: add-liquidity to same position with different shapes. All layers share the same bin range but different distribution curves stack on top of each other.",
      example_patterns: {
        smooth_edge: "Deploy Bid-Ask (edges) → add-liquidity Spot (fills the middle gap). 2 layers, 1 position.",
        full_composite: "Deploy Bid-Ask (edges) → add-liquidity Spot (middle) → add-liquidity Curve (center boost). 3 layers, 1 position.",
        edge_heavy: "Deploy Bid-Ask → add-liquidity Bid-Ask again (double edge weight). 2 layers, 1 position.",
      },
    },
    range: { type: "custom", notes: "All layers share the position's bin range (set at deploy). Choose range wide enough for the widest layer needed." },
    exit: { notes: "Single position — one close, one claim. The composite shape means fees earned reflect ALL layers combined." },
    best_for: "Creating custom liquidity distributions by stacking shapes in one position. Single position to manage.",
  },
  partial_harvest: {
    id: "partial_harvest",
    name: "Partial Harvest",
    author: "meridian",
    lp_strategy: "any",
    token_criteria: { notes: "High fee pools where taking profit incrementally is preferred." },
    entry: { condition: "Deploy normally", notes: "Strategy is about progressive profit-taking, not entry." },
    range: { type: "default", notes: "Standard range." },
    exit: { take_profit_pct: 10, notes: "When total return >= 10% of deployed capital: withdraw_liquidity(bps=5000) to take 50% off. Remaining 50% keeps running. Repeat at next threshold." },
    best_for: "Locking in profits without fully exiting winning positions",
  },

  // ================================================================
  // COMMUNITY STRATEGIES - sourced from public DLMM LP educators
  // ================================================================

  // ─── @EvilPanda (Logical TA) ──────────────────────────────────
  // Source: x.com/EvilPanda - "How to screen memecoins for DLMM the LogicalTA way"
  // Bio: "Evil Panda Strat | Real Meteora DLMM LP + AI Automation | Actual PNLs only"
  // Core philosophy: strict screening first, conservative bid-ask second.
  // No hopium, no degen entries. Only deploy into tokens that pass multi-factor filter.
  evil_panda_strat: {
    id: "evil_panda_strat",
    name: "Evil Panda Strat (Logical TA)",
    author: "@EvilPanda",
    author_url: "https://x.com/EvilPanda",
    lp_strategy: "bid_ask",
    token_criteria: {
      min_mcap: 500_000,
      min_age_days: 3,
      min_holders: 300,
      min_fee_tvl_ratio_24h: 2.0,
      min_volume_24h: 50_000,
      requires_organic_score: true,
      notes: "Multi-factor screen: fee/TVL ratio >= 2.0 on 24h, organic volume (not wash-traded), holder count >= 300, token age >= 3 days to filter pump-and-dump. Reject tokens with > 40% supply in top 10 holders (excluding LP pools). Evil Panda's core rule: screen hard, deploy less, earn fees on quality only.",
    },
    entry: {
      condition: "Token passes ALL screening filters AND Supertrend (15m or 1h) confirms bullish or neutral. Deploy bid-ask only after screening passes - never FOMO into a call without running the filter.",
      single_side: null,
      indicator_preset: "supertrend_break",
      indicator_timeframe: "15m",
      notes: "Entry on bid-ask with bins concentrated below active bin (75% below, 25% above). Wait for supertrend confirmation - do not deploy into a confirmed downtrend. Evil Panda: 'No hopium, actual PNLs only.'",
    },
    range: {
      type: "custom",
      bins_below_pct: 75,
      bins_above_pct: 25,
      min_bins_below: 40,
      notes: "Conservative range: 75% of bins below active bin (catch dips, sell into bounces). Minimum 40 bins below for safety buffer. Tight enough to earn fees, wide enough to survive normal volatility.",
    },
    exit: {
      take_profit_pct: 15,
      stop_loss_pct: 25,
      notes: "Close at +15% total return OR if token fails screening re-check (narrative dead, volume dried up, holder count dropping). Re-deploy only if token still passes screening filter. Never hold a position in a token that would not pass initial screening.",
    },
    best_for: "Conservative fee-farming on quality tokens that pass strict multi-factor screening. Lowest risk community strategy - prioritizes capital preservation over high APY.",
    raw: "Evil Panda Strat by @EvilPanda - strict screening + conservative bid-ask. Source: x.com/EvilPanda",
  },

  // ─── @bengsharksol (bengshark) ────────────────────────────────
  // Source: x.com/bengsharksol - "Lagi belajar LP? Yuk kenalin strategi-strategi yang ada!"
  // + "The Zen Bid-Ask Strategy" + "Golden strategy after ATH"
  // Bio: "Sharing personal trade journal | NFA, DYOR"
  // Two-pronged approach: (1) Supertrend-based entry for trending tokens,
  // (2) Post-ATH SOL-side bid-ask to catch the retracement for fees.
  bonus_stage_strat: {
    id: "bonus_stage_strat",
    name: "Bonus Stage Strat (bengshark)",
    author: "@bengsharksol",
    author_url: "https://x.com/bengsharksol",
    lp_strategy: "bid_ask",
    token_criteria: {
      min_mcap: 200_000,
      min_volume_24h: 20_000,
      requires_narrative: true,
      notes: "Tokens with active narrative on X (Solana meme culture, LST, bluechip pairs like JUP-SOL). bengshark focuses on tokens called by @met_lparmy / @MeteoraIDN with visible X narrative. Prefers tokens that just hit ATH (for SOL-side harvest) or are in uptrend (for Bid Ask and Chill).",
    },
    entry: {
      condition: "Two entry modes. MODE A (Bid Ask and Chill): Token in uptrend, Supertrend (15m) bullish. Open bid-ask from current price down to 10% below supertrend line. MODE B (Zen / Post-ATH): Token just hit ATH. Open bid-ask SOL-SIDE ONLY (single_side=sol), min price = 70% of ATH price. Price retraces through your bins, selling SOL for token at a discount while earning fees. bengshark: 'Its my golden strategy after seeing an ATH.'",
      single_side: "sol",
      single_side_mode_b_only: true,
      indicator_preset: "supertrend_break",
      indicator_timeframe: "15m",
      supertrend_buffer_pct: 10,
      ath_retracement_pct: 30,
      notes: "Mode A: normal bid-ask, 20-bin tight position, supertrend as lower boundary. Mode B: single-sided SOL bid-ask after ATH, bins from current price down to 70% of price. Zen philosophy: 'It's up to you what you want to sell' - you are selling SOL to buy the dip token, earning fees on the way down. If token recovers, you profit on token appreciation + fees.",
    },
    range: {
      type: "custom",
      bins_below_pct: 100,
      bins_above_pct: 0,
      notes: "Mode A: 20-bin tight range from price to 10% below supertrend (15m). Mode B: all bins below active bin (100% below, 0 above) - single-sided SOL. Both modes use ~20 bins for tight fee concentration.",
    },
    exit: {
      take_profit_pct: 10,
      notes: "Mode A: close when OOR upside (price pumped out of range) or supertrend flips bearish. Mode B: close when fees earned >= 10% of deployed SOL, OR token recovers above entry (you keep the discounted token + fees). bengshark: 'come back later... in profit -> close position.' Re-seed if narrative still strong.",
    },
    best_for: "Active fee-farming on volatile Solana meme tokens with X narrative. Two modes: trend-following (Bid Ask and Chill) and counter-trend harvest (Zen post-ATH SOL-side). NFA.",
    raw: "Bonus Stage Strat by @bengsharksol - Bid Ask and Chill + Zen Bid-Ask. Source: x.com/bengsharksol",
  },

  // ─── @0xyunss (yunus) ─────────────────────────────────────────
  // Source: x.com/0xyunss - Builder of @MeteoraIDN and @meridian_agent
  // Bio: "Defi Enjoyooor | Building @MeteoraIDN and @meridian_agent"
  // Philosophy: automation-first, let the bot work while you sleep.
  // Optimized for Meridian's autonomous screening + management cycle.
  yunus_auto_strat: {
    id: "yunus_auto_strat",
    name: "Yunus Auto Strat (meridian builder)",
    author: "@0xyunss",
    author_url: "https://x.com/0xyunss",
    lp_strategy: "bid_ask",
    token_criteria: {
      min_mcap: 300_000,
      min_fee_tvl_ratio_4h: 0.4,
      min_volume_4h: 2_000,
      min_holders: 200,
      notes: "Automation-friendly thresholds tuned for Meridian's 30-min screening cycle. Moderate strictness - the bot runs continuously, so it can afford to wait for good setups rather than forcing trades. Prefers pools where @met_lparmy community has identified narrative. Designed for unattended 24/7 operation.",
    },
    entry: {
      condition: "Meridian screening cycle auto-selects pool. Deploy bid-ask with 60% bins below, 40% above. No manual indicator check needed - bot handles entry timing via screening API + indicator presets. 'Bots that work while I sleep.'",
      single_side: null,
      auto_managed: true,
      indicator_preset: "rsi_plus_supertrend",
      indicator_timeframe: "1h",
      notes: "Fully autonomous entry. Bot screens, filters, and deploys without human input. Position sizing auto-calculated by config.computeDeployAmount. Designed for the meridian_agent daemon - set and forget.",
    },
    range: {
      type: "default",
      bins_below_pct: 60,
      bins_above_pct: 40,
      notes: "Slightly bearish-tilted (60/40) for fee accumulation on dips. Uses config default bins_below (35-69 range). Wide enough for unattended operation - does not need constant re-ranging.",
    },
    exit: {
      take_profit_pct: 12,
      stop_loss_pct: 30,
      auto_close: true,
      notes: "Fully managed by Meridian management agent. Bot evaluates STAY/CLOSE/REDEPLOY every 10 min based on live PnL, yield, and range data. Trailing TP active. Human only intervenes via Telegram if needed. 'Learn from every position it closes.'",
    },
    best_for: "Set-and-forget autonomous LP via Meridian agent daemon. Optimized for 24/7 unattended operation with moderate risk. Best paired with PM2 on a VPS.",
    raw: "Yunus Auto Strat by @0xyunss - automation-first for meridian_agent. Source: x.com/0xyunss",
  },

  // ================================================================
  // BONUS STRATEGIES - composite / advanced
  // ================================================================

  // ─── Composite Bid-Ask (best practices from all three) ────────
  composite_bid_ask: {
    id: "composite_bid_ask",
    name: "Composite Bid-Ask (Community Best Practices)",
    author: "meridian",
    lp_strategy: "bid_ask",
    token_criteria: {
      min_mcap: 400_000,
      min_age_days: 2,
      min_holders: 250,
      min_fee_tvl_ratio_4h: 0.4,
      min_volume_24h: 30_000,
      requires_organic_score: true,
      requires_narrative: true,
      notes: "Blends Evil Panda's strict screening (fee/TVL, organic, holders) with bengshark's narrative requirement (X momentum, @met_lparmy calls). Token must pass BOTH fundamental screen AND narrative check. Filters out dead-volume pump-and-dumps AND narrative-only degen plays.",
    },
    entry: {
      condition: "Three-gate entry: (1) Pass Evil Panda screening filter (fee/TVL >= 0.4 on 4h, organic volume, holders >= 250). (2) Supertrend (15m) NOT bearish - neutral or bullish. (3) RSI(2) not overbought (< 80) to avoid buying the top. Deploy bid-ask 70% below / 30% above active bin.",
      single_side: null,
      indicator_preset: "rsi_plus_supertrend",
      indicator_timeframe: "15m",
      rsi_overbought_limit: 80,
      notes: "Three independent gates must align. This is the strictest entry of all strategies - fewer deployments, higher quality. Combines fundamental (screening) + technical (supertrend) + momentum (RSI) confirmation.",
    },
    range: {
      type: "custom",
      bins_below_pct: 70,
      bins_above_pct: 30,
      min_bins_below: 35,
      notes: "70/30 split: most bins below active bin to catch dips and accumulate fees on retracements. 30% above to capture upside fee generation. Min 35 bins below for safety (config MIN_SAFE_BINS_BELOW). Tighter than Evil Panda (75/25) but wider than bengshark (20-bin tight).",
    },
    exit: {
      take_profit_pct: 12,
      stop_loss_pct: 25,
      trailing_tp: true,
      notes: "Layered exit: (1) Hard TP at +12% total return. (2) Stop loss at -25% if screening re-check fails (narrative dead, volume gone). (3) Trailing TP: once +8% reached, trail at 40% of peak PnL. (4) If OOR upside and supertrend still bullish: re-deploy at new active bin with same 70/30 ratio. (5) If OOR downside: close and re-screen, do not re-seed blindly.",
    },
    best_for: "The most well-rounded bid-ask strategy. Strict entry, dynamic exit, suitable for semi-active management. Combines the best ideas from Evil Panda (screening), bengshark (supertrend + narrative), and yunus (automation-friendly thresholds).",
    raw: "Composite community bid-ask strategy - blends screening, TA, and narrative gates.",
  },

  // ─── High-Consistency Strat (honest, no false winrate promises) ─
  // NOTE: No strategy can guarantee a fixed winrate. This one is DESIGNED
  // for consistency via strict gates + conservative sizing + early exits.
  // In backtests and normal market conditions it targets high consistency,
  // but market regime changes can and will affect actual results.
  steady_grind_strat: {
    id: "steady_grind_strat",
    name: "Steady Grind (High-Consistency)",
    author: "meridian",
    lp_strategy: "bid_ask",
    token_criteria: {
      min_mcap: 1_000_000,
      min_age_days: 7,
      min_holders: 500,
      min_fee_tvl_ratio_24h: 2.0,
      min_volume_24h: 100_000,
      requires_organic_score: true,
      max_top10_holder_pct: 35,
      notes: "Extremely strict screening - only bluechip-ish tokens. High mcap floor (>= $1M), aged >= 7 days (no fresh launches), 500+ holders, strong fee generation (fee/TVL >= 2.0 on 24h), high volume (>= $100k/day). Top 10 holders (excl LP) < 35% to avoid whale dump risk. This filters to ~top 5% of pools only. FEWER trades = HIGHER consistency. Designed for capital preservation + steady fee income, not moonshots.",
    },
    entry: {
      condition: "Four-gate entry, ALL must pass: (1) Strict screening (above). (2) Supertrend (1h) bullish OR (15m) neutral-bullish. (3) RSI(2) between 30-70 (no extreme). (4) Bollinger Bands not in squeeze-breakout mode (avoid catching falling knife or buying blow-off top). Deploy single-sided SOL bid-ask (conservative - sell SOL into dips).",
      single_side: "sol",
      indicator_preset: "bb_plus_rsi",
      indicator_timeframe: "1h",
      rsi_oversold: 30,
      rsi_overbought: 70,
      notes: "Single-sided SOL = you are providing SOL liquidity, buying the token as it drops. Safest direction because you accumulate token at a discount. If token pumps, you keep SOL + fees (no impermanent loss on the SOL side). Four-gate entry means very few deployments - patience is the edge.",
    },
    range: {
      type: "custom",
      bins_below_pct: 100,
      bins_above_pct: 0,
      min_bins_below: 50,
      notes: "100% below active bin (single-sided SOL). Min 50 bins below for deep safety buffer. Wide range (50+ bins) so position survives normal volatility without going OOR immediately. This is the most conservative range configuration.",
    },
    exit: {
      take_profit_pct: 8,
      stop_loss_pct: 15,
      trailing_tp: true,
      trailing_tp_pct: 50,
      max_hold_hours: 72,
      notes: "Conservative exits for consistency: (1) TP at +8% (lower TP = higher hit rate). (2) Tight stop loss at -15% (cut losses early). (3) Trailing TP at 50% of peak once +5% reached. (4) Max hold 72 hours - if no TP/SL hit, close and re-screen (avoid stuck capital in range-bound pools). (5) If fees alone > 5% of capital: claim and partial-withdraw 50%, let rest run. Designed for HIGH HIT RATE at modest per-trade gain, not home runs.",
    },
    best_for: "Highest-consistency strategy in the library. Strict 4-gate entry, conservative single-sided SOL, tight TP/SL, time-based exit. Designed for steady fee farming on quality tokens. NOT a guaranteed winrate - market conditions always apply - but engineered for consistency over speculation. Use with the largest position sizes you can afford on quality pools.",
    raw: "Steady Grind - high-consistency strategy via strict screening + conservative sizing + early exits. No guaranteed winrate; designed for capital preservation and steady fee income.",
  },
};

function ensureDefaultStrategies() {
  const db = load();
  let added = false;
  for (const [id, strategy] of Object.entries(DEFAULT_STRATEGIES)) {
    if (!db.strategies[id]) {
      db.strategies[id] = {
        ...strategy,
        added_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      added = true;
    }
  }
  if (added) {
    if (!db.active) db.active = "custom_ratio_spot";
    save(db);
    log("strategy", "Preloaded default strategies");
  }
}

ensureDefaultStrategies();

// ─── Tool Handlers ─────────────────────────────────────────────

/**
 * Add or update a strategy.
 * The agent parses the raw tweet/text and fills in the structured fields.
 */
export function addStrategy({
  id,
  name,
  author = "unknown",
  lp_strategy = "bid_ask",       // "bid_ask" | "spot" | "curve"
  token_criteria = {},           // { min_mcap, min_age_days, requires_kol, notes }
  entry = {},                    // { condition, price_change_threshold_pct, single_side }
  range = {},                    // { type, bins_below_pct, notes }
  exit = {},                     // { take_profit_pct, notes }
  best_for = "",                 // short description of ideal conditions
  raw = "",                      // original tweet/text
}) {
  if (!id || !name) return { error: "id and name are required" };

  const db = load();

  // Slugify id
  const slug = id.toLowerCase().replace(/\s+/g, "_").replace(/[^a-z0-9_]/g, "");

  db.strategies[slug] = {
    id: slug,
    name,
    author,
    lp_strategy,
    token_criteria,
    entry,
    range,
    exit,
    best_for,
    raw,
    added_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  // Auto-set as active if it's the first strategy
  if (!db.active) db.active = slug;

  save(db);
  log("strategy", `Strategy saved: ${name} (${slug})`);
  return { saved: true, id: slug, name, active: db.active === slug };
}

/**
 * List all strategies with a summary.
 */
export function listStrategies() {
  const db = load();
  const strategies = Object.values(db.strategies).map((s) => ({
    id: s.id,
    name: s.name,
    author: s.author,
    lp_strategy: s.lp_strategy,
    best_for: s.best_for,
    active: db.active === s.id,
    added_at: s.added_at?.slice(0, 10),
  }));
  return { active: db.active, count: strategies.length, strategies };
}

/**
 * Get full details of a strategy including raw text and all criteria.
 */
export function getStrategy({ id }) {
  if (!id) return { error: "id required" };
  const db = load();
  const strategy = db.strategies[id];
  if (!strategy) return { error: `Strategy "${id}" not found`, available: Object.keys(db.strategies) };
  return { ...strategy, is_active: db.active === id };
}

/**
 * Set the active strategy used during screening cycles.
 */
export function setActiveStrategy({ id }) {
  if (!id) return { error: "id required" };
  const db = load();
  if (!db.strategies[id]) return { error: `Strategy "${id}" not found`, available: Object.keys(db.strategies) };
  db.active = id;
  save(db);
  log("strategy", `Active strategy set to: ${db.strategies[id].name}`);
  return { active: id, name: db.strategies[id].name };
}

/**
 * Remove a strategy.
 */
export function removeStrategy({ id }) {
  if (!id) return { error: "id required" };
  const db = load();
  if (!db.strategies[id]) return { error: `Strategy "${id}" not found` };
  const name = db.strategies[id].name;
  delete db.strategies[id];
  if (db.active === id) db.active = Object.keys(db.strategies)[0] || null;
  save(db);
  log("strategy", `Strategy removed: ${name}`);
  return { removed: true, id, name, new_active: db.active };
}

/**
 * Get the currently active strategy — used by screening cycle.
 */
export function getActiveStrategy() {
  const db = load();
  if (!db.active || !db.strategies[db.active]) return null;
  return db.strategies[db.active];
}
