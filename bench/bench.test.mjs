import test from "node:test";
import assert from "node:assert/strict";
import { parseCsvLine, loadCosts, compare, lookup } from "./bench.mjs";

const sample = [
  "currency_code,description,national_average_unit_cost_gbp",
  'AA33C,"Conventional EEG, EMG or Nerve Conduction Studies, 19 years and over",347.80',
  "AB23Z,Acupuncture for Pain Management,231.56",
].join("\n");

test("CSV parser keeps commas inside quotes", () => {
  const row = parseCsvLine('AA33C,"Conventional EEG, EMG or Nerve Conduction Studies, 19 years and over",347.80');
  assert.equal(row.length, 3);
  assert.match(row[1], /EEG, EMG/);
});

test("loadCosts keys by upper-case code", () => {
  const costs = loadCosts(sample);
  assert.equal(costs.size, 2);
  assert.equal(costs.get("AA33C").cost, 347.8);
  assert.equal(lookup(costs, "ab23z").description, "Acupuncture for Pain Management");
});

test("compare bands the variance", () => {
  assert.equal(compare(100, 105).verdict, "in line");
  assert.equal(compare(100, 120).verdict, "notable");
  assert.equal(compare(100, 140).verdict, "out of line");
  assert.equal(compare(100, 70).verdict, "out of line");
  assert.equal(compare(100, 100).pct, 0);
  assert.equal(compare(200, 150).delta, -50);
});

test("compare handles a zero average without dividing by zero", () => {
  assert.equal(compare(0, 10).pct, 0);
});
