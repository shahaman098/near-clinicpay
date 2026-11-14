#!/usr/bin/env node
// NEAR Intents (1Click) client: price and start a payment from any chain into a
// ClinicPay share. No dependencies; Node 18+ fetch.
//
// 1Click settles EXACT_OUTPUT: the sender pays a quoted amount on the origin chain
// and the recipient (ClinicPay) receives exactly the share, in the invoice's token,
// with `customRecipientMsg` delivered as the NEP-141 ft_transfer_call message.
//
// Mainnet only: 1Click has no testnet. A dry quote moves nothing and needs no key.
import { view } from "./lib.mjs";

export const ONECLICK = "https://1click.chaindefuser.com/v0";
const UA = "clinicpay/1.0 (+https://github.com/shahaman098/near-clinicpay)";

function headers(jwt) {
  return { "content-type": "application/json", "user-agent": UA, ...(jwt ? { authorization: `Bearer ${jwt}` } : {}) };
}

async function getJson(url, { jwt, fetchImpl }) {
  const r = await fetchImpl(url, { headers: headers(jwt) });
  const body = await r.text();
  if (!r.ok) throw new Error(`1Click ${r.status}: ${body.slice(0, 300)}`);
  return JSON.parse(body);
}

/** All assets 1Click can move. 231 tokens across 39 chains on 2026-11-14. */
export async function tokens({ jwt = process.env.ONECLICK_JWT, fetchImpl = fetch, base = ONECLICK } = {}) {
  return getJson(`${base}/tokens`, { jwt, fetchImpl });
}

/** "base:USDC" | "sol:SOL" | "btc:BTC" -> the token entry, or null. */
export function findAsset(list, name) {
  const [chain, symbol] = String(name).split(":");
  if (!chain || !symbol) return null;
  const want = symbol.toUpperCase();
  return list.find((t) => t.blockchain?.toLowerCase() === chain.toLowerCase() && t.symbol?.toUpperCase() === want) ?? null;
}

/** Dry quote by default. Returns the raw 1Click response. */
export async function quote(
  { originAsset, destinationAsset, amount, recipient, msg, refundTo, dry = true, slippageTolerance = 100, deadline },
  { jwt = process.env.ONECLICK_JWT, fetchImpl = fetch, base = ONECLICK } = {},
) {
  const body = {
    dry,
    swapType: "EXACT_OUTPUT",
    slippageTolerance,
    originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset,
    amount: String(amount),
    refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient,
    customRecipientMsg: JSON.stringify(msg),
    recipientType: "DESTINATION_CHAIN",
    deadline: deadline ?? new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
  const r = await fetchImpl(`${base}/quote`, { method: "POST", headers: headers(jwt), body: JSON.stringify(body) });
  const text = await r.text();
  if (!r.ok) throw new Error(`1Click quote ${r.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

export async function status(depositAddress, { jwt = process.env.ONECLICK_JWT, fetchImpl = fetch, base = ONECLICK } = {}) {
  return getJson(`${base}/status?depositAddress=${encodeURIComponent(depositAddress)}`, { jwt, fetchImpl });
}

/**
 * Check everything the contract will check when the deposit lands, before anyone
 * sends money. Throws with a readable message; returns { invoice, share, amount, assetId }.
 */
export async function preflight({ rpc, contract, invoiceId, shareIndex, assets, viewImpl = view }) {
  const invoice = await viewImpl(rpc, contract, "get_invoice", { invoice_id: invoiceId });
  if (!invoice) throw new Error(`no invoice "${invoiceId}" on ${contract}`);
  if (invoice.cancelled) throw new Error("invoice is cancelled");
  if (!invoice.token) throw new Error("invoice is priced in NEAR; cross-chain settlement needs a NEP-141 token invoice");
  const share = invoice.shares[shareIndex];
  if (!share) throw new Error(`no share #${shareIndex}`);
  if (share.state !== "Open") throw new Error(`share #${shareIndex} is ${share.state}`);
  if (share.payer) throw new Error(`share #${shareIndex} names a payer (${share.payer}); 1Click delivers as intents.near, so only an open share can settle cross-chain`);
  if (BigInt(share.amount) <= 0n) throw new Error("share amount must be positive");

  const assetId = `nep141:${invoice.token}`;
  if (!assets.some((t) => t.assetId === assetId)) throw new Error(`token ${invoice.token} is not a 1Click asset (mainnet only)`);

  for (const who of [contract, invoice.payee]) {
    const bal = await viewImpl(rpc, invoice.token, "storage_balance_of", { account_id: who });
    if (bal === null) throw new Error(`${who} is not registered on ${invoice.token}; a delivery would be refunded, not settled`);
  }
  return { invoice, share, amount: share.amount, assetId };
}

/** Refuse a quote that does not deliver exactly the share with no withdraw fee. */
export function checkQuote(q, amount) {
  const out = BigInt(q.quote.minAmountOut);
  if (out !== BigInt(amount)) throw new Error(`quote minAmountOut ${out} != share ${amount}`);
  if (String(q.quote.withdrawFee ?? "0") !== "0") throw new Error(`quote charges a withdraw fee: ${q.quote.withdrawFee}`);
  if (q.quoteRequest?.dry === false && !q.quote.depositAddress) throw new Error("live quote has no deposit address");
  return q.quote;
}

/** Asset label for a quote: "base:USDC" -> {chain, symbol} */
export function assetLabel(asset) {
  return `${asset.blockchain}:${asset.symbol}`;
}
