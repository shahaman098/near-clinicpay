// ClinicPay CLI library. No dependencies: Node 18+ (global fetch) only.

export const YOCTO = 10n ** 24n;
export const DEFAULT_RPC = "https://rpc.testnet.near.org";

/** Units of native NEAR: 24 decimals. */
export const NEAR_UNITS = { decimals: 24, symbol: "NEAR", token: null };

/** "1.5" with `decimals` -> smallest units as BigInt. Rejects extra decimals. */
export function toUnits(text, decimals = 24) {
  const m = new RegExp(`^(\\d+)(?:\\.(\\d{1,${decimals}}))?$`).exec(String(text).trim());
  if (!m || (decimals === 0 && m[2])) throw new Error(`bad amount: ${text} (max ${decimals} decimals)`);
  return BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
}

/** Smallest units (string|bigint) -> "1.5" with trailing zeros trimmed. */
export function fromUnits(v, decimals = 24) {
  const x = BigInt(v);
  const base = 10n ** BigInt(decimals);
  const frac = decimals ? (x % base).toString().padStart(decimals, "0").replace(/0+$/, "") : "";
  return frac ? `${x / base}.${frac}` : `${x / base}`;
}

/** "1.5" -> 1500000000000000000000000n (yoctoNEAR). Rejects more than 24 decimals. */
export const nearToYocto = (text) => toUnits(text, 24);

/** yoctoNEAR (string|bigint) -> "1.5" with trailing zeros trimmed. */
export const yoctoToNear = (y) => fromUnits(y, 24);

/** Build the arguments for `create_invoice` from friendly flags.
 *  lines:  ["Consultation=2", "Blood panel=3"]
 *  shares: ["Patient co-pay:patient.testnet=1", "Insurer:insurer.testnet=4", "Anyone=0.5"]
 *  token:  NEP-141 contract (e.g. a USDC contract) to price the invoice in; omit for NEAR.
 *  decimals: the token's decimals (from its ft_metadata); 24 for NEAR. */
export function buildCreateArgs({ id, memo = "", lines, shares, dueMs = null, token = null, decimals = 24 }) {
  if (token && decimals === 24) throw new Error("--decimals is required with --token (e.g. 6 for USDC)");
  if (!id) throw new Error("--id is required");
  if (!lines?.length) throw new Error("at least one --line is required");
  if (!shares?.length) throw new Error("at least one --share is required");
  const L = lines.map((s) => {
    const i = s.lastIndexOf("=");
    if (i < 1) throw new Error(`bad --line "${s}", expected "description=amount"`);
    return { description: s.slice(0, i), amount: toUnits(s.slice(i + 1), decimals).toString() };
  });
  const S = shares.map((s) => {
    const i = s.lastIndexOf("=");
    if (i < 1) throw new Error(`bad --share "${s}", expected "label[:payer]=amount"`);
    const left = s.slice(0, i);
    const c = left.indexOf(":");
    const label = c < 0 ? left : left.slice(0, c);
    const payer = c < 0 ? null : left.slice(c + 1) || null;
    return { label, payer, amount: toUnits(s.slice(i + 1), decimals).toString() };
  });
  const sum = (xs) => xs.reduce((a, x) => a + BigInt(x.amount), 0n);
  if (sum(L) !== sum(S)) {
    throw new Error(`shares (${fromUnits(sum(S), decimals)}) must equal lines (${fromUnits(sum(L), decimals)})`);
  }
  return { id, memo, lines: L, shares: S, due_ms: dueMs ? String(dueMs) : null, token: token || null };
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
  "invoice_id", "memo", "clinic", "currency", "token_contract", "invoice_total", "share_no",
  "share_label", "named_payer", "share_amount", "share_state", "paid_by", "paid_at_utc",
  "refunded_at_utc", "invoice_due_utc", "invoice_status",
  "billed_amount", "approved_amount", "adjustment_reason", "adjusted_to_share", "adjudicated_at_utc",
  "adj_group", "adj_carc", "adj_retired",
];

/** Units for an invoice: NEAR, or a token's decimals and symbol (from `metaOf`). */
export function unitsOf(inv, metaOf = () => null) {
  if (!inv.token) return NEAR_UNITS;
  const m = metaOf(inv.token);
  if (!m) throw new Error(`no ft_metadata for token ${inv.token}`);
  return { decimals: m.decimals, symbol: m.symbol, token: inv.token };
}

/** Read a NEP-141 token's metadata (decimals, symbol). */
export async function ftMetadata(rpc, token) {
  return view(rpc, token, "ft_metadata", {});
}

/** Metadata for every distinct token used by these invoices, keyed by contract. */
export async function tokenMetas(rpc, invoices) {
  const out = new Map();
  for (const t of new Set(invoices.map((i) => i.token).filter(Boolean))) out.set(t, await ftMetadata(rpc, t));
  return out;
}

/** Parse an X12 group/CARC prefix from an adjudication reason: "CO-45: fee schedule".
 *  Groups: CO, OA, PI, PR (CR is retired in 005010 and is flagged). */
export function parseAdjustment(reason = "") {
  const m = /^(CO|OA|PI|PR|CR)[- ](\d+)\b[\s:,-]*(.*)$/i.exec(String(reason).trim());
  if (!m) return { group: "", carc: "", detail: String(reason), retired: false };
  const group = m[1].toUpperCase();
  return { group, carc: m[2], detail: m[3] || "", retired: group === "CR" };
}

function adjCells(a, d) {
  if (!a) return ["", "", "", "", "", "", "", ""];
  const p = parseAdjustment(a.reason);
  return [fromUnits(a.original, d), fromUnits(a.approved, d), a.reason, a.moved_to ?? "", iso(a.at_ms), p.group, p.carc, p.retired ? "1" : "0"];
}

/** One CSV row per share, so an accountant can pivot by payer, state or date.
 *  Amounts are in each invoice's own currency (NEAR, or the token, e.g. USDC). */
export function invoicesToCsv(invoices, statusOf = () => "", metaOf = () => null) {
  const rows = [CSV_HEADER.join(",")];
  for (const inv of invoices) {
    const u = unitsOf(inv, metaOf);
    const total = inv.lines.reduce((a, l) => a + BigInt(l.amount), 0n);
    inv.shares.forEach((s, i) => {
      rows.push(
        [
          inv.id, inv.memo, inv.payee, u.symbol, u.token ?? "", fromUnits(total, u.decimals), i, s.label,
          s.payer ?? "anyone", fromUnits(s.amount, u.decimals), s.state, s.paid_by ?? "",
          iso(s.paid_at_ms), iso(s.refunded_at_ms), iso(inv.due_ms), statusOf(inv),
          ...adjCells(s.adjudication, u.decimals),
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


const ADJ_SYSTEM = "http://terminology.hl7.org/CodeSystem/adjudication";
const CARC_SYSTEM = "https://x12.org/codes/claim-adjustment-reason-codes";
const CLAIM_TYPE = "http://terminology.hl7.org/CodeSystem/claim-type";

/** FHIR R4 ClaimResponse for one invoice: one item per share, with the submitted and
 *  benefit adjudication categories and the CARC reason when the payer recorded one.
 *  Crypto amounts have no ISO currency, so this uses XXX (no currency) for NEAR and
 *  XTS (test) for token invoices; callers should not read those as fiat. */
export function claimResponse(inv, status, units) {
  const { decimals: d } = units;
  const currency = inv.token ? "XTS" : "XXX";
  const money = (v) => ({ value: Number(fromUnits(v, d)), currency });
  const concept = (system, code, display) => ({ coding: [{ system, code, ...(display ? { display } : {}) }] });
  const adjudicated = inv.shares.find((s) => s.adjudication);
  const items = inv.shares.map((s, i) => {
    const a = s.adjudication;
    const submitted = a ? a.original : s.amount;
    const benefit = s.amount;
    const benefitEntry = { category: concept(ADJ_SYSTEM, "benefit"), amount: money(benefit) };
    if (a) {
      const p = parseAdjustment(a.reason);
      benefitEntry.reason = p.carc
        ? concept(CARC_SYSTEM, `${p.group}-${p.carc}`, p.detail || a.reason)
        : { text: a.reason };
    }
    return { itemSequence: i + 1, adjudication: [{ category: concept(ADJ_SYSTEM, "submitted"), amount: money(submitted) }, benefitEntry] };
  });
  const sum = (f) => inv.shares.reduce((x, s) => x + BigInt(f(s)), 0n);
  return {
    resourceType: "ClaimResponse",
    id: inv.id,
    status: "active",
    type: { coding: [{ system: CLAIM_TYPE, code: "professional" }] },
    use: "claim",
    created: iso(inv.created_ms),
    insurer: { display: adjudicated?.payer ?? "ClinicPay" },
    outcome: inv.shares.some((s) => s.state === "Open") ? "partial" : "complete",
    item: items,
    total: [
      { category: concept(ADJ_SYSTEM, "submitted"), amount: money(sum((s) => s.adjudication?.original ?? s.amount)) },
      { category: concept(ADJ_SYSTEM, "benefit"), amount: money(sum((s) => s.amount)) },
    ],
  };
}

/** Plain-text summary of one invoice. `units` from unitsOf(). */
export function describe(inv, status, units = NEAR_UNITS) {
  const { decimals: d, symbol: sym } = units;
  const total = inv.lines.reduce((a, l) => a + BigInt(l.amount), 0n);
  const out = [
    `Invoice ${inv.id}  [${status}]`,
    `Clinic:  ${inv.payee}`,
    `Paid in: ${units.token ? `${sym} (NEP-141 token ${units.token})` : "NEAR"}`,
    `Memo:    ${inv.memo || "-"}`,
    ...(inv.due_ms ? [`Due:     ${iso(inv.due_ms)}`] : []),
    "Lines:",
    ...inv.lines.map((l) => `  ${l.description.padEnd(28)} ${fromUnits(l.amount, d).padStart(12)} ${sym}`),
    `  ${"TOTAL".padEnd(28)} ${fromUnits(total, d).padStart(12)} ${sym}`,
    "Shares:",
  ];
  inv.shares.forEach((s, i) => {
    const who = s.payer ? `payer ${s.payer}` : "payer anyone";
    const tail = s.state === "Paid" ? ` by ${s.paid_by} at ${iso(s.paid_at_ms)}` : s.state === "Refunded" ? ` (refunded ${iso(s.refunded_at_ms)})` : "";
    out.push(`  #${i} ${s.label.padEnd(22)} ${fromUnits(s.amount, d).padStart(10)} ${sym}  ${s.state}${tail}  (${who})`);
    const a = s.adjudication;
    if (a) {
      const moved = BigInt(a.original) - BigInt(a.approved);
      out.push(`       adjudicated by ${s.payer} at ${iso(a.at_ms)}: billed ${fromUnits(a.original, d)}, approved ${fromUnits(a.approved, d)} ${sym} ("${a.reason}")` +
        (moved > 0n ? `; ${fromUnits(moved, d)} ${sym} moved to share #${a.moved_to}` : ""));
    }
  });
  return out.join("\n");
}

/** The near-cli-rs command that pays one share. NEAR invoices call pay_share with
 *  the amount attached; token invoices call ft_transfer_call on the token. */
export function payCommand(contract, invoiceId, shareIndex, amount, network = "testnet", token = null) {
  if (token) {
    const msg = JSON.stringify({ invoice_id: invoiceId, share_index: shareIndex });
    const args = JSON.stringify({ receiver_id: contract, amount: String(amount), msg });
    return `near contract call-function as-transaction ${token} ft_transfer_call json-args '${args}' prepaid-gas '100 Tgas' attached-deposit '1 yoctoNEAR' network-config ${network}`;
  }
  return `near contract call-function as-transaction ${contract} pay_share json-args '{"invoice_id":"${invoiceId}","share_index":${shareIndex}}' prepaid-gas '30 Tgas' attached-deposit '${yoctoToNear(amount)} NEAR' network-config ${network}`;
}
