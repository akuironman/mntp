/**
 * DLMM Additions — addLiquidityToPosition & Jito bundle helpers
 * Extends dlmm.js without modifying the monster file.
 */

import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import BN from "bn.js";
import bs58 from "bs58";
import { config, repoPath } from "../config.js";
import { log } from "../logger.js";

let _DLMM = null;
let _StrategyType = null;
async function getSDK() {
  if (!_DLMM) {
    const mod = await import("@meteora-ag/dlmm");
    _DLMM = mod.default;
    _StrategyType = mod.StrategyType;
  }
  return { DLMM: _DLMM, StrategyType: _StrategyType };
}

let _connection = null;
function getConnection() {
  if (!_connection) _connection = new Connection(process.env.RPC_URL, "confirmed");
  return _connection;
}

let _wallet = null;
function getWallet() {
  if (!_wallet) {
    if (!process.env.WALLET_PRIVATE_KEY) throw new Error("WALLET_PRIVATE_KEY not set");
    _wallet = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY));
  }
  return _wallet;
}

const poolCache = new Map();
async function getPool(poolAddress) {
  const key = poolAddress.toString();
  if (!poolCache.has(key)) {
    const { DLMM } = await getSDK();
    const pool = await DLMM.create(getConnection(), new PublicKey(poolAddress));
    poolCache.set(key, pool);
  }
  return poolCache.get(key);
}

/**
 * Add more liquidity to an existing DLMM position.
 *
 * @param {Object} params
 * @param {string} params.pool_address - Pool address (mint-normalized)
 * @param {string} params.position_address - Existing position address
 * @param {number} params.amount_sol - SOL amount to add (as Y/quote)
 * @param {number} [params.amount_x=0] - Token X amount to add
 * @param {"spot"|"bid_ask"|"curve"} [params.strategy="spot"] - Strategy for distribution
 * @param {number} [params.slippage=100] - Slippage in bps
 * @returns {Promise<{success: boolean, txs: string[], error?: string}>}
 */
export async function addLiquidityToPosition({
  pool_address,
  position_address,
  amount_sol,
  amount_x = 0,
  strategy = "spot",
  slippage = 100,
}) {
  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_add: { pool_address, position_address, amount_sol, amount_x },
      message: "DRY RUN — no transaction sent",
    };
  }

  const wallet = getWallet();
  const poolPubkey = new PublicKey(pool_address);
  const posPubkey = new PublicKey(position_address);
  const pool = await getPool(poolPubkey);
  const { StrategyType } = await getSDK();

  const strategyMap = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };
  const strategyType = strategyMap[strategy] || StrategyType.Spot;

  const totalYLamports = new BN(Math.floor(Number(amount_sol) * 1e9));
  let totalXLamports = new BN(0);
  if (Number(amount_x) > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(Number(amount_x) * Math.pow(10, decimals)));
  }

  log("add_liquidity", `Adding ${amount_sol} SOL + ${amount_x} X to position ${position_address.slice(0, 8)} (strategy: ${strategy})`);

  const txs = await pool.addLiquidityByStrategy({
    positionPubKey: posPubkey,
    user: wallet.publicKey,
    totalXAmount: totalXLamports,
    totalYAmount: totalYLamports,
    strategy: { strategyType },
    slippage,
  });

  const txArray = Array.isArray(txs) ? txs : [txs];
  const txHashes = [];
  for (const tx of txArray) {
    const hash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
    txHashes.push(hash);
  }

  log("add_liquidity", `SUCCESS — ${txHashes.length} tx(s): ${txHashes[0]}`);
  return { success: true, txs: txHashes, amount_sol, amount_x };
}

/**
 * Add chunkable liquidity to a wide-range existing position (>69 bins).
 */
export async function addLiquidityChunkable({
  pool_address,
  position_address,
  amount_sol,
  amount_x = 0,
  strategy = "spot",
  slippage = 10,
}) {
  if (process.env.DRY_RUN === "true") {
    return {
      dry_run: true,
      would_add: { pool_address, position_address, amount_sol, amount_x, note: "wide range chunkable" },
      message: "DRY RUN — no transaction sent",
    };
  }

  const wallet = getWallet();
  const poolPubkey = new PublicKey(pool_address);
  const posPubkey = new PublicKey(position_address);
  const pool = await getPool(poolPubkey);
  const { StrategyType } = await getSDK();

  const strategyMap = {
    spot: StrategyType.Spot,
    curve: StrategyType.Curve,
    bid_ask: StrategyType.BidAsk,
  };
  const strategyType = strategyMap[strategy] || StrategyType.Spot;

  const totalYLamports = new BN(Math.floor(Number(amount_sol) * 1e9));
  let totalXLamports = new BN(0);
  if (Number(amount_x) > 0) {
    const mintInfo = await getConnection().getParsedAccountInfo(new PublicKey(pool.lbPair.tokenXMint));
    const decimals = mintInfo.value?.data?.parsed?.info?.decimals ?? 9;
    totalXLamports = new BN(Math.floor(Number(amount_x) * Math.pow(10, decimals)));
  }

  log("add_liquidity", `Chunkable add to ${position_address.slice(0, 8)}: ${amount_sol} SOL`);

  const addTxs = await pool.addLiquidityByStrategyChunkable({
    positionPubKey: posPubkey,
    user: wallet.publicKey,
    totalXAmount: totalXLamports,
    totalYAmount: totalYLamports,
    strategy: { strategyType },
    slippage,
  });

  const txArray = Array.isArray(addTxs) ? addTxs : [addTxs];
  const txHashes = [];
  for (const tx of txArray) {
    const hash = await sendAndConfirmTransaction(getConnection(), tx, [wallet]);
    txHashes.push(hash);
  }

  log("add_liquidity", `SUCCESS — ${txHashes.length} chunkable tx(s)`);
  return { success: true, txs: txHashes, amount_sol, amount_x };
}
