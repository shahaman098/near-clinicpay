#!/usr/bin/env node
// Pre-flight price check against the NHS National Cost Collection.
// Read-only and offline: it answers "is this line item in line with the national
// average unit cost?" before a clinic puts the bill on chain.
//
//   node bench/bench.mjs --code AB23Z --amount 700
//   node bench/bench.mjs --search acupuncture
//   node bench/bench.mjs --list
//
// Source: NHS England, National Cost Collection, National Schedule of NHS costs
// 2025/26, Outpatient Procedures. Contains public sector information licensed
// under the Open Government Licence v3.0.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const CSV = new URL("./nhs_outpatient_procedures_2025_26.csv", import.meta.url);

/** Split one CSV line, honouring double quotes. */
export function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

export function loadCosts(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const iCode = header.indexOf("currency_code");
  const iDesc = header.indexOf("description");
  const iCost = header.indexOf("national_average_unit_cost_gbp");
  if (iCode < 0 || iDesc < 0 || iCost < 0) throw new Error("unexpected CSV header");
  const out = new Map();
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const c = parseCsvLine(line);
    out.set(c[iCode].toUpperCase(), { code: c[iCode], description: c[iDesc], cost: Number(c[iCost]) });
  }
  return out;
}

export function loadFile(file = CSV) {
  return loadCosts(readFileSync(file, "utf8"));
}

/** Case-insensitive lookup by HRG / currency code. */
export function lookup(costs, code) {
  return costs.get(String(code ?? "").toUpperCase());
}

const money = (v) => `£${v.toLocaleString("en-GB", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Compare an amount to the national average. Bands: ±10% in line, ±25% notable. */
export function compare(average, amount) {
  const delta = amount - average;
  const pct = average === 0 ? 0 : (delta / average) * 100;
  const abs = Math.abs(pct);
  const verdict = abs <= 10 ? "in line" : abs <= 25 ? "notable" : "out of line";
  return { average, amount, delta, pct, verdict };
}

const HELP = `clinicpay bench — compare a line item to the NHS national average unit cost

  --code CODE      HRG / currency code to look up (e.g. AB23Z)
  --amount GBP     optional amount you plan to charge, to see the variance
  --search TEXT    list procedures whose description contains TEXT
  --list           list every procedure in the bundled extract
  --json           machine-readable output

Data: NHS England National Cost Collection, National Schedule of NHS costs
2025/26 (Outpatient Procedures), 665 procedures. OGL v3.0. Offline; no network.`;

function main(argv) {
  const { values: v } = parseArgs({
    args: argv,
    options: {
      code: { type: "string" }, amount: { type: "string" }, search: { type: "string" },
      list: { type: "boolean" }, json: { type: "boolean" },
    },
  });
  if (!v.code && !v.search && !v.list) return console.log(HELP);
  const costs = loadFile();

  if (v.list || v.search) {
    const q = (v.search ?? "").toLowerCase();
    const rows = [...costs.values()]
      .filter((r) => !q || r.description.toLowerCase().includes(q))
      .sort((a, b) => a.cost - b.cost);
    if (v.json) return console.log(JSON.stringify(rows, null, 2));
    if (!rows.length) return console.log(`No procedure matches "${v.search}".`);
    for (const r of rows) console.log(`${r.code}\t${money(r.cost)}\t${r.description.slice(0, 90)}`);
    return console.log(`\n${rows.length} procedure(s).`);
  }

  const row = lookup(costs, v.code);
  if (!row) {
    console.error(`No national cost for code "${v.code}". Try --search <text>.`);
    process.exit(1);
  }
  const amount = v.amount === undefined ? undefined : Number(v.amount);
  if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
    console.error("--amount must be a positive number");
    process.exit(1);
  }
  if (v.json) {
    const out = amount === undefined ? row : { ...row, ...compare(row.cost, amount) };
    return console.log(JSON.stringify(out, null, 2));
  }
  console.log(`${row.code}  ${row.description}`);
  console.log(`National average unit cost: ${money(row.cost)}`);
  if (amount === undefined) {
    console.log("\nPass --amount <GBP> to compare a price.");
  } else {
    const c = compare(row.cost, amount);
    const sign = c.delta >= 0 ? "+" : "−";
    console.log(`Your amount:                ${money(amount)}`);
    console.log(`Difference:                 ${sign}${money(Math.abs(c.delta))} (${c.pct >= 0 ? "+" : "−"}${Math.abs(c.pct).toFixed(1)}%) — ${c.verdict}`);
  }
  console.log("\nSource: NHS England National Cost Collection 2025/26 (OGL v3.0).");
}

if (process.argv[1]?.endsWith("bench.mjs")) main(process.argv.slice(2));
