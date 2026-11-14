#!/usr/bin/env node
// ClinicPay CLI: build invoice arguments, read status, export an accountant CSV.
// Read-only: it never signs anything and never holds keys.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  DEFAULT_RPC, buildCreateArgs, describe, fromUnits, invoicesToCsv, listAll, payCommand, tokenMetas,
  unitsOf, view,
} from "./lib.mjs";

const HELP = `clinicpay <command> [options]

  args    --id ID [--memo TEXT] --line "desc=AMOUNT"... --share "label[:payer]=AMOUNT"... [--due ISO_DATE]
          [--token TOKEN_CONTRACT --decimals N]
          Print the JSON arguments for the contract's create_invoice. Amounts are NEAR, or the
          token's units with --token (a NEP-141 contract such as USDC; --decimals 6 for USDC).
  status  --contract ACCOUNT --id ID [--rpc URL] [--network testnet|mainnet]
          Show an invoice, its status, and the near CLI command that pays each open
          share on that network (default: testnet).
  export  --contract ACCOUNT --clinic ACCOUNT [--out FILE.csv] [--rpc URL]
          One CSV row per share for every invoice of the clinic.

Default RPC: ${DEFAULT_RPC} (testnet).`;

async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help") return console.log(HELP);
  const { values: v } = parseArgs({
    args: rest,
    options: {
      id: { type: "string" }, memo: { type: "string" }, due: { type: "string" },
      line: { type: "string", multiple: true }, share: { type: "string", multiple: true },
      contract: { type: "string" }, clinic: { type: "string" }, out: { type: "string" },
      rpc: { type: "string", default: DEFAULT_RPC },
      network: { type: "string", default: "testnet" },
      token: { type: "string" }, decimals: { type: "string" },
    },
  });

  if (cmd === "args") {
    const dueMs = v.due ? Date.parse(v.due) : null;
    if (v.due && Number.isNaN(dueMs)) throw new Error(`bad --due date: ${v.due}`);
    const decimals = v.decimals === undefined ? 24 : Number(v.decimals);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 38) throw new Error(`bad --decimals: ${v.decimals}`);
    return console.log(JSON.stringify(buildCreateArgs({
      id: v.id, memo: v.memo, lines: v.line, shares: v.share, dueMs, token: v.token ?? null, decimals,
    }), null, 2));
  }
  if (!v.contract) throw new Error("--contract is required");

  if (cmd === "status") {
    if (!v.id) throw new Error("--id is required");
    const inv = await view(v.rpc, v.contract, "get_invoice", { invoice_id: v.id });
    if (!inv) throw new Error(`no invoice "${v.id}" on ${v.contract}`);
    const status = await view(v.rpc, v.contract, "get_status", { invoice_id: v.id });
    const metas = await tokenMetas(v.rpc, [inv]);
    const units = unitsOf(inv, (t) => metas.get(t));
    console.log(describe(inv, status, units));
    if (inv.token) {
      const held = await view(v.rpc, inv.token, "ft_balance_of", { account_id: v.contract });
      console.log(`\nClinicPay holds ${fromUnits(held, units.decimals)} ${units.symbol} of this token (nothing custodied).`);
    }
    inv.shares.forEach((s, i) => {
      if (s.state === "Open") {
        console.log(`\nPay share #${i}:\n  ${payCommand(v.contract, inv.id, i, s.amount, v.network, inv.token ?? null)}`);
      }
    });
    return;
  }
  if (cmd === "export") {
    if (!v.clinic) throw new Error("--clinic is required");
    const invoices = await listAll(v.rpc, v.contract, v.clinic);
    const statuses = new Map();
    for (const inv of invoices) {
      statuses.set(inv.id, await view(v.rpc, v.contract, "get_status", { invoice_id: inv.id }));
    }
    const metas = await tokenMetas(v.rpc, invoices);
    const csv = invoicesToCsv(invoices, (inv) => statuses.get(inv.id), (t) => metas.get(t));
    if (v.out) {
      writeFileSync(v.out, csv);
      console.error(`wrote ${invoices.length} invoice(s) to ${v.out}`);
    } else process.stdout.write(csv);
    return;
  }
  throw new Error(`unknown command "${cmd}"\n\n${HELP}`);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
