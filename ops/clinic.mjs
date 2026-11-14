#!/usr/bin/env node
// Clinic actions signed with the clinic's own key, so a clinic needs no near-cli.
//
//   CLINIC_ACCOUNT_ID=clinic.testnet CLINIC_PRIVATE_KEY=ed25519:... node ops/clinic.mjs create \
//     --contract clinicpay.testnet --id INV-8 --memo "GP visit" --token usdc.testnet --decimals 6 \
//     --line "Consultation=20" --line "Blood panel=30" \
//     --share "Patient co-pay:patient.testnet=10" --share "Insurer:insurer.testnet=40"
//   ... node ops/clinic.mjs cancel --contract clinicpay.testnet --id INV-8
//   ... node ops/clinic.mjs register --contract clinicpay.testnet --token usdc.testnet
//
// `register` pays the token's storage_deposit for ClinicPay and for the clinic, which a
// token invoice needs before anyone can pay it. Accounts already registered are skipped,
// so running it twice costs nothing.
//
// Amounts use the same syntax as `clinicpay args`. The key is read from the
// environment only and never printed.
import { parseArgs } from "node:util";
import { buildCreateArgs } from "../cli/lib.mjs";
import { accountFromEnv, signAndSend, viewCall } from "../relayer/near.mjs";

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
  if (!["create", "cancel", "register"].includes(cmd)) {
    throw new Error("usage: clinic.mjs create|cancel --contract ID --id INVOICE ... | register --contract ID --token TOKEN");
  }
  if (!v.contract) throw new Error("--contract is required");
  const clinic = accountFromEnv("CLINIC");
  if (cmd === "register") {
    if (!v.token) throw new Error("register needs --token");
    const bounds = await viewCall(v.rpc, v.token, "storage_balance_bounds", {});
    const min = BigInt(bounds.min);
    const results = [];
    for (const who of [v.contract, clinic.accountId]) {
      const have = await viewCall(v.rpc, v.token, "storage_balance_of", { account_id: who });
      if (have !== null) { results.push({ account: who, registered: "already" }); continue; }
      const r = await signAndSend(v.rpc, clinic, v.token, [{
        type: "FunctionCall", method_name: "storage_deposit", args: { account_id: who, registration_only: true },
        gas: 30n * TGAS, deposit: min,
      }]);
      results.push({ account: who, registered: r.failure ? "failed" : "now", tx_hash: r.hash, failure: r.failure });
      if (r.failure) process.exitCode = 1;
    }
    console.log(JSON.stringify({ ok: !process.exitCode, token: v.token, deposit_yocto: min.toString(), results }, null, 2));
    process.exit(process.exitCode ?? 0);
  }
  if (!v.id) throw new Error("--id is required");
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
