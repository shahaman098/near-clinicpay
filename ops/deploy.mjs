#!/usr/bin/env node
// Deploy ClinicPay to an account you control and initialise it, in one transaction.
//
//   npm run build:wasm
//   DEPLOY_ACCOUNT_ID=clinicpay-demo.testnet DEPLOY_PRIVATE_KEY=ed25519:... node ops/deploy.mjs
//   ... node ops/deploy.mjs --rpc https://rpc.mainnet.near.org      (mainnet: think twice)
//
// The account needs about 4 NEAR for storage (the wasm is ~360 KB). The key is read
// from the environment only and never printed. Re-running on an initialised account
// with --no-init upgrades the code and keeps the state.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { accountFromEnv, signAndSend, viewCall } from "../relayer/near.mjs";

const { values: v } = parseArgs({
  options: {
    rpc: { type: "string", default: "https://rpc.testnet.near.org" },
    wasm: { type: "string", default: fileURLToPath(new URL("../contract/target/wasm32-unknown-unknown/release/clinicpay.wasm", import.meta.url)) },
    "no-init": { type: "boolean", default: false },
  },
});

try {
  const account = accountFromEnv("DEPLOY");
  const code = readFileSync(v.wasm);
  const actions = [{ type: "DeployContract", code }];
  if (!v["no-init"]) actions.push({ type: "FunctionCall", method_name: "new", args: {}, gas: 30n * 10n ** 12n, deposit: 0n });
  console.error(`deploying ${code.length} bytes to ${account.accountId} via ${v.rpc}`);
  const r = await signAndSend(v.rpc, account, account.accountId, actions);
  if (r.failure) throw new Error(`deploy failed: ${JSON.stringify(r.failure)}`);
  const invoices = await viewCall(v.rpc, account.accountId, "list_invoices", { payee: account.accountId, from_index: 0, limit: 1 });
  console.log(JSON.stringify({ ok: true, contract: account.accountId, tx_hash: r.hash, view_check: Array.isArray(invoices) }));
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
