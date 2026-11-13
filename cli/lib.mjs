// ClinicPay CLI library. No dependencies: Node 18+ (global fetch) only.

export const YOCTO = 10n ** 24n;
export const DEFAULT_RPC = "https://rpc.testnet.near.org";

/** "1.5" -> 1500000000000000000000000n (yoctoNEAR). Rejects more than 24 decimals. */
export function nearToYocto(text) {
  const m = /^(\d+)(?:\.(\d{1,24}))?$/.exec(String(text).trim());
  if (!m) throw new Error(`bad NEAR amount: ${text}`);
  return BigInt(m[1]) * YOCTO + BigInt((m[2] ?? "").padEnd(24, "0") || "0");
}

/** yoctoNEAR (string|bigint) -> "1.5" with trailing zeros trimmed. */
export function yoctoToNear(y) {
  const v = BigInt(y);
  const whole = v / YOCTO;
  const frac = (v % YOCTO).toString().padStart(24, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** Build the arguments for `create_invoice` from friendly flags.
 *  lines:  ["Consultation=2", "Blood panel=3"]
 *  shares: ["Patient co-pay:patient.testnet=1", "Insurer:insurer.testnet=4", "Anyone=0.5"] */
export function buildCreateArgs({ id, memo = "", lines, shares, dueMs = null }) {
  if (!id) throw new Error("--id is required");
  if (!lines?.length) throw new Error("at least one --line is required");
  if (!shares?.length) throw new Error("at least one --share is required");
  const L = lines.map((s) => {
    const i = s.lastIndexOf("=");
    if (i < 1) throw new Error(`bad --line "${s}", expected "description=amount"`);
    return { description: s.slice(0, i), amount: nearToYocto(s.slice(i + 1)).toString() };
  });
  const S = shares.map((s) => {
    const i = s.lastIndexOf("=");
    if (i < 1) throw new Error(`bad --share "${s}", expected "label[:payer]=amount"`);
    const left = s.slice(0, i);
    const c = left.indexOf(":");
    const label = c < 0 ? left : left.slice(0, c);
    const payer = c < 0 ? null : left.slice(c + 1) || null;
    return { label, payer, amount: nearToYocto(s.slice(i + 1)).toString() };
  });
  const sum = (xs) => xs.reduce((a, x) => a + BigInt(x.amount), 0n);
  if (sum(L) !== sum(S)) {
    throw new Error(`shares (${yoctoToNear(sum(S))}) must equal lines (${yoctoToNear(sum(L))})`);
  }
  return { id, memo, lines: L, shares: S, due_ms: dueMs ? String(dueMs) : null };
}

/** Call a view method over JSON-RPC. */
export async function view(rpc, contract, method, args = {}) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "clinicpay",
      method: "query",
      params: {
        request_type: "call_function",
        finality: "final",
        account_id: contract,
        method_name: method,
        args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
      },
    }),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(`RPC error: ${JSON.stringify(body.error.cause ?? body.error)}`);
  if (body.result?.error) throw new Error(`contract error: ${body.result.error}`);
  return JSON.parse(Buffer.from(body.result.result).toString("utf8"));
}

const iso = (ms) => (ms ? new Date(Number(ms)).toISOString() : "");

function csvCell(v) {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_HEADER = [
  "invoice_id", "memo", "clinic", "invoice_total_near", "share_no", "share_label",
  "named_payer", "share_amount_near", "share_state", "paid_by", "paid_at_utc",
  "refunded_at_utc", "invoice_due_utc", "invoice_status",
];

/** One CSV row per share, so an accountant can pivot by payer, state or date. */
export function invoicesToCsv(invoices, statusOf = () => "") {
  const rows = [CSV_HEADER.join(",")];
  for (const inv of invoices) {
    const total = inv.lines.reduce((a, l) => a + BigInt(l.amount), 0n);
    inv.shares.forEach((s, i) => {
      rows.push(
        [
          inv.id, inv.memo, inv.payee, yoctoToNear(total), i, s.label,
          s.payer ?? "anyone", yoctoToNear(s.amount), s.state, s.paid_by ?? "",
          iso(s.paid_at_ms), iso(s.refunded_at_ms), iso(inv.due_ms), statusOf(inv),
        ].map(csvCell).join(","),
      );
    });
  }
  return rows.join("\n") + "\n";
}

/** Page through `list_invoices` for one clinic. */
export async function listAll(rpc, contract, payee) {
  const out = [];
  for (let from = 0; ; from += 50) {
    const page = await view(rpc, contract, "list_invoices", { payee, from_index: from, limit: 50 });
    out.push(...page);
    if (page.length < 50) return out;
  }
}

/** Plain-text summary of one invoice. */
export function describe(inv, status) {
  const total = inv.lines.reduce((a, l) => a + BigInt(l.amount), 0n);
  const out = [
    `Invoice ${inv.id}  [${status}]`,
    `Clinic:  ${inv.payee}`,
    `Memo:    ${inv.memo || "-"}`,
    ...(inv.due_ms ? [`Due:     ${iso(inv.due_ms)}`] : []),
    "Lines:",
    ...inv.lines.map((l) => `  ${l.description.padEnd(28)} ${yoctoToNear(l.amount).padStart(12)} NEAR`),
    `  ${"TOTAL".padEnd(28)} ${yoctoToNear(total).padStart(12)} NEAR`,
    "Shares:",
  ];
  inv.shares.forEach((s, i) => {
    const who = s.payer ? `payer ${s.payer}` : "payer anyone";
    const tail = s.state === "Paid" ? ` by ${s.paid_by} at ${iso(s.paid_at_ms)}` : s.state === "Refunded" ? ` (refunded ${iso(s.refunded_at_ms)})` : "";
    out.push(`  #${i} ${s.label.padEnd(22)} ${yoctoToNear(s.amount).padStart(10)} NEAR  ${s.state}${tail}  (${who})`);
  });
  return out.join("\n");
}

export function payCommand(contract, invoiceId, shareIndex, amountYocto, network = "testnet") {
  return `near contract call-function as-transaction ${contract} pay_share json-args '{"invoice_id":"${invoiceId}","share_index":${shareIndex}}' prepaid-gas '30 Tgas' attached-deposit '${yoctoToNear(amountYocto)} NEAR' network-config ${network}`;
}
