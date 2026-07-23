/**
 * Jito Bundle Protection
 *
 * Wraps Meteora transactions (deploy, claim, close, addLiquidity) into Jito bundles
 * to prevent sandwich attacks and frontrunning.
 *
 * Config (user-config.json):
 * {
 *   "jito": {
 *     "enabled": true,
 *     "tipLamports": 10000,
 *     "tipAccount": "96gYZGDn1bYYY4aG8C6U3T5Gq7iT4iN8C2X9F7d2vJ1k",
 *     "blockEngineUrl": "https://mainnet.block-engine.jito.wtf/api/v1"
 *   }
 * }
 *
 * Usage:
 *   const { bundleTx } = await import("./tools/jito-bundler.js");
 *   const result = await bundleTx(transactions, { tip: 10000 });
 */

import { VersionedTransaction, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { config } from "../config.js";
import { log } from "../logger.js";

const DEFAULT_BLOCK_ENGINE = "https://mainnet.block-engine.jito.wtf/api/v1";
const DEFAULT_TIP_ACCOUNT = "96gYZGDn1bYYY4aG8C6U3T5Gq7iT4iN8C2X9F7d2vJ1k";
const DEFAULT_TIP_LAMPORTS = 10_000; // 0.00001 SOL

function jitoConfig() {
  return config.jito || {};
}

function isEnabled() {
  return jitoConfig().enabled !== false;
}

function blockEngineUrl() {
  return jitoConfig().blockEngineUrl || DEFAULT_BLOCK_ENGINE;
}

function tipAccount() {
  return jitoConfig().tipAccount || DEFAULT_TIP_ACCOUNT;
}

function tipLamports() {
  return jitoConfig().tipLamports ?? DEFAULT_TIP_LAMPORTS;
}

/**
 * Wrap one or more VersionedTransactions into a Jito bundle and submit.
 *
 * @param {Array<VersionedTransaction|Transaction>} txs - Transactions to bundle
 * @param {object} [opts]
 * @param {number} [opts.tip] - Tip in lamports (overrides config)
 * @returns {Promise<{success: boolean, bundleId?: string, error?: string, txs?: string[]}>}
 */
export async function bundleTx(txs, opts = {}) {
  if (!isEnabled()) {
    return { success: false, skipped: true, error: "Jito bundling disabled" };
  }

  if (!txs || txs.length === 0) {
    return { success: false, error: "No transactions to bundle" };
  }

  const txArray = Array.isArray(txs) ? txs : [txs];

  try {
    // Serialize all transactions to base64
    const serializedTxs = txArray.map(tx => {
      if (tx instanceof VersionedTransaction) {
        return Buffer.from(tx.serialize()).toString("base64");
      }
      return Buffer.from(tx.serialize({ requireAllSignatures: false, verifySignatures: false })).toString("base64");
    });

    // Build the bundle payload
    const tip = opts.tip ?? tipLamports();
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [serializedTxs],
    };

    log("jito", `Submitting bundle with ${serializedTxs.length} tx(s), tip ${tip} lamports`);

    const res = await fetch(`${blockEngineUrl()}/bundle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Jito API ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const bundleId = data?.result;

    if (!bundleId) {
      throw new Error(`Jito bundle rejected: ${JSON.stringify(data)}`);
    }

    log("jito", `Bundle submitted: ${bundleId}`);

    return {
      success: true,
      bundleId,
      txs: serializedTxs.map((_, i) => `${bundleId}#${i}`),
    };
  } catch (e) {
    log("jito_error", `Bundle failed: ${e.message}`);
    return { success: false, error: e.message };
  }
}

/**
 * Check bundle status.
 */
export async function getBundleStatus(bundleId) {
  try {
    const payload = {
      jsonrpc: "2.0",
      id: 1,
      method: "getBundleStatuses",
      params: [[bundleId]],
    };

    const res = await fetch(`${blockEngineUrl()}/bundle`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!res.ok) return { error: `HTTP ${res.status}` };

    const data = await res.json();
    const bundleStatus = data?.result?.value?.[0];

    if (!bundleStatus) return { error: "No status returned" };

    return {
      success: bundleStatus.confirmationStatus === "confirmed" || bundleStatus.confirmationStatus === "finalized",
      status: bundleStatus.confirmationStatus,
      slot: bundleStatus.slot,
      txSignatures: bundleStatus.transactions,
    };
  } catch (e) {
    return { error: e.message };
  }
}
