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
import { config } from "./config.js";

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
  // ================================================================
  // SPOT STRATEGIES — elite liquidity placement
  // ================================================================

  // ─── MavourG Alpha Spot ──────────────────────────────────────────
  // Source: Inspired by @MavourG's alpha calls & spot positioning style
  // Core philosophy: deploy SPOT with tight 50/50 balanced range around
  // active price. Equal distribution on both sides = capture fees on
  // every move. The "true LP" strategy that captures the spread.
  // TrackLP data: Spot WR 82% vs BidAsk 80.5%, Fee/Deposit 2.56% vs 2.08%
  mavourg_alpha_spot: {
    id: "mavourg_alpha_spot",
    name: "MavourG Alpha Spot",
    author: "@MavourG",
    author_url: "https://x.com/MavourG",
    lp_strategy: "spot",
    token_criteria: {
      min_mcap: 300_000,
      min_holders: 300,
      min_fee_tvl_ratio_4h: 0.2,
      min_volume_4h: 2_000,
      requires_narrative: true,
      requires_organic_score: true,
      notes: "Alpha-tier tokens with genuine community narrative. Prefers tokens actively discussed by @MavourG / @met_lparmy. Minimum organic volume. MavourG style: spot is the 'set and forget' LP strategy that captures fees on a trending token until the narrative shifts.",
    },
    entry: {
      condition: "Supertrend (15m) NOT bearish (neutral or bullish). RSI(2) < 80 (not overbought). Deploy SPOT strategy with balanced range: equal bins above and below active bin. Tight 20-35 bins total for concentrated fee capture.",
      single_side: null,
      balanced: true,
      indicator_preset: "rsi_plus_supertrend",
      indicator_timeframe: "15m",
      rsi_overbought_limit: 80,
      notes: "SPOT strategy = even liquidity distribution on BOTH sides of price. Not bid-ask! Token moves up → earn fees on token side. Token moves down → earn fees on SOL side. MavourG alpha play: catch the full trend while earning fees both ways.",
    },
    range: {
      type: "custom",
      bins_below_pct: 50,
      bins_above_pct: 50,
      min_bins_below: 15,
      max_bins_above: 15,
      min_total_bins: 30,
      max_total_bins: 40,
      notes: "EQUAL split: 50% bins below, 50% bins above active bin. Tight 30-40 total bins for high fee density. Equal distribution means the position earns fees symmetrically on volatility in either direction.",
    },
    exit: {
      take_profit_pct: 15,
      stop_loss_pct: 20,
      trailing_tp: true,
      max_hold_hours: 48,
      notes: "TP at +15% total return. SL if narrative dies or screening re-check fails. Trailing TP once +8% reached (40% trail). Max 48h hold then force re-evaluate. This is NOT a hold-forever strat — take profit and re-deploy on the next alpha call.",
    },
    best_for: "MavourG-style alpha spot LP on trending meme tokens with active narrative. Balanced fee capture on both price directions. Tight range for high fee density. Set-and-forget until the narrative shifts.",
    raw: "MavourG Alpha Spot by @MavourG — balanced SPOT with tight symmetrical range around active price. Equal fee capture on both sides. Source: MavourG alpha philosophy + TrackLP data (82% WR, 2.56% fee/deposit).",
  },

  // ─── Spot Sniper Elite ───────────────────────────────────────────
  // Data source: TrackLP — Spot 1-10 bins: 93% win rate, $35 median PnL
  // Smallest bin count = highest fee density = best returns
  spot_sniper_elite: {
    id: "spot_sniper_elite",
    name: "Spot Sniper Elite (1-15 bin)",
    author: "TrackLP // @Razzaer",
    author_url: "https://tracklp.com/blog/spot-vs-bidask-strategy",
    lp_strategy: "spot",
    token_criteria: {
      min_mcap: 500_000,
      min_age_days: 2,
      min_holders: 400,
      min_fee_tvl_ratio_4h: 0.5,
      min_volume_4h: 5_000,
      requires_organic_score: true,
      max_top10_holder_pct: 50,
      notes: "Elite screening for sniper plays. Only deploy on pools with strong fee generation AND organic volume. Tighter screening because sniper range = concentrated risk. Must have low top-10 concentration to avoid whale dump. TrackLP: 1-10 bin Spot = 93% WR with $35 median PnL.",
    },
    entry: {
      condition: "FOUR gates: (1) screening passes elite criteria. (2) Supertrend (15m) BULLISH (not neutral). (3) RSI(2) between 30-70 (not overbought or oversold). (4) Price just broke above resistance or consolidated >30min near current level. Deploy SPOT with ultra-tight 10-15 bins total.",
      single_side: null,
      balanced: true,
      indicator_preset: "bb_plus_rsi",
      indicator_timeframe: "15m",
      rsi_overbought_limit: 70,
      rsi_oversold_limit: 30,
      notes: "SNIPER MODE: ultra-tight range means MAX fee density per dollar deployed. Risk: price moves out of range fast. Only deploy when you have HIGH conviction the token is stable or trending. Win fast, win small, win often. TrackLP: Spot 1-10 bins = 93% WR.",
    },
    range: {
      type: "custom",
      total_bins: 10,
      bins_below_pct: 50,
      bins_above_pct: 50,
      min_bins_below: 5,
      max_bins_above: 5,
      notes: "ULTRA TIGHT: 10-15 total bins, equally split. ~5-8 bins below, ~5-7 bins above active price. This is the sniper config — highest fee density on Meteora. Price must stay in your range. 93% WR from TrackLP data on 1-10 bin spot positions.",
    },
    exit: {
      take_profit_pct: 8,
      stop_loss_pct: 10,
      trailing_tp: true,
      trailing_tp_pct: 50,
      notes: "SNIPER EXIT: (1) TP at +8% (small profit but fast). (2) SL at -10% (tight). (3) Trailing at 50% of peak once +5% reached. (4) If OOR over 5min: close immediately (do NOT wait). Sniper range means re-entry costs less than staying out of range. 93% WR means you win most — but when you lose, lose small.",
    },
    best_for: "Ultra-concentrated spot fee farming. Highest WR strategy in the library based on TrackLP data (93%). Best for tokens with low volatility that trade in a predictable range. NOT for volatile meme pumps.",
    raw: "Spot Sniper Elite — 93% win rate from TrackLP 1-10 bin Spot data. Ultra-tight 10-15 bin equal spot for maximum fee density. Source: tracklp.com/blog/spot-vs-bidask-strategy",
  },

  // ─── DeGen Spot Runner ──────────────────────────────────────────
  // For high-volatility trending memes where you want to ride the trend
  // while capturing fees. Wider range = survives pumps & dumps
  degen_spot_runner: {
    id: "degen_spot_runner",
    name: "DeGen Spot Runner (Trend Rider)",
    author: "Meridian // Community",
    lp_strategy: "spot",
    token_criteria: {
      min_mcap: 150_000,
      max_mcap: 5_000_000,
      min_volume_24h: 50_000,
      requires_narrative: true,
      notes: "HIGH VOLATILITY tokens only — minimum $50k daily volume. Strong narrative required (viral meme, KOL call, event-driven). Low mcap floor ($150k) to catch tokens early. This is the degen strat for riding pumps while earning fees. Waits for narrative confirmation before deploy.",
    },
    entry: {
      condition: "RSI(2) oversold or neutral (< 60) + Supertrend (5m/15m) bullish. Token has active X narrative. Deploy SPOT with medium-wide range (40-50 bins). Equal split above/below for fee capture on both directions. The goal: token pumps → you earn fees on the way up and sell into demand. Token dumps → buy the dip with fee earnings.",
      single_side: null,
      balanced: true,
      indicator_preset: "supertrend_break",
      indicator_timeframe: "5m",
      notes: "DEGEN RUN: deploy into momentum with wide enough range to survive volatility. Spot distribution means even fee earnings on both sides. The 'runner' part = you hold through volatility and let fees compound. Exit when the trend dies, not before.",
    },
    range: {
      type: "custom",
      bins_below_pct: 50,
      bins_above_pct: 50,
      min_bins_below: 20,
      max_bins_above: 20,
      notes: "MEDIUM-WIDE: 40-50 total bins, equally split. Wide enough to survive 10-15% price swings. Narrow enough to earn meaningful fees. The sweet spot between safety and fee density for volatile tokens.",
    },
    exit: {
      take_profit_pct: 20,
      stop_loss_pct: 30,
      trailing_tp: true,
      notes: "RUNNER EXIT: (1) TP at +20% (let winners run). (2) SL at -30% (degen = wider SL). (3) Trailing TP at 40% drop from peak once +12% reached. (4) If volume drops > 50% or narrative dies: close instead of waiting for TP. Fees compound as the trend plays out.",
    },
    best_for: "Trend-riding degen spot plays on viral meme tokens. Wide enough to survive volatility, tight enough to earn meaningful fees. Best used when you catch a token early in its narrative lifecycle.",
    raw: "DeGen Spot Runner — medium-wide spot for high-volatility trending tokens. 40-50 bin equal split. Ride the trend + earn fees on both sides.",
  },

  // ─── Yield Farmer Spot ──────────────────────────────────────────
  // For mature, lower-volatility pools where consistent fee income > speculation
  // Widest range = lowest risk = most consistent yield
  yield_farmer_spot: {
    id: "yield_farmer_spot",
    name: "Yield Farmer Spot (Conservative)",
    author: "Meridian // SteadyGrind v2",
    lp_strategy: "spot",
    token_criteria: {
      min_mcap: 1_000_000,
      min_age_days: 5,
      min_holders: 600,
      min_volume_24h: 100_000,
      min_fee_tvl_ratio_24h: 3.0,
      requires_organic_score: true,
      max_top10_holder_pct: 30,
      notes: "BLUE CHIP meme tokens only. $1M+ mcap, aged 5+ days (no fresh launches), 600+ holders. High fee generation (fee/TVL >= 3% on 24h). Top 10 holders < 30%. This filters to top ~2% of pools — genuine communities, not rugs. Designed for CAPITAL PRESERVATION with steady fee income.",
    },
    entry: {
      condition: "Only deploy if ALL screening criteria pass + token has been trading consistently for 5+ days. No narrative hype required at this stage — the metrics speak louder. Deploy SPOT with 60-80 bin wide range. Equal split above and below. This is the YIELD FARMER — you want the widest range for the lowest IL while still earning fees.",
      single_side: null,
      balanced: true,
      notes: "YIELD FARM: widest spot range for minimum impermanent loss. You earn fees on consistent volume without worrying about your range being too tight. This is as close to a 'set and forget' spot position as you can get on DLMM.",
    },
    range: {
      type: "custom",
      bins_below_pct: 50,
      bins_above_pct: 50,
      min_bins_below: 30,
      max_bins_above: 30,
      notes: "WIDE: 60-80 total bins, equally split. This covers ~15-25% price range depending on bin step. Low fee density but lowest risk of going out of range. Consistent yield over speculation.",
    },
    exit: {
      take_profit_pct: 12,
      stop_loss_pct: 20,
      max_hold_hours: 72,
      notes: "FARM EXIT: (1) TP at +12% (modest, consistent). (2) SL if fee generation drops below min_fee_tvl_ratio threshold on re-check. (3) Max 72h hold — after that, re-evaluate if token still passes screening. Do NOT hold onto dying pools. (4) If fees alone hit 8% of deployed capital: claim fees and partial withdraw 30% (lock in yield).",
    },
    best_for: "Conservative, consistent fee farming on established tokens. Lowest risk spot strategy. Perfect for the majority of your capital allocation. Designed for yield, not speculation.",
    raw: "Yield Farmer Spot — wide-range conservative spot for established tokens $1M+. Fee/TVL >= 3% 24h. 60-80 bin equal split. Capital preservation + steady yield.",
  },

  // ─── Directional Spot Pro ───────────────────────────────────────
  // For when you have a directional bias but want spot distribution
  // Tilt bins toward the expected direction
  directional_spot_pro: {
    id: "directional_spot_pro",
    name: "Directional Spot Pro (Tilted)",
    author: "Meridian // Custom Ratio v2",
    lp_strategy: "spot",
    token_criteria: {
      min_mcap: 300_000,
      min_volume_24h: 25_000,
      requires_narrative: true,
      notes: "Tokens with STRONG directional bias — either confirmed uptrend (more bins below to catch dips) or clear resistance level (more bins above to sell into strength). Requires narrative as conviction signal. More aggressive than balanced spot — this is for when you have market conviction.",
    },
    entry: {
      condition: "BULLISH BIAS: token in confirmed uptrend (Supertrend bullish, higher highs). Deploy SPOT with 70% bins BELOW / 30% bins ABOVE. More bins below = catch dips and sell into demand. BEARISH BIAS: token at resistance or overbought (RSI > 75). Deploy SPOT with 30% bins BELOW / 70% bins ABOVE. More bins above = sell into strength and buy back cheaper.",
      single_side: null,
      balanced: false,
      tilted: true,
      indicator_preset: "rsi_plus_supertrend",
      indicator_timeframe: "15m",
      notes: "DIRECTIONAL = tilt the spot distribution based on market bias. NOT a 50/50 split. More bins on the side where you expect price to consolidate. This FOCUSES fee generation on the most active price zone.",
    },
    range: {
      type: "custom",
      bins_below_pct: null, // dynamic — see entry condition
      bins_above_pct: null,
      min_bins_below: 12,
      max_bins_above: 12,
      total_bins_min: 24,
      total_bins_max: 40,
      notes: "DYNAMIC: 24-40 total bins. Tilted either 70/30 or 30/70 based on directional bias. The long side gets more bins (the side where price is expected to move). Example: bullish = 70% below (catch more dips), 30% above (sell some into pumps).",
    },
    exit: {
      take_profit_pct: 15,
      trailing_tp: true,
      re_evaluate_hours: 24,
      notes: "EXIT: (1) TP at +15%. (2) Bi-directional trailing: if bullish bias was on, trail at 50% from peak once +8% reached. (3) Re-evaluate every 24h: has the directional thesis changed? (4) If bias proves wrong (price moved opposite), close and re-deploy as balanced or opposite tilt — don't hold a failing directional thesis.",
    },
    best_for: "When you have market conviction and want to tilt fee generation toward the expected direction. More aggressive than balanced spot but more capital-efficient when your read is correct.",
    raw: "Directional Spot Pro — tilted 70/30 or 30/70 spot distribution based on market bias. Dynamic fee concentration on the expected price zone. Source: Evolved from Meridian Custom Ratio Spot.",
  },

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

  // ─── Absorption Hunter ───────────────────────────────────────
  // Author: SUPERAGENT // Berakxz
  // Core philosophy: use ABSORPTION SCORE (demand-weighted) as the primary
  // entry signal instead of classical TA. The absorption score formula:
  //   demand*0.30 + liquidity*0.20 + runner_history*0.15
  //   + smart_wallet*0.20 - price_response*0.15
  // Key insight: price_response is SUBTRACTED — tokens that already pumped
  // hard get penalized (bad entry). Demand (buy pressure) is the strongest
  // positive signal. Requires absorptionEnabled: true in config.
  absorption_hunter: {
    id: "absorption_hunter",
    name: "Absorption Hunter (Demand-Weighted Entry)",
    author: "SUPERAGENT // Berakxz",
    author_url: "https://x.com/Berakxz",
    lp_strategy: "spot",
    token_criteria: {
      min_mcap: 200000,
      min_holders: 300,
      min_fee_tvl_ratio_4h: 0.3,
      min_volume_4h: 3000,
      requires_organic_score: true,
      requires_narrative: true,
      min_absorption_score: 50,
      notes: "Core signal = ABSORPTION SCORE (demand-weighted). Token must have absorption_score.scaled >= 50 (0-100 scale). This is the only strategy that uses demand/sell pressure as the primary entry signal, not TA. The absorption score formula: demand*0.30 + liquidity*0.20 + runner_history*0.15 + smart_wallet*0.20 - price_response*0.15. Tokens that already pumped hard (high price_response) get penalized. Tokens with strong buy pressure (demand) and smart wallet presence get boosted. Requires absorptionEnabled: true in config.",
    },
    entry: {
      condition: "THREE-GATE entry, all must pass: (1) Absorption score >= 50/100. (2) demand component >= 60%. (3) price_response component <= 40%. Optional: smart_wallet component >= 50% if smart wallets are tracked.",
      single_side: null,
      balanced: true,
      indicator_preset: "rsi_plus_supertrend",
      indicator_timeframe: "15m",
      rsi_overbought_limit: 75,
      notes: "Entry is driven by ABSORPTION SCORE, not TA indicators. TA (supertrend/RSI) is a secondary confirmation only. Deploy SPOT with balanced 50/50 split. Thesis: tokens with high absorption = strong buy pressure + LP conviction + smart money present + NOT already pumped = early entry before the move.",
    },
    range: {
      type: "custom",
      bins_below_pct: 50,
      bins_above_pct: 50,
      min_bins_below: 20,
      max_bins_above: 20,
      min_total_bins: 35,
      max_total_bins: 45,
      notes: "BALANCED 50/50 spot, 35-45 total bins. Medium-tight range for good fee density. Wide enough to survive volatility, tight enough to earn meaningful fees.",
    },
    exit: {
      take_profit_pct: 10,
      stop_loss_pct: 12,
      trailing_tp: true,
      trailing_trigger_pct: 5,
      trailing_drop_pct: 2,
      max_hold_hours: 24,
      notes: "Balanced exits: (1) TP at +10%. (2) SL at -12%. (3) Trailing TP: activate at +5%, trail at 2% drop from peak. (4) Max hold 24h — absorption signals decay. (5) Re-evaluate: if absorption score drops below 30 on re-check, close regardless of PnL (signal invalidation).",
    },
    best_for: "Tokens with strong buy pressure (demand) that have NOT yet pumped significantly. Catches the accumulation phase before the move. Requires absorptionEnabled: true in config. Best paired with Darwinian learning — the system will auto-tune which absorption components predict profit.",
    raw: "Absorption Hunter by SUPERAGENT/Berakxz — demand-weighted entry using absorption score as primary signal. Entry: absorption >= 50, demand >= 60%, price_response <= 40%. Spot 50/50, 35-45 bins. TP 10%, SL 12%, trailing 5/2, max 24h. Requires absorptionEnabled: true.",
  },

  // ─── Regime Adaptive Spot ─────────────────────────────────────
  // Deterministic market-regime selection. The classifier lives in
  // regime-adaptive.js and is intentionally separate from the LLM.
  regime_adaptive_spot: {
    id: "regime_adaptive_spot",
    name: "Regime Adaptive Spot",
    author: "meridian",
    lp_strategy: "spot",
    token_criteria: {
      min_mcap: 500000,
      min_age_days: 3,
      min_holders: 500,
      min_fee_tvl_ratio_4h: 0.15,
      min_volume_24h: 5000,
      requires_organic_score: true,
      max_top10_holder_pct: 40,
      notes: "Uses deterministic regime gates. Rejects decaying, downtrending, overextended, and insufficient-data pools before the LLM can deploy.",
    },
    entry: {
      condition: "Only deploy when regime-adaptive classifier returns ACCUMULATION, RANGE, TRENDING, or HIGH_VOLATILITY and all screening gates pass.",
      balanced: false,
      indicator_preset: "rsi_plus_supertrend",
      indicator_timeframe: "15m",
      notes: "The range plan is selected from observed volatility, fee trend, volume trend, price response, and absorption score.",
    },
    range: {
      type: "dynamic",
      notes: "ACCUMULATION 24/16, RANGE 20/20, TRENDING 28/12, HIGH_VOLATILITY 55/25 bins below/above.",
    },
    exit: {
      take_profit_pct: 8,
      stop_loss_pct: -15,
      trailing_tp: true,
      trailing_trigger_pct: 4,
      trailing_drop_pct: 1.5,
      out_of_range_wait_minutes: 15,
      max_hold_hours: 72,
      notes: "Snapshot these values at deployment. Re-evaluate rather than blindly reseeding after OOR.",
    },
    best_for: "Defensive DLMM operation across changing market regimes; prioritizes avoiding bad entries over maximizing deployment frequency.",
    raw: "Regime Adaptive Spot — deterministic regime gates and dynamic range selection.",
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
    if (!db.active) db.active = "mavourg_alpha_spot";
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
const USER_CONFIG_PATH = repoPath("user-config.json");

export function setActiveStrategy({ id }) {
  if (!id) return { error: "id required" };
  const db = load();
  if (!db.strategies[id]) return { error: `Strategy "${id}" not found`, available: Object.keys(db.strategies) };
  db.active = id;
  save(db);

  // Auto-sync deploy strategy type from library to live config + user-config.json
  const strat = db.strategies[id];
  const deployType = strat.lp_strategy; // "spot", "bid_ask", "curve"
  const supported = ["spot", "bid_ask", "curve"];
  if (supported.includes(deployType) && config.strategy.strategy !== deployType) {
    config.strategy.strategy = deployType;
    // Persist to user-config.json
    try {
      let ucfg = {};
      if (fs.existsSync(USER_CONFIG_PATH)) {
        ucfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      }
      ucfg.strategy = deployType;
      fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(ucfg, null, 2));
      log("strategy", `Auto-synced config.strategy.strategy → ${deployType} (from library strategy: ${strat.name})`);
    } catch (e) {
      log("strategy_warn", `Could not persist strategy to user-config.json: ${e.message}`);
    }
  }

  log("strategy", `Active strategy set to: ${strat.name} (lp_strategy: ${deployType})`);
  return { active: id, name: strat.name, deployType };
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
