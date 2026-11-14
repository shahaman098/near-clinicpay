#!/usr/bin/env node
// Payer side of a gasless ClinicPay payment: read the share from chain, build the exact
// call (ft_transfer_call on the invoice's token), sign it as a NEP-366 delegate
// action with the payer's own key, and either print it (base64) or POST it to a relayer.
//
//   PAYER_ACCOUNT_ID=patient.testnet PAYER_PRIVATE_KEY=ed25519:... \
//     node relayer/payer.mjs pay --contract clinicpay.testnet --id INV-7 --share 0 [--relayer http://host:3030]
//   ... node relayer/payer.mjs adjudicate --contract ... --id INV-7 --share 1 --approved 30000000 --reason "CO-45" --move-to 0
//
// The key is read from the environment only. The payer spends the share amount in the
// token and no NEAR at all: the relayer pays the gas and the 1 yoctoNEAR NEP-141 deposit.
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { accessKey, latestBlock, parseSecretKey, signDelegate, viewCall } from "./near.mjs";

const DEFAULT_RPC = "https://rpc.testnet.near.org";
const TGAS = 10n ** 12n;
export const DELEGATE_TTL_BLOCKS = 600n;

/** Build the single action a payer delegates for one share. */
export function payAction(contract, invoice, shareIndex) {
  const share = invoice.shares[shareIndex];
  if (!share) throw new Error(`no share #${shareIndex}`);
  if (share.state !== "Open") throw new Error(`share #${shareIndex} is ${share.state}`);
  if (invoice.token) {
    return {
      receiver_id: invoice.token,
      action: {
        type: "FunctionCall", method_name: "ft_transfer_call", gas: 100n * TGAS, deposit: 1n,
        args: { receiver_id: contract, amount: share.amount, msg: JSON.stringify({ invoice_id: invoice.id, share_index: shareIndex }) },
      },
    };
  }
  // Under NEP-366 the relayer would fund pay_share's deposit, so NEAR shares are paid directly.
  throw new Error("this invoice is priced in NEAR: pay it directly with pay_share (gasless payment is for stablecoin invoices)");
}

export async function signFor({ rpc, payer, receiver_id, action }) {
  const key = await accessKey(rpc, payer.accountId, payer.signer.publicKey);
  const block = await latestBlock(rpc);
  const bytes = signDelegate({
    sender_id: payer.accountId,
    receiver_id,
    actions: [action],
    nonce: BigInt(key.nonce) + 1n,
    max_block_height: block.height + DELEGATE_TTL_BLOCKS,
    public_key: payer.signer.publicKey,
  }, payer.signer);
  return bytes.toString("base64");
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const { values: v } = parseArgs({
    args: rest,
    options: {
      contract: { type: "string" }, id: { type: "string" }, share: { type: "string" },
      rpc: { type: "string", default: DEFAULT_RPC }, relayer: { type: "string" },
      approved: { type: "string" }, reason: { type: "string" }, "move-to": { type: "string" },
    },
  });
  if (!["pay", "adjudicate"].includes(cmd)) throw new Error("usage: payer.mjs pay|adjudicate --contract ID --id INVOICE --share N ...");
  if (!v.contract || !v.id || v.share === undefined) throw new Error("--contract, --id and --share are required");
  if (!process.env.PAYER_ACCOUNT_ID || !process.env.PAYER_PRIVATE_KEY) throw new Error("set PAYER_ACCOUNT_ID and PAYER_PRIVATE_KEY");
  const payer = { accountId: process.env.PAYER_ACCOUNT_ID, signer: parseSecretKey(process.env.PAYER_PRIVATE_KEY) };
  const shareIndex = Number(v.share);
  const invoice = await viewCall(v.rpc, v.contract, "get_invoice", { invoice_id: v.id });
  if (!invoice) throw new Error(`no invoice ${v.id}`);

  let call;
  if (cmd === "pay") call = payAction(v.contract, invoice, shareIndex);
  else {
    if (v.approved === undefined || !v.reason) throw new Error("--approved (smallest units) and --reason are required");
    call = {
      receiver_id: v.contract,
      action: {
        type: "FunctionCall", method_name: "adjudicate_share", gas: 30n * TGAS, deposit: 0n,
        args: { invoice_id: v.id, share_index: shareIndex, approved: String(v.approved), reason: v.reason, move_to: v["move-to"] === undefined ? null : Number(v["move-to"]) },
      },
    };
  }
  const signed = await signFor({ rpc: v.rpc, payer, ...call });
  if (!v.relayer) return console.log(signed);
  const res = await fetch(new URL("/relay", v.relayer), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signed_delegate: signed }),
  });
  const body = await res.json();
  console.log(JSON.stringify(body, null, 2));
  if (!res.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => { console.error(`error: ${e.message}`); process.exit(1); });
}
