import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildCreateArgs, invoicesToCsv, nearToYocto, yoctoToNear, toUnits, fromUnits, payCommand, CSV_HEADER } from "./lib.mjs";

const run = promisify(execFile);
const N = 10n ** 24n;

test("NEAR <-> yocto conversion is exact", () => {
  assert.equal(nearToYocto("1"), N);
  assert.equal(nearToYocto("0.000000000000000000000001"), 1n);
  assert.equal(yoctoToNear(1500000000000000000000000n), "1.5");
  assert.equal(yoctoToNear(0), "0");
  assert.throws(() => nearToYocto("1.0000000000000000000000001"));
  assert.throws(() => nearToYocto("abc"));
});

test("buildCreateArgs balances lines and shares", () => {
  const a = buildCreateArgs({
    id: "INV-1", memo: "Visit",
    lines: ["Consultation=2", "Blood panel=3"],
    shares: ["Patient co-pay:patient.testnet=1", "Insurer:insurer.testnet=4"],
    dueMs: 1790000000000,
  });
  assert.equal(a.shares[0].payer, "patient.testnet");
  assert.equal(a.lines[1].amount, (3n * N).toString());
  assert.equal(a.due_ms, "1790000000000");
  assert.throws(() => buildCreateArgs({ id: "x", lines: ["a=1"], shares: ["s=2"] }), /must equal/);
  assert.equal(buildCreateArgs({ id: "x", lines: ["a=1"], shares: ["Anyone=1"] }).shares[0].payer, null);
});

const invoice = {
  id: "INV-1", payee: "clinic.testnet", memo: 'Visit, "12 Nov"', due_ms: null,
  lines: [{ description: "Consultation", amount: (2n * N).toString() }, { description: "Blood", amount: (3n * N).toString() }],
  shares: [
    { label: "Patient", payer: "patient.testnet", amount: N.toString(), state: "Paid", paid_by: "patient.testnet", paid_at_ms: "1790000000000", refunded_at_ms: null },
    { label: "Insurer", payer: null, amount: (4n * N).toString(), state: "Open", paid_by: null, paid_at_ms: null, refunded_at_ms: null },
  ],
};

const U = 10n ** 6n;
const ftInvoice = {
  id: "FT-1", payee: "clinic.testnet", memo: "Visit", due_ms: null, token: "usdc.testnet",
  lines: [{ description: "Treatment", amount: (50n * U).toString() }],
  shares: [
    { label: "Patient", payer: "patient.testnet", amount: (10n * U).toString(), state: "Open", paid_by: null, paid_at_ms: null, refunded_at_ms: null },
    { label: "Insurer", payer: "insurer.testnet", amount: (40n * U).toString(), state: "Open", paid_by: null, paid_at_ms: null, refunded_at_ms: null },
  ],
};

test("token units: 6-decimal amounts convert exactly", () => {
  assert.equal(toUnits("12.5", 6), 12500000n);
  assert.equal(fromUnits(12500000n, 6), "12.5");
  assert.equal(fromUnits(0, 6), "0");
  assert.throws(() => toUnits("0.0000001", 6));
});

test("buildCreateArgs prices a token invoice in the token's units", () => {
  const a = buildCreateArgs({
    id: "FT-1", lines: ["Treatment=50"], shares: ["Patient:p.testnet=10", "Insurer:i.testnet=40"],
    token: "usdc.testnet", decimals: 6,
  });
  assert.equal(a.token, "usdc.testnet");
  assert.equal(a.lines[0].amount, "50000000");
  assert.equal(buildCreateArgs({ id: "x", lines: ["a=1"], shares: ["s=1"] }).token, null);
  assert.throws(() => buildCreateArgs({ id: "x", lines: ["a=1"], shares: ["s=1"], token: "usdc.testnet" }), /--decimals/);
});

test("payCommand uses ft_transfer_call for token invoices", () => {
  const c = payCommand("pay.testnet", "FT-1", 0, "10000000", "testnet", "usdc.testnet");
  assert.match(c, /usdc.testnet ft_transfer_call/);
  assert.match(c, /"receiver_id":"pay.testnet"/);
  assert.match(c, /attached-deposit '1 yoctoNEAR'/);
  assert.match(payCommand("pay.testnet", "INV-1", 1, N), /pay_share .* attached-deposit '1 NEAR'/);
});

test("CSV has one row per share, escapes quotes and commas", () => {
  const csv = invoicesToCsv([invoice], () => "PartiallyPaid");
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0], CSV_HEADER.join(","));
  assert.match(lines[1], /"Visit, ""12 Nov"""/);
  assert.match(lines[1], /,Paid,patient.testnet,2026-/);
  assert.match(lines[2], /,anyone,4,Open,,,,,PartiallyPaid$/);
});

test("CLI status and export against a mock RPC node", async () => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const p = JSON.parse(body).params;
      const inv = p.args_base64 && JSON.parse(Buffer.from(p.args_base64, "base64")).invoice_id === "FT-1" ? ftInvoice : invoice;
      const reply = {
        get_invoice: inv, get_status: "PartiallyPaid", list_invoices: [invoice, ftInvoice],
        ft_metadata: { spec: "ft-1.0.0", name: "USD Coin", symbol: "USDC", decimals: 6 },
      }[p.method_name];
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: "clinicpay", result: { result: [...Buffer.from(JSON.stringify(reply))] } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const rpc = `http://127.0.0.1:${server.address().port}`;
  try {
    const st = await run("node", ["cli/clinicpay.mjs", "status", "--contract", "c.testnet", "--id", "INV-1", "--rpc", rpc]);
    assert.match(st.stdout, /Invoice INV-1\s+\[PartiallyPaid\]/);
    assert.match(st.stdout, /near contract call-function as-transaction c.testnet pay_share/);
    assert.match(st.stdout, /attached-deposit '4 NEAR'/);
    const ft = await run("node", ["cli/clinicpay.mjs", "status", "--contract", "c.testnet", "--id", "FT-1", "--rpc", rpc]);
    assert.match(ft.stdout, /Paid in: USDC \(NEP-141 token usdc.testnet\)/);
    assert.match(ft.stdout, /TOTAL\s+50 USDC/);
    assert.match(ft.stdout, /usdc.testnet ft_transfer_call/);
    const ex = await run("node", ["cli/clinicpay.mjs", "export", "--contract", "c.testnet", "--clinic", "clinic.testnet", "--rpc", rpc]);
    const rows = ex.stdout.trim().split("\n");
    assert.equal(rows.length, 5);
    assert.match(rows[3], /^FT-1,Visit,clinic.testnet,USDC,usdc.testnet,50,0,/);
  } finally {
    server.close();
  }
});

test("CLI args command prints valid JSON and rejects unbalanced input", async () => {
  const ok = await run("node", ["cli/clinicpay.mjs", "args", "--id", "I1", "--line", "Visit=1", "--share", "Anyone=1"]);
  assert.equal(JSON.parse(ok.stdout).lines[0].amount, N.toString());
  await assert.rejects(run("node", ["cli/clinicpay.mjs", "args", "--id", "I1", "--line", "Visit=1", "--share", "Anyone=2"]), /must equal/);
});
