#!/usr/bin/env node
// ClinicPay CLI: build invoice arguments, read status, export an accountant CSV.
// Read-only: it never signs anything and never holds keys.
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  DEFAULT_RPC, buildCreateArgs, claimResponse, describe, fromUnits, invoicesToCsv, listAll, payCommand, tokenMetas,
  unitsOf, view,
} from "./lib.mjs";
import { assetLabel, checkQuote, findAsset, preflight, quote, status as intentStatus, tokens } from "./intents.mjs";

const HELP = `clinicpay <command> [options]

  args    --id ID [--memo TEXT] --line "desc=AMOUNT"... --share "label[:payer]=AMOUNT"... [--due ISO_DATE]
          [--token TOKEN_CONTRACT --decimals N]
          Print the JSON arguments for the contract's create_invoice. Amounts are NEAR, or the
          token's units with --token (a NEP-141 contract such as USDC; --decimals 6 for USDC).
  status  --contract ACCOUNT --id ID [--rpc URL] [--network testnet|mainnet]
          Show an invoice, its status, and the near CLI command that pays each open
          share on that network (default: testnet).
  export  --contract ACCOUNT --clinic ACCOUNT [--out FILE.csv] [--rpc URL]
          One CSV row per share for every invoice of the clinic (835-style, not X12 835).
  export-fhir --contract ACCOUNT --id ID [--out FILE.json] [--rpc URL]
          FHIR R4 ClaimResponse for one invoice, with submitted/benefit adjudication.
  pay-from-any-chain --contract C --id ID --share N --from CHAIN:SYMBOL --refund-to ADDR
          [--live] [--rpc URL]
          Price a share for payment from another chain via NEAR Intents (1Click).
          Dry by default; --live returns the deposit address. Mainnet only.
  intent-status --deposit ADDRESS
          Status of a 1Click deposit address.

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
      from: { type: "string" }, "refund-to": { type: "string" }, live: { type: "boolean" },
      deposit: { type: "string" },
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
  if (cmd === "pay-from-any-chain") {
    if (!v.id || v.share === undefined || !v.from || !v["refund-to"]) {
      throw new Error("--id, --share, --from CHAIN:SYMBOL and --refund-to are required");
    }
    const assets = await tokens();
    const origin = findAsset(assets, v.from);
    if (!origin) throw new Error(`unknown origin asset "${v.from}" (try base:USDC, sol:SOL, btc:BTC)`);
    const index = Number(v.share);
    const { invoice, amount, assetId } = await preflight({
      rpc: v.rpc, contract: v.contract, invoiceId: v.id, shareIndex: index, assets,
    });
    const q = await quote({
      originAsset: origin.assetId, destinationAsset: assetId, amount,
      recipient: v.contract, msg: { invoice_id: invoice.id, share_index: index },
      refundTo: v["refund-to"], dry: !v.live,
    });
    const out = checkQuote(q, amount);
    const inHuman = fromUnits(out.amountIn, origin.decimals);
    console.log(`Invoice ${invoice.id}  share #${index}`);
    console.log(`Pay from: ${assetLabel(origin)} (${origin.assetId})`);
    console.log(`Send:     up to ${inHuman} ${origin.symbol} (quoted ${out.amountInFormatted}; min ${fromUnits(out.minAmountIn, origin.decimals)})`);
    console.log(`Receive:  exactly ${fromUnits(amount, invoice.token ? 6 : 24)} on NEAR to ${v.contract}`);
    console.log(`Estimate: ${out.timeEstimate}s, withdraw fee ${out.withdrawFee}, min out ${out.minAmountOut}`);
    if (v.live) {
      console.log(`\nDeposit ${out.amountIn} of ${assetLabel(origin)} to:`);
      console.log(`  ${out.depositAddress}`);
      console.log(`  deadline ${out.deadline}`);
      console.log(`Track: node cli/clinicpay.mjs intent-status --deposit ${out.depositAddress}`);
    } else {
      console.log("\nDry quote. Nothing to send; re-run with --live for a deposit address.");
    }
    return;
  }
  if (cmd === "intent-status") {
    if (!v.deposit) throw new Error("--deposit is required");
    console.log(JSON.stringify(await intentStatus(v.deposit), null, 2));
    return;
  }
  if (cmd === "export-fhir") {
    if (!v.id) throw new Error("--id is required");
    const inv = await view(v.rpc, v.contract, "get_invoice", { invoice_id: v.id });
    if (!inv) throw new Error(`no invoice "${v.id}" on ${v.contract}`);
    const status = await view(v.rpc, v.contract, "get_status", { invoice_id: v.id });
    const metas = await tokenMetas(v.rpc, [inv]);
    const body = JSON.stringify(claimResponse(inv, status, unitsOf(inv, (t) => metas.get(t))), null, 2);
    if (v.out) { writeFileSync(v.out, body + "\n"); console.error(`wrote ${v.id} to ${v.out}`); }
    else console.log(body);
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
