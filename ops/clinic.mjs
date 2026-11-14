#!/usr/bin/env node
// Clinic actions signed with the clinic's own key, so a clinic needs no near-cli.
//
//   CLINIC_ACCOUNT_ID=clinic.testnet CLINIC_PRIVATE_KEY=ed25519:... node ops/clinic.mjs create \
//     --contract clinicpay.testnet --id INV-8 --memo "GP visit" --token usdc.testnet --decimals 6 \
//     --line "Consultation=20" --line "Blood panel=30" \
//     --share "Patient co-pay:patient.testnet=10" --share "Insurer:insurer.testnet=40"
//   ... node ops/clinic.mjs cancel --contract clinicpay.testnet --id INV-8
//
// Amounts use the same syntax as `clinicpay args`. The key is read from the
// environment only and never printed.
import { parseArgs } from "node:util";
import { buildCreateArgs } from "../cli/lib.mjs";
import { accountFromEnv, signAndSend } from "../relayer/near.mjs";

const TGAS = 10n ** 12n;
const [cmd, ...rest] = process.argv.slice(2);
const { values: v } = parseArgs({
  args: rest,
  options: {
    contract: { type: "string" }, id: { type: "string" }, memo: { type: "string" }, due: { type: "string" },
    line: { type: "string", multiple: true }, share: { type: "string", multiple: true },
    token: { type: "string" }, decimals: { type: "string" },
    rpc: { type: "string", default: "https://rpc.testnet.near.org" },
  },
});

try {
  if (!["create", "cancel"].includes(cmd)) throw new Error("usage: clinic.mjs create|cancel --contract ID --id INVOICE ...");
  if (!v.contract || !v.id) throw new Error("--contract and --id are required");
  const clinic = accountFromEnv("CLINIC");
  let call;
  if (cmd === "create") {
    const dueMs = v.due ? Date.parse(v.due) : null;
    if (v.due && Number.isNaN(dueMs)) throw new Error(`bad --due date: ${v.due}`);
    const args = buildCreateArgs({
      id: v.id, memo: v.memo, lines: v.line, shares: v.share, dueMs, token: v.token ?? null,
      decimals: v.decimals === undefined ? 24 : Number(v.decimals),
    });
    call = { method_name: "create_invoice", args };
  } else call = { method_name: "cancel_invoice", args: { invoice_id: v.id } };
  const r = await signAndSend(v.rpc, clinic, v.contract, [{ type: "FunctionCall", ...call, gas: 100n * TGAS, deposit: 0n }]);
  console.log(JSON.stringify({ ok: !r.failure, tx_hash: r.hash, logs: r.logs, failure: r.failure }, null, 2));
  if (r.failure) process.exitCode = 1;
} catch (e) {
  console.error(`error: ${e.message}`);
  process.exit(1);
}
