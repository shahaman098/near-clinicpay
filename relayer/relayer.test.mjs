// Relayer unit tests: borsh and signature round trips, and the policy that decides
// what the relayer pays for. End-to-end runs on a sandbox node are in
// contract/tests/sandbox_relayer.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { b58decode, b58encode, decodeSignedDelegate, encodeTransaction, parseSecretKey, signDelegate } from "./near.mjs";
import { Budget, Refused, budgetFromEnv, checkInvoice, checkShape, checkToken } from "./policy.mjs";
import { payAction } from "./payer.mjs";

const TGAS = 10n ** 12n;
const CONTRACT = "clinicpay.testnet";
const TOKEN = "usdc.testnet";

function newKey() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32);
  const pub = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  return parseSecretKey(`ed25519:${b58encode(Buffer.concat([seed, pub]))}`);
}
const KEY = newKey();

function delegate(receiver_id, action, over = {}) {
  const d = { sender_id: "patient.testnet", receiver_id, actions: [action], nonce: 7n, max_block_height: 1100n, public_key: KEY.publicKey, ...over };
  return decodeSignedDelegate(signDelegate(d, KEY));
}
const ftPay = (args = {}, deposit = 1n) => ({
  type: "FunctionCall", method_name: "ft_transfer_call", gas: 100n * TGAS, deposit,
  args: { receiver_id: CONTRACT, amount: "10000000", msg: JSON.stringify({ invoice_id: "INV-1", share_index: 0 }), ...args },
});
const ctx = { contract: CONTRACT, tokens: [TOKEN], height: 1000n };
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof Refused && re.test(e.message));

test("base58 round-trips, including leading zero bytes", () => {
  const bytes = Uint8Array.from([0, 0, 1, 2, 255, 128]);
  assert.deepEqual(b58decode(b58encode(bytes)), bytes);
  assert.equal(b58encode(Uint8Array.from([0])), "1");
});

test("a signed delegate decodes to what was signed and verifies", () => {
  const d = delegate(TOKEN, ftPay());
  assert.equal(d.valid, true);
  assert.equal(d.sender_id, "patient.testnet");
  assert.equal(d.actions[0].args.receiver_id, CONTRACT);
  assert.equal(d.actions[0].deposit, 1n);
  assert.equal(d.nonce, 7n);
});

test("a tampered delegate fails signature verification and is refused", () => {
  const raw = signDelegate({ sender_id: "patient.testnet", receiver_id: TOKEN, actions: [ftPay()], nonce: 7n, max_block_height: 1100n, public_key: KEY.publicKey }, KEY);
  const i = raw.indexOf(Buffer.from("10000000"));
  raw[i] = "9".charCodeAt(0); // 90000000: a bigger payment than was signed
  const d = decodeSignedDelegate(raw);
  assert.equal(d.valid, false);
  refused(() => checkShape(d, ctx), /bad signature/);
});

test("transaction encoding starts with the signer and ends with the delegate action", () => {
  const delegateBytes = Buffer.from([1, 2, 3]);
  const tx = encodeTransaction({ signer_id: "r.testnet", public_key: KEY.publicKey, nonce: 1n, receiver_id: "p.testnet", block_hash: new Uint8Array(32), actions: [{ type: "Delegate", signedDelegateBytes: delegateBytes }] });
  assert.equal(tx.readUInt32LE(0), "r.testnet".length);
  assert.deepEqual([...tx.subarray(-4)], [8, 1, 2, 3]); // Action::Delegate = 8
});

test("policy accepts a stablecoin payment to ClinicPay", () => {
  const intent = checkShape(delegate(TOKEN, ftPay()), ctx);
  assert.deepEqual(intent, { kind: "pay_token", token: TOKEN, invoice_id: "INV-1", share_index: 0, amount: 10000000n });
});

test("policy accepts an insurer adjudication with no deposit", () => {
  const a = { type: "FunctionCall", method_name: "adjudicate_share", gas: 30n * TGAS, deposit: 0n, args: { invoice_id: "INV-1", share_index: 1, approved: "1", reason: "CO-45", move_to: 0 } };
  assert.equal(checkShape(delegate(CONTRACT, a), ctx).kind, "adjudicate");
});

test("policy refuses everything that would spend the relayer's money or reach other contracts", () => {
  const call = (method_name, deposit = 0n, args = {}) => ({ type: "FunctionCall", method_name, gas: 30n * TGAS, deposit, args });
  refused(() => checkShape(delegate(CONTRACT, call("pay_share", 10n ** 24n, { invoice_id: "INV-1", share_index: 0 })), ctx), /paid directly/);
  refused(() => checkShape(delegate("evil.testnet", call("anything")), ctx), /not ClinicPay or a listed token/);
  refused(() => checkShape(delegate("relayer.testnet", { type: "Transfer", deposit: 10n ** 24n }), ctx), /only function calls/);
  refused(() => checkShape(delegate(CONTRACT, call("create_invoice")), ctx), /not relayed/);
  refused(() => checkShape(delegate(CONTRACT, call("adjudicate_share", 5n, { invoice_id: "I", share_index: 1 })), ctx), /no deposit/);
  refused(() => checkShape(delegate(TOKEN, ftPay({ receiver_id: "evil.testnet" })), ctx), /only be sent to ClinicPay/);
  refused(() => checkShape(delegate(TOKEN, ftPay({}, 2n)), ctx), /exactly 1 yoctoNEAR/);
  refused(() => checkShape(delegate(TOKEN, { ...ftPay(), method_name: "ft_transfer" }), ctx), /not relayed/);
  refused(() => checkShape(delegate("othertoken.testnet", ftPay()), ctx), /not ClinicPay or a listed token/);
  refused(() => checkShape(delegate(TOKEN, ftPay({ msg: JSON.stringify({ invoice_id: "INV-1", share_index: 0, action: "refund" }) })), ctx), /only payments/);
  refused(() => checkShape(delegate(TOKEN, { ...ftPay(), gas: 300n * TGAS }), ctx), /150 Tgas/);
  refused(() => checkShape(delegate(TOKEN, ftPay(), { max_block_height: 999n }), ctx), /expired/);
  refused(() => checkShape(delegate(TOKEN, ftPay(), { max_block_height: 999999n }), ctx), /too long/);
  const two = { sender_id: "patient.testnet", receiver_id: TOKEN, actions: [ftPay(), ftPay()], nonce: 1n, max_block_height: 1100n, public_key: KEY.publicKey };
  refused(() => checkShape(decodeSignedDelegate(signDelegate(two, KEY)), ctx), /exactly one action/);
});

test("live invoice checks stop calls that would fail on chain", () => {
  const inv = { id: "INV-1", token: TOKEN, cancelled: false, shares: [
    { payer: "patient.testnet", amount: "10000000", state: "Open" },
    { payer: "insurer.testnet", amount: "40000000", state: "Open" },
    { payer: null, amount: "5", state: "Paid" },
  ] };
  const pay = (share_index, amount = 10000000n, token = TOKEN) => ({ kind: "pay_token", token, invoice_id: "INV-1", share_index, amount });
  checkInvoice(pay(0), "patient.testnet", inv);
  refused(() => checkInvoice(pay(1, 40000000n), "patient.testnet", inv), /named payer/);
  refused(() => checkInvoice(pay(0, 9n), "patient.testnet", inv), /does not match/);
  refused(() => checkInvoice(pay(2, 5n), "anyone.testnet", inv), /share is Paid/);
  refused(() => checkInvoice(pay(7), "patient.testnet", inv), /no such share/);
  refused(() => checkInvoice(pay(0, 10000000n, "other.testnet"), "patient.testnet", inv), /not priced in this token/);
  refused(() => checkInvoice(pay(0), "patient.testnet", null), /no invoice/);
  refused(() => checkInvoice(pay(0), "patient.testnet", { ...inv, cancelled: true }), /cancelled/);
});

test("adjudication checks mirror the contract, so rejected decisions cost no gas", () => {
  const inv = { id: "INV-1", token: TOKEN, cancelled: false, shares: [
    { payer: "patient.testnet", amount: "10", state: "Open" },
    { payer: "insurer.testnet", amount: "40", state: "Open" },
    { payer: null, amount: "5", state: "Paid" },
  ] };
  const adj = (approved, move_to = 0, share_index = 1) => ({ kind: "adjudicate", invoice_id: "INV-1", share_index, approved, move_to });
  checkInvoice(adj(30n), "insurer.testnet", inv);
  checkInvoice(adj(40n, null), "insurer.testnet", inv);
  refused(() => checkInvoice(adj(30n), "patient.testnet", inv), /named payer/);
  refused(() => checkInvoice(adj(41n), "insurer.testnet", inv), /cannot exceed/);
  refused(() => checkInvoice(adj(30n, null), "insurer.testnet", inv), /move_to is required/);
  refused(() => checkInvoice(adj(30n, 1), "insurer.testnet", inv), /another share/);
  refused(() => checkInvoice(adj(30n, 9), "insurer.testnet", inv), /no such move_to/);
  refused(() => checkInvoice(adj(30n, 2), "insurer.testnet", inv), /must be open/);
  const done = structuredClone(inv); done.shares[1].adjudication = { original: "40" };
  refused(() => checkInvoice(adj(30n), "insurer.testnet", done), /already adjudicated/);
  const bad = (args) => delegate(CONTRACT, { type: "FunctionCall", method_name: "adjudicate_share", gas: 30n * TGAS, deposit: 0n, args: { invoice_id: "INV-1", share_index: 1, approved: "1", reason: "CO-45", move_to: 0, ...args } });
  refused(() => checkShape(bad({ reason: " " }), ctx), /reason/);
  refused(() => checkShape(bad({ reason: "x".repeat(201) }), ctx), /reason/);
  refused(() => checkShape(bad({ approved: "abc" }), ctx), /approved/);
});

test("token payments need the sender's balance and both registrations", () => {
  const intent = { kind: "pay_token", token: TOKEN, invoice_id: "INV-1", share_index: 0, amount: 10n };
  const ok = { senderBalance: "10", contractRegistered: true, clinicRegistered: true };
  checkToken(intent, ok);
  refused(() => checkToken(intent, { ...ok, senderBalance: "9" }), /enough of the token/);
  refused(() => checkToken(intent, { ...ok, contractRegistered: false }), /ClinicPay is not registered/);
  refused(() => checkToken(intent, { ...ok, clinicRegistered: false }), /clinic is not registered/);
  checkToken({ kind: "adjudicate" }, {}); // not a token payment: nothing to check
});

test("payer builds ft_transfer_call for token invoices and refuses NEAR ones", () => {
  const inv = { id: "INV-1", token: TOKEN, shares: [{ amount: "10000000", state: "Open" }] };
  const c = payAction(CONTRACT, inv, 0);
  assert.equal(c.receiver_id, TOKEN);
  assert.equal(c.action.deposit, 1n);
  assert.equal(JSON.parse(c.action.args.msg).invoice_id, "INV-1");
  assert.throws(() => payAction(CONTRACT, { ...inv, token: null }, 0), /pay it directly/);
});

test("relayer budget bounds per-payer, global and gas spend, and resets", () => {
  let t = 1_000_000;
  const b = new Budget({ windowMs: 1000, maxTxPerPayer: 2, maxTxGlobal: 3, maxGasGlobal: 10n * 10n ** 12n, now: () => t });
  b.take("a", 4n * 10n ** 12n);
  b.take("a", 4n * 10n ** 12n);
  refused(() => b.take("a", 1n), /payer budget/);
  b.take("b", 1n * 10n ** 12n);
  refused(() => b.take("c", 1n), /relayer budget/);

  const g = new Budget({ windowMs: 1000, maxTxPerPayer: 10, maxTxGlobal: 10, maxGasGlobal: 5n * 10n ** 12n, now: () => t });
  g.take("a", 3n * 10n ** 12n);
  refused(() => g.take("b", 3n * 10n ** 12n), /gas budget/);

  t += 1001;
  b.take("a", 1n); // the window rolled over
});

test("budgetFromEnv reads and validates limits", () => {
  const b = budgetFromEnv({
    RELAYER_BUDGET_WINDOW_MS: "5000", RELAYER_MAX_TX_PER_PAYER: "2",
    RELAYER_MAX_TX_GLOBAL: "9", RELAYER_MAX_GAS_GLOBAL: "7",
  });
  assert.equal(b.windowMs, 5000);
  assert.equal(b.maxTxPerPayer, 2);
  assert.equal(b.maxTxGlobal, 9);
  assert.equal(b.maxGasGlobal, 7n * 10n ** 12n);
  assert.throws(() => budgetFromEnv({ RELAYER_MAX_TX_GLOBAL: "0" }), /positive/);
});
