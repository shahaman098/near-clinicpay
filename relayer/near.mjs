// Minimal NEAR primitives for meta transactions (NEP-366), Node standard library only:
// base58, borsh for the few types we need, ed25519 keys, signing, and JSON-RPC.
// Layouts follow near-primitives 0.38 (Transaction V0, Action enum, DelegateAction).
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";

// ---- base58 ----------------------------------------------------------------
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function b58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let s = "";
  while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
  for (const b of bytes) { if (b !== 0) break; s = "1" + s; }
  return s;
}
export function b58decode(str) {
  let n = 0n;
  for (const c of str) {
    const i = B58.indexOf(c);
    if (i < 0) throw new Error(`bad base58 character "${c}"`);
    n = n * 58n + BigInt(i);
  }
  const out = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of str) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}

// ---- borsh -----------------------------------------------------------------
export class Writer {
  constructor() { this.parts = []; }
  u8(v) { this.parts.push(Uint8Array.of(v)); return this; }
  u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v); this.parts.push(b); return this; }
  u64(v) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); this.parts.push(b); return this; }
  u128(v) {
    const x = BigInt(v);
    if (x < 0n || x >= 1n << 128n) throw new Error("u128 out of range");
    const b = Buffer.alloc(16); b.writeBigUInt64LE(x & ((1n << 64n) - 1n)); b.writeBigUInt64LE(x >> 64n, 8);
    this.parts.push(b); return this;
  }
  fixed(bytes) { this.parts.push(Uint8Array.from(bytes)); return this; }
  bytes(bytes) { this.u32(bytes.length); return this.fixed(bytes); }
  string(s) { return this.bytes(Buffer.from(s, "utf8")); }
  out() { return Buffer.concat(this.parts); }
}

export class Reader {
  constructor(buf) { this.b = Buffer.from(buf); this.o = 0; }
  need(n) { if (this.o + n > this.b.length) throw new Error("borsh: unexpected end of input"); }
  u8() { this.need(1); return this.b[this.o++]; }
  u32() { this.need(4); const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { this.need(8); const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  u128() { this.need(16); const lo = this.b.readBigUInt64LE(this.o); const hi = this.b.readBigUInt64LE(this.o + 8); this.o += 16; return (hi << 64n) | lo; }
  fixed(n) { this.need(n); const v = this.b.subarray(this.o, this.o + n); this.o += n; return Uint8Array.from(v); }
  bytes() { return this.fixed(this.u32()); }
  string() { return Buffer.from(this.bytes()).toString("utf8"); }
  done() { if (this.o !== this.b.length) throw new Error("borsh: trailing bytes"); }
}

// ---- keys ------------------------------------------------------------------
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

/** "ed25519:<base58 of 64 bytes (seed + public key)>" -> signing key. */
export function parseSecretKey(text) {
  const [kind, data] = String(text).split(":");
  if (kind !== "ed25519" || !data) throw new Error("secret key must look like ed25519:<base58>");
  const raw = b58decode(data);
  if (raw.length !== 64 && raw.length !== 32) throw new Error("ed25519 secret key must be 32 or 64 bytes");
  const key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, raw.subarray(0, 32)]), format: "der", type: "pkcs8" });
  const pub = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
  return { key, publicKey: Uint8Array.from(pub) };
}

export const publicKeyString = (pub) => `ed25519:${b58encode(pub)}`;
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest();
export const signBytes = (signer, bytes) => Uint8Array.from(edSign(null, bytes, signer.key));
export function verifyBytes(pub, bytes, sig) {
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(pub)]), format: "der", type: "spki" });
  return edVerify(null, bytes, key, Buffer.from(sig));
}

// ---- actions ---------------------------------------------------------------
// Action enum tags (near-primitives `Action`): FunctionCall = 2, Transfer = 3, Delegate = 8.
const TAG = { FunctionCall: 2, Transfer: 3, Delegate: 8 };

function writeAction(w, a) {
  if (a.type === "FunctionCall") {
    w.u8(TAG.FunctionCall).string(a.method_name).bytes(Buffer.from(JSON.stringify(a.args)))
      .u64(a.gas).u128(a.deposit);
  } else if (a.type === "Transfer") {
    w.u8(TAG.Transfer).u128(a.deposit);
  } else if (a.type === "Delegate") {
    w.u8(TAG.Delegate).fixed(a.signedDelegateBytes);
  } else throw new Error(`cannot encode action ${a.type}`);
}

/** Decode one NonDelegateAction. Unknown kinds decode to {type:"Other", tag} and stop the
 *  read, which is fine: the relayer rejects anything but a function call anyway. */
function readAction(r) {
  const tag = r.u8();
  if (tag === TAG.FunctionCall) {
    const method_name = r.string();
    const raw = r.bytes();
    let args;
    try { args = JSON.parse(Buffer.from(raw).toString("utf8")); } catch { args = null; }
    return { type: "FunctionCall", method_name, args, gas: r.u64(), deposit: r.u128() };
  }
  if (tag === TAG.Transfer) return { type: "Transfer", deposit: r.u128() };
  throw Object.assign(new Error(`unsupported action tag ${tag}`), { unsupportedTag: tag });
}

function writePublicKey(w, pub) { w.u8(0).fixed(pub); }
function readPublicKey(r) {
  const kind = r.u8();
  if (kind !== 0) throw new Error("only ed25519 keys are supported");
  return r.fixed(32);
}

// ---- delegate actions (NEP-366) ---------------------------------------------
// Signed over sha256(borsh(u32 discriminant) ++ borsh(DelegateAction)), discriminant = 2^30 + 366.
export const NEP366_DISCRIMINANT = (1 << 30) + 366;

export function encodeDelegateAction(d) {
  const w = new Writer().string(d.sender_id).string(d.receiver_id).u32(d.actions.length);
  d.actions.forEach((a) => writeAction(w, a));
  w.u64(d.nonce).u64(d.max_block_height);
  writePublicKey(w, d.public_key);
  return w.out();
}

export function delegateHash(d) {
  return sha256(Buffer.concat([new Writer().u32(NEP366_DISCRIMINANT).out(), encodeDelegateAction(d)]));
}

/** The payer signs a delegate action with their own key; the result travels to the relayer. */
export function signDelegate(d, signer) {
  const bytes = encodeDelegateAction(d);
  const signature = signBytes(signer, delegateHash(d));
  return Buffer.concat([bytes, Uint8Array.of(0), signature]);
}

/** Parse a SignedDelegateAction and check its signature. */
export function decodeSignedDelegate(buf) {
  const r = new Reader(buf);
  const sender_id = r.string();
  const receiver_id = r.string();
  const n = r.u32();
  if (n > 16) throw new Error("too many actions");
  const actions = [];
  for (let i = 0; i < n; i++) actions.push(readAction(r));
  const d = { sender_id, receiver_id, actions, nonce: r.u64(), max_block_height: r.u64(), public_key: readPublicKey(r) };
  if (r.u8() !== 0) throw new Error("only ed25519 signatures are supported");
  const signature = r.fixed(64);
  r.done();
  // Re-encode to make sure we read exactly what was signed.
  if (!encodeDelegateAction(d).equals(Buffer.from(buf).subarray(0, buf.length - 65))) {
    throw new Error("delegate action does not round-trip");
  }
  const valid = verifyBytes(d.public_key, delegateHash(d), signature);
  return { ...d, signature, valid };
}

// ---- transactions ------------------------------------------------------------
export function encodeTransaction(t) {
  const w = new Writer().string(t.signer_id);
  writePublicKey(w, t.public_key);
  w.u64(t.nonce).string(t.receiver_id).fixed(t.block_hash).u32(t.actions.length);
  t.actions.forEach((a) => writeAction(w, a));
  return w.out();
}

export function signTransaction(t, signer) {
  const bytes = encodeTransaction(t);
  const hash = sha256(bytes);
  return { signed: Buffer.concat([bytes, Uint8Array.of(0), signBytes(signer, hash)]), hash: b58encode(hash) };
}

// ---- JSON-RPC ----------------------------------------------------------------
export async function rpc(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "clinicpay-relayer", method, params }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw Object.assign(new Error(`RPC error: ${JSON.stringify(body.error.cause ?? body.error.data ?? body.error)}`), { rpcError: body.error });
  return body.result;
}

export async function accessKey(url, accountId, pub) {
  return rpc(url, "query", { request_type: "view_access_key", finality: "optimistic", account_id: accountId, public_key: publicKeyString(pub) });
}

export async function latestBlock(url) {
  const b = await rpc(url, "block", { finality: "final" });
  return { height: BigInt(b.header.height), hash: b58decode(b.header.hash) };
}

export async function viewCall(url, contract, method, args) {
  const r = await rpc(url, "query", {
    request_type: "call_function", finality: "optimistic", account_id: contract, method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  });
  return JSON.parse(Buffer.from(r.result).toString("utf8"));
}

/** Send a signed transaction and wait until it is final. */
export async function sendTx(url, signedBytes) {
  return rpc(url, "send_tx", { signed_tx_base64: Buffer.from(signedBytes).toString("base64"), wait_until: "FINAL" });
}

/** Collect the logs and the first failure (if any) of a final transaction outcome. */
export function outcomeSummary(result) {
  const outcomes = [result.transaction_outcome, ...(result.receipts_outcome ?? [])];
  const logs = outcomes.flatMap((o) => o.outcome.logs ?? []);
  const failure = outcomes.map((o) => o.outcome.status?.Failure).find(Boolean) ?? result.status?.Failure ?? null;
  return { logs, failure };
}
