/**
 * Multi-Strategy Portfolio Engine
 *
 * Allows running MULTIPLE strategies simultaneously with allocation percentages.
 * Each screening cycle picks the next strategy in the rotation.
 *
 * Config format (user-config.json):
 * "portfolio": [
 *   { "id": "mavourg_alpha_spot", "allocation": 40, "maxPositions": 2 },
 *   { "id": "evil_panda_strat",   "allocation": 30, "maxPositions": 2 },
 *   { "id": "degen_spot_runner",  "allocation": 30, "maxPositions": 1 }
 * ]
 */
import fs from "fs";
import { config, repoPath } from "./config.js";
import { log } from "./logger.js";
import { getActiveStrategy, setActiveStrategy } from "./strategy-library.js";

const ROTATION_STATE_FILE = repoPath("portfolio-rotation.json");

let rotationState = { index: 0, cycle: 0 };
try {
  rotationState = JSON.parse(fs.readFileSync(ROTATION_STATE_FILE, "utf8"));
} catch {}

function saveRotation() {
  try {
    fs.writeFileSync(ROTATION_STATE_FILE, JSON.stringify(rotationState, null, 2));
  } catch {}
}

/**
 * Get the full portfolio config or null if not configured.
 */
export function getPortfolio() {
  return config.portfolio?.length > 0 ? config.portfolio : null;
}

/**
 * Check if portfolio mode is active.
 */
export function isPortfolioMode() {
  return config.portfolio?.length > 1;
}

/**
 * Pick and activate the next strategy in the portfolio rotation.
 * Returns { id: string, name: string, strategy: string } or null if not in portfolio mode.
 */
export function rotatePortfolio() {
  const portfolio = getPortfolio();
  if (!portfolio) return null;

  const currentItem = portfolio[rotationState.index];
  rotationState.index = (rotationState.index + 1) % portfolio.length;
  rotationState.cycle++;
  saveRotation();

  const nextItem = portfolio[rotationState.index];

  // Activate the strategy
  const result = setActiveStrategy({ id: nextItem.id });

  log("portfolio", `Rotated to strategy #${rotationState.index + 1}/${portfolio.length}: ${nextItem.id} (cycle ${rotationState.cycle})`);

  return {
    active: result.active,
    name: result.name,
    deployType: result.deployType,
    allocation: nextItem.allocation,
    maxPositions: nextItem.maxPositions ?? config.risk.maxPositions,
    index: rotationState.index,
    cycle: rotationState.cycle,
    total: portfolio.length,
  };
}

/**
 * Get the current portfolio strategy info.
 */
export function getCurrentPortfolioInfo() {
  const portfolio = getPortfolio();
  if (!portfolio) return null;

  const currentItem = portfolio[rotationState.index];
  return {
    index: rotationState.index,
    cycle: rotationState.cycle,
    total: portfolio.length,
    current: currentItem,
    next: portfolio[(rotationState.index + 1) % portfolio.length],
  };
}

/**
 * Format portfolio status for display.
 */
export function formatPortfolioStatus() {
  const portfolio = getPortfolio();
  if (!portfolio) return "No portfolio configured — using single strategy mode";

  const active = getActiveStrategy();
  const info = getCurrentPortfolioInfo();

  const lines = [
    `Portfolio: ${info.total} strategies | cycle ${info.cycle}`,
    `Active: ${info.current.id} (${info.current.allocation}%)`,
    `Next: ${info.next.id} (${info.next.allocation}%)`,
    "",
    "All strategies:",
    ...portfolio.map((item, i) => {
      const active_ = info.index === i ? " ← active" : "";
      return `  ${i + 1}. ${item.id} — ${item.allocation}%${active_}`;
    }),
    ...(active ? [`\nDeploy type: ${active.is_active}`, `Config strategy: ${config.strategy.strategy}`] : []),
  ];

  return lines.join("\n");
}
