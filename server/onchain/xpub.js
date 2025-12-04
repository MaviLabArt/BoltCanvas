// server/onchain/xpub.js
// XPUB-based on-chain provider using Esplora-compatible endpoints (mempool.space by default).
import fetch from "node-fetch";
import { BIP32Factory } from "bip32";
import * as ecc from "tiny-secp256k1";
import * as bitcoin from "bitcoinjs-lib";
import bs58check from "bs58check";
import { allocateNextXpubIndex, Orders } from "../db.js";

const bip32 = BIP32Factory(ecc);

const RAW_XPUB = String(process.env.ONCHAIN_XPUB || "").trim();

const VERSIONS = {
  xpub: 0x0488b21e,
  ypub: 0x049d7cb2,
  zpub: 0x04b24746,
  tpub: 0x043587cf,
  vpub: 0x045f1cf6
};

function decodeVersion(xpub) {
  const buf = bs58check.decode(xpub);
  return buf.readUInt32BE(0);
}

function normalizeToStandardXpub(raw) {
  const buf = bs58check.decode(raw);
  const ver = buf.readUInt32BE(0);
  const body = buf.slice(4);

  if (ver === VERSIONS.ypub || ver === VERSIONS.zpub) {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(VERSIONS.xpub, 0);
    return bs58check.encode(Buffer.concat([head, body]));
  }
  if (ver === VERSIONS.vpub) {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(VERSIONS.tpub, 0);
    return bs58check.encode(Buffer.concat([head, body]));
  }
  return raw;
}

function inferNetworkAndType(rawXpub) {
  const ver = decodeVersion(rawXpub);
  let network = bitcoin.networks.bitcoin;
  let type = "p2wpkh";

  if (ver === VERSIONS.tpub || ver === VERSIONS.vpub) {
    network = bitcoin.networks.testnet;
  }

  if (ver === VERSIONS.xpub) type = "p2pkh";
  if (ver === VERSIONS.ypub) type = "p2sh-p2wpkh";
  if (ver === VERSIONS.zpub || ver === VERSIONS.vpub) type = "p2wpkh";

  return { network, type };
}

let cachedConfig = null;

function resolveConfig() {
  if (cachedConfig) return cachedConfig;
  if (!RAW_XPUB) {
    throw new Error("ONCHAIN_XPUB is required when ONCHAIN_PROVIDER=xpub");
  }
  const normalizedXpub = normalizeToStandardXpub(RAW_XPUB);
  const { network: inferredNetwork, type: inferredType } = inferNetworkAndType(RAW_XPUB);
  const addressType = String(process.env.ONCHAIN_XPUB_ADDRESS_TYPE || inferredType || "p2wpkh").toLowerCase();
  const networkName = String(process.env.ONCHAIN_XPUB_NETWORK || "mainnet").toLowerCase();

  const network =
    networkName === "testnet4" || networkName === "testnet"
      ? bitcoin.networks.testnet
      : networkName === "signet"
        ? bitcoin.networks.testnet
        : bitcoin.networks.bitcoin;

  if (network !== inferredNetwork) {
    console.warn("[xpub] WARNING: XPUB network and ONCHAIN_XPUB_NETWORK differ. Verify your wallet watches the correct network.");
  }

  const apiBase =
    (process.env.ONCHAIN_XPUB_API_BASE || "").replace(/\/+$/, "") ||
    (networkName === "testnet4" || networkName === "testnet"
      ? "https://mempool.space/testnet4/api"
      : networkName === "signet"
        ? "https://mempool.space/signet/api"
        : "https://mempool.space/api");

  const accountNode = bip32.fromBase58(normalizedXpub, network);
  cachedConfig = { addressType, networkName, network, apiBase, accountNode, normalizedXpub };
  return cachedConfig;
}

function deriveChildNode(index) {
  const { accountNode } = resolveConfig();
  return accountNode.derive(0).derive(index);
}

function deriveAddress(index) {
  const { addressType, network } = resolveConfig();
  const child = deriveChildNode(index);
  if (!child.publicKey) throw new Error("XPUB child has no publicKey");

  switch (addressType) {
    case "p2pkh": {
      const { address } = bitcoin.payments.p2pkh({ pubkey: child.publicKey, network });
      return address || "";
    }
    case "p2sh-p2wpkh": {
      const p2wpkh = bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network });
      const { address } = bitcoin.payments.p2sh({ redeem: p2wpkh, network });
      return address || "";
    }
    case "p2wpkh":
    default: {
      const { address } = bitcoin.payments.p2wpkh({ pubkey: child.publicKey, network });
      return address || "";
    }
  }
}

function satsToBtc(amountSats) {
  return (amountSats / 1e8).toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

function buildBip21(address, amountSats, label) {
  const params = new URLSearchParams();
  if (amountSats) params.set("amount", satsToBtc(amountSats));
  if (label) params.set("label", label);
  const qs = params.toString();
  return qs ? `bitcoin:${address}?${qs}` : `bitcoin:${address}`;
}

async function fetchAddressTxs(address) {
  const { apiBase } = resolveConfig();
  const [mempoolRes, chainRes] = await Promise.all([
    fetch(`${apiBase}/address/${address}/txs/mempool`),
    fetch(`${apiBase}/address/${address}/txs/chain`)
  ]);

  if (mempoolRes.status === 429 || chainRes.status === 429) {
    throw new Error("Rate limited by mempool.space (HTTP 429)");
  }

  const mempoolTxs = mempoolRes.ok ? await mempoolRes.json() : [];
  const chainTxs = chainRes.ok ? await chainRes.json() : [];
  return { mempoolTxs, chainTxs };
}

function sumOutputsToAddress(txs, address) {
  let total = 0;
  for (const tx of txs) {
    if (!Array.isArray(tx.vout)) continue;
    for (const vout of tx.vout) {
      if (vout.scriptpubkey_address === address) {
        total += vout.value || 0;
      }
    }
  }
  return total;
}

function findTxidPayingAddress(txs, address) {
  for (const tx of txs) {
    if (!Array.isArray(tx.vout)) continue;
    const pays = tx.vout.some((vout) => vout.scriptpubkey_address === address && (vout.value || 0) > 0);
    if (pays) return tx.txid || tx.tx_hash || tx.id || "";
  }
  return "";
}

const MIN_SATS = Number(process.env.ONCHAIN_MIN_SATS || 0);
const EXPIRES_SEC = Math.max(60, Number(process.env.ONCHAIN_INVOICE_EXPIRES_IN || 900)); // seconds
const EXPIRES_MS = EXPIRES_SEC * 1000;
const AMOUNT_TOLERANCE_PCT = Number(process.env.ONCHAIN_AMOUNT_TOLERANCE_PCT || 1);
const DEBUG_XPUB = String(process.env.ONCHAIN_XPUB_DEBUG || "false").toLowerCase() === "true";

export async function createOnchainPayment({ orderId, amountSats, memo }) {
  if (!orderId) throw new Error("orderId is required for XPUB payments");
  const sats = Math.max(0, Math.floor(Number(amountSats || 0)));
  if (sats < MIN_SATS) {
    throw new Error(`Amount below ONCHAIN_MIN_SATS (${MIN_SATS})`);
  }

  const index = await allocateNextXpubIndex();
  const address = deriveAddress(index);
  const bip21 = buildBip21(address, sats, memo || `Order ${orderId}`);

  const expiresAt = new Date(Date.now() + EXPIRES_MS).toISOString();
  const onchainId = orderId;

  return {
    paymentMethod: "onchain",
    paymentHash: null,
    paymentRequest: bip21,
    onchainId,
    onchainAddress: address,
    onchainBip21: bip21,
    onchainAmountSats: sats,
    onchainExpiresAt: expiresAt,
    xpubIndex: index
  };
}

function meetsAmount(expectedSats, receivedSats) {
  if (!expectedSats) return receivedSats > 0;
  const min = Math.floor(expectedSats * (1 - AMOUNT_TOLERANCE_PCT / 100));
  return receivedSats >= min;
}

export async function getOnchainStatus(paymentRow) {
  const address = paymentRow?.onchainAddress || paymentRow?.boltzAddress || "";
  if (!address) {
    return { status: "FAILED", rawStatus: "FAILED" };
  }
  const expected = Math.max(0, Math.floor(Number(paymentRow?.onchainAmountSats || 0)));
  const orderId = paymentRow?.orderId || paymentRow?.id;
  const expiresAt = paymentRow?.onchainExpiresAt ? Date.parse(paymentRow.onchainExpiresAt) : null;
  const expired = expiresAt ? Date.now() > expiresAt : false;

  try {
    const { mempoolTxs, chainTxs } = await fetchAddressTxs(address);
    const mempoolReceived = sumOutputsToAddress(mempoolTxs, address);
    const confirmedReceived = sumOutputsToAddress(chainTxs, address);
    const txidConfirmed = findTxidPayingAddress(chainTxs, address);
    const txidMempool = findTxidPayingAddress(mempoolTxs, address);
    const txid = txidConfirmed || txidMempool || paymentRow?.onchainTxid || "";

    const hasConfirmed = meetsAmount(expected, confirmedReceived);
    const hasMempool = meetsAmount(expected, mempoolReceived + confirmedReceived);

    let status = "UNPAID";
    if (hasConfirmed) status = "CONFIRMED";
    else if (hasMempool) status = "MEMPOOL";
    else if (expired) status = "EXPIRED";

    if (DEBUG_XPUB) {
      console.info(
        `[xpub] addr=${address} expected=${expected} mem=${mempoolReceived} conf=${confirmedReceived} -> ${status}`
      );
    }

    if (orderId) {
      await Orders.updateOnchainStatus(orderId, status, {
        mempoolReceived,
        confirmedReceived,
        txid
      });
    }

    return {
      status,
      rawStatus: status,
      onchainAddress: address,
      onchainAmountSats: expected,
      onchainTxid: txid,
      onchainMempoolSats: mempoolReceived,
      onchainConfirmedSats: confirmedReceived
    };
  } catch (err) {
    console.error("[xpub] getOnchainStatus error", err?.message || err);
    return {
      status: paymentRow?.onchainStatus || "UNPAID",
      rawStatus: paymentRow?.onchainStatus || "UNPAID",
      onchainAddress: address,
      onchainAmountSats: expected
    };
  }
}
