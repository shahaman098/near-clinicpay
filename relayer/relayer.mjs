#!/usr/bin/env node
// ClinicPay gas relayer (NEP-366 meta transactions). A payer signs a delegate action
// with their own key; the relayer checks it against the policy, wraps it in a
// transaction it signs and pays gas for, and submits it. Payers need no NEAR for gas.
//
//   RELAYER_ACCOUNT_ID=relayer.testnet RELAYER_PRIVATE_KEY=ed25519:... \
//     node relayer/relayer.mjs serve --contract clinicpay.testnet --token usdc.testnet --port 3030
//   ... node relayer/relayer.mjs submit --contract ... --token ... <base64 signed delegate>
//
// The key is read from the environment only and is never logged or written anywhere.
import http from "node:http";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  accessKey, decodeSignedDelegate, latestBlock, outcomeSummary, parseSecretKey, sendTx, signTransaction, viewCall,
} from "./near.mjs";
import { Refused, checkInvoice, checkShape } from "./policy.mjs";

const DEFAULT_RPC = "https://rpc.testnet.near.org";

export function loadRelayer(env = process.env) {
  if (!env.RELAYER_ACCOUNT_ID || !env.RELAYER_PRIVATE_KEY) {
    throw new Error("set RELAYER_ACCOUNT_ID and RELAYER_PRIVATE_KEY in the environment");
  }
  return { accountId: env.RELAYER_ACCOUNT_ID, signer: parseSecretKey(env.RELAYER_PRIVATE_KEY) };
}

/** Validate and relay one signed delegate. Returns {ok, tx_hash, logs, failure} or throws Refused. */
export async function relay(b64, { rpc, contract, tokens, relayer }) {
  let d;
  try { d = decodeSignedDelegate(Buffer.from(String(b64), "base64")); } catch (e) { throw new Refused(`malformed delegate: ${e.message}`); }
  const block = await latestBlock(rpc);
  const intent = checkShape(d, { contract, tokens, height: block.height });
  const invoice = await viewCall(rpc, contract, "get_invoice", { invoice_id: intent.invoice_id });
  checkInvoice(intent, d.sender_id, invoice);

  const key = await accessKey(rpc, relayer.accountId, relayer.signer.publicKey);
  const signedDelegateBytes = Buffer.from(String(b64), "base64");
  // The outer transaction goes to the payer's account: that is where the delegate executes.
  const { signed, hash } = signTransaction({
    signer_id: relayer.accountId,
    public_key: relayer.signer.publicKey,
    nonce: BigInt(key.nonce) + 1n,
    receiver_id: d.sender_id,
    block_hash: block.hash,
    actions: [{ type: "Delegate", signedDelegateBytes }],
  }, relayer.signer);
  const result = await sendTx(rpc, signed);
  const { logs, failure } = outcomeSummary(result);
  return { ok: !failure, tx_hash: hash, sender: d.sender_id, kind: intent.kind, invoice_id: intent.invoice_id, share_index: intent.share_index, logs, failure };
}

function opts(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      contract: { type: "string" }, token: { type: "string", multiple: true },
      rpc: { type: "string", default: DEFAULT_RPC }, port: { type: "string", default: "3030" },
      origin: { type: "string", default: "*" },
    },
  });
  if (!values.contract) throw new Error("--contract is required");
  return { ...values, tokens: values.token ?? [], positionals };
}

function serve(o, relayer) {
  const server = http.createServer(async (req, res) => {
    const reply = (code, body) => {
      res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": o.origin, "access-control-allow-headers": "content-type" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") return reply(204, {});
    if (req.method === "GET" && req.url === "/health") {
      return reply(200, { ok: true, relayer: relayer.accountId, contract: o.contract, tokens: o.tokens });
    }
    if (req.method !== "POST" || req.url !== "/relay") return reply(404, { error: "POST /relay {signed_delegate}" });
    let body = "";
    for await (const c of req) { body += c; if (body.length > 64 * 1024) return reply(413, { error: "too large" }); }
    try {
      const { signed_delegate } = JSON.parse(body);
      const r = await relay(signed_delegate, { rpc: o.rpc, contract: o.contract, tokens: o.tokens, relayer });
      reply(r.ok ? 200 : 422, r);
    } catch (e) {
      reply(e instanceof Refused ? 403 : 500, { error: e.message });
    }
  });
  server.listen(Number(o.port), () => console.error(`relayer ${relayer.accountId} on :${o.port} for ${o.contract}`));
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const o = opts(rest);
  const relayer = loadRelayer();
  if (cmd === "serve") return serve(o, relayer);
  if (cmd === "submit") {
    if (!o.positionals[0]) throw new Error("submit needs the base64 signed delegate");
    try {
      const r = await relay(o.positionals[0], { rpc: o.rpc, contract: o.contract, tokens: o.tokens, relayer });
      console.log(JSON.stringify(r, null, 2));
      if (!r.ok) process.exitCode = 1;
    } catch (e) {
      console.log(JSON.stringify({ ok: false, refused: e instanceof Refused, error: e.message }));
      process.exitCode = e instanceof Refused ? 3 : 1;
    }
    return;
  }
  throw new Error("usage: relayer.mjs serve|submit --contract ID [--token ID]... [--rpc URL] [--port N]");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
}
