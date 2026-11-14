import test from "node:test";
import assert from "node:assert/strict";
import { checkQuote, findAsset, preflight, quote, status } from "./intents.mjs";

const ASSETS = [
  { assetId: "nep141:base-usdc.omft.near", blockchain: "base", symbol: "USDC", decimals: 6 },
  { assetId: "nep141:sol.omft.near", blockchain: "sol", symbol: "SOL", decimals: 9 },
  { assetId: "nep141:17208628-usdc", blockchain: "near", symbol: "USDC", decimals: 6 },
];

const INV = {
  id: "FT-1", payee: "clinic.near", cancelled: false, token: "17208628-usdc",
  shares: [
    { label: "Patient", payer: null, amount: "10000000", state: "Open" },
    { label: "Insurer", payer: "insurer.near", amount: "40000000", state: "Open" },
  ],
};

function rpcStub(invoice = INV, registered = ["pay.near", "clinic.near"]) {
  return async (_rpc, contract, method, args) => {
    if (method === "get_invoice") return invoice;
    if (method === "storage_balance_of") return registered.includes(args.account_id) ? { total: "1" } : null;
    throw new Error(`unexpected ${contract}.${method}`);
  };
}

test("asset lookup is case-insensitive and returns null for unknowns", () => {
  assert.equal(findAsset(ASSETS, "base:usdc").assetId, "nep141:base-usdc.omft.near");
  assert.equal(findAsset(ASSETS, "SOL:SOL").decimals, 9);
  assert.equal(findAsset(ASSETS, "base:DOGE"), null);
  assert.equal(findAsset(ASSETS, "nocolon"), null);
});

test("quote sends EXACT_OUTPUT with the recipient message and types", async () => {
  let seen;
  const fetchImpl = async (url, opts) => {
    seen = { url, body: JSON.parse(opts.body), headers: opts.headers };
    return { ok: true, status: 201, text: async () => JSON.stringify({ quote: { minAmountOut: "10000000", withdrawFee: "0" } }) };
  };
  const r = await quote(
    { originAsset: "nep141:base-usdc.omft.near", destinationAsset: "nep141:17208628-usdc", amount: "10000000", recipient: "pay.near", msg: { invoice_id: "FT-1", share_index: 0 }, refundTo: "0xabc" },
    { fetchImpl, jwt: "jwt" },
  );
  assert.equal(r.quote.withdrawFee, "0");
  assert.equal(seen.body.swapType, "EXACT_OUTPUT");
  assert.equal(seen.body.depositType, "ORIGIN_CHAIN");
  assert.equal(seen.body.refundType, "ORIGIN_CHAIN");
  assert.equal(seen.body.recipientType, "DESTINATION_CHAIN");
  assert.equal(seen.body.amount, "10000000");
  assert.deepEqual(JSON.parse(seen.body.customRecipientMsg), { invoice_id: "FT-1", share_index: 0 });
  assert.equal(seen.headers.authorization, "Bearer jwt");
  assert.match(seen.headers["user-agent"], /clinicpay/);
});

test("quote surfaces the 1Click error body", async () => {
  const fetchImpl = async () => ({ ok: false, status: 500, text: async () => "recipient does not exist" });
  await assert.rejects(() => quote({}, { fetchImpl }), /1Click quote 500: recipient does not exist/);
});

test("checkQuote refuses a short delivery or a withdraw fee", () => {
  const q = (min, fee, extra = {}) => ({ quote: { minAmountOut: min, withdrawFee: fee, ...extra }, quoteRequest: {} });
  assert.doesNotThrow(() => checkQuote(q("100", "0"), "100"));
  assert.throws(() => checkQuote(q("99", "0"), "100"), /minAmountOut/);
  assert.throws(() => checkQuote(q("100", "10"), "100"), /withdraw fee/);
  const live = { quote: { minAmountOut: "100", withdrawFee: "0" }, quoteRequest: { dry: false } };
  assert.throws(() => checkQuote(live, "100"), /deposit address/);
});

test("preflight accepts an open share with both registrations", async () => {
  const r = await preflight({ rpc: "rpc", contract: "pay.near", invoiceId: "FT-1", shareIndex: 0, assets: ASSETS, viewImpl: rpcStub() });
  assert.equal(r.amount, "10000000");
  assert.equal(r.assetId, "nep141:17208628-usdc");
});

test("preflight refuses a named payer, a bad state, a missing token and missing storage", async () => {
  await assert.rejects(
    () => preflight({ rpc: "rpc", contract: "pay.near", invoiceId: "FT-1", shareIndex: 1, assets: ASSETS, viewImpl: rpcStub() }),
    /names a payer/,
  );
  const paid = { ...INV, shares: [{ ...INV.shares[0], state: "Paid" }] };
  await assert.rejects(
    () => preflight({ rpc: "rpc", contract: "pay.near", invoiceId: "FT-1", shareIndex: 0, assets: ASSETS, viewImpl: rpcStub(paid) }),
    /is Paid/,
  );
  await assert.rejects(
    () => preflight({ rpc: "rpc", contract: "pay.near", invoiceId: "FT-1", shareIndex: 0, assets: [], viewImpl: rpcStub() }),
    /not a 1Click asset/,
  );
  await assert.rejects(
    () => preflight({ rpc: "rpc", contract: "pay.near", invoiceId: "FT-1", shareIndex: 0, assets: ASSETS, viewImpl: rpcStub(INV, ["pay.near"]) }),
    /clinic.near is not registered/,
  );
});

test("status encodes the deposit address", async () => {
  let url;
  const fetchImpl = async (u) => { url = u; return { ok: true, status: 200, text: async () => JSON.stringify({ status: "PENDING" }) }; };
  const r = await status("0xabc/def", { fetchImpl });
  assert.equal(r.status, "PENDING");
  assert.match(url, /depositAddress=0xabc%2Fdef$/);
});
