import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../src/", import.meta.url);
const app = await readFile(new URL("app.js", root), "utf8");

async function harness({ quantity = "30", balance = 200, outcome = "complete" } = {}) {
  const fields = Object.fromEntries(Object.entries({
    qInput: "30 entreprises de rénovation à Montréal", aInd: "construction",
    aCity: "montréal", aQty: quantity, aSize: "", aArea: "radius",
    searchPrice: "", searchSummary: "", parsed: "", prog: ""
  }).map(([id, value]) => [id, { value, innerHTML: "", textContent: "" }]));
  const calls = { reservations: [], sources: [], settlements: [], alerts: [] };
  const sandbox = {
    console, Date, Set, document: { getElementById: id => fields[id] || null, querySelectorAll: () => [] },
    authState: { user: { email: "tester@example.invalid" } },
    searchRunning: false, pendingDebitKey: "", serverLedgerApplied: false, serverSearches: null,
    sel: new Set(), selExplicit: false, selSearch: null, curSearch: null,
    alert: message => calls.alerts.push(message), esc: String, nav() {},
    applyServerUsage() {}, sectorLabel: key => sandbox.KlirEngine.industryLabel(key),
    KS: {
      S: { plan: "Free", demo: false, usage: { searches: 0, prospects: 0 }, credits: { balance },
        searches: [], prospects: [], icp: null },
      uid: () => "search-test", save() {}, addActivity() {}, notify() {}, audit() {}
    },
    async reserveServerUsage(amount, label) { calls.reservations.push({ amount, label }); return { ok: true }; },
    async settleServerUsage(debit) { calls.settlements.push(debit); return true; },
    spendCredits(amount) { sandbox.KS.S.credits.balance -= amount; return true; }
  };
  sandbox.window = sandbox;
  sandbox.KlirStore = { LIMITS: { Free: { searches: 10 } } };
  sandbox.KlirSources = { osm: { async search(params, limit) {
    calls.sources.push({ params: structuredClone(params), limit });
    if (outcome === "error") throw new Error("source indisponible");
    const rows = outcome === "empty" ? [] : [{
      id: "osm_node_1", company_name: "Atelier test", city: params.city.city,
      industry: "Construction / Rénovation", industry_key: "construction",
      source: "OpenStreetMap", phone: "", public_email: "", website: "", signals: []
    }];
    if (outcome === "partial") rows.osmCoverage = { status: "partial" };
    return rows;
  } } };
  vm.createContext(sandbox);
  for (const file of ["data.js", "engine.js"]) vm.runInContext(await readFile(new URL(file, root), "utf8"), sandbox);
  sandbox.E = sandbox.KlirEngine;
  vm.runInContext(app.slice(app.indexOf("function sizeLabel"), app.indexOf("function spendCredits")), sandbox);
  vm.runInContext(app.slice(app.indexOf("function formSearchParams"), app.indexOf("function vNew")), sandbox);
  vm.runInContext(app.slice(app.indexOf("async function runSearch"), app.indexOf("function toCrm")), sandbox);
  return { sandbox, fields, calls };
}

test("les quantités et devis restent bornés à la couverture réellement proposée", async () => {
  const { sandbox: s } = await harness();
  for (const [query, expected] of [
    ["30 entreprises de rénovation à Montréal", 30],
    ["500 entreprises à Montréal", 40],
    ["5 entreprises à Montréal", 10],
    ["entreprises de 11-50 employés à Montréal", 40],
    ["entreprises créées en 2025 à Montréal", 40],
    ["20 cliniques dentaires à Québec", 20],
    ["20 construction companies à Toronto", 20]
  ]) {
    const params = s.E.parseQuery(query);
    assert.equal(params.quantity, expected, query);
    assert.equal(s.quotedSearchCost(query), 5 + Math.ceil(expected / 10));
  }
});

test("le devis, la réservation, l'appel OSM et l'historique utilisent la quantité avancée", async () => {
  const { sandbox: s, fields, calls } = await harness({ quantity: "10", balance: 6 });
  fields.aCity.value = "laval";
  fields.aArea.value = "montreal_island";
  s.updateSearchQuote();
  assert.equal(fields.searchPrice.textContent, "6");
  assert.match(fields.searchSummary.textContent, /Laval.*10 résultats maximum.*rayon de 2,2 km/);
  await s.runSearch(fields.qInput.value);
  assert.equal(calls.reservations[0].amount, 6);
  assert.equal(calls.sources[0].limit, 10);
  assert.equal(calls.sources[0].params.quantity, 10);
  assert.equal(calls.sources[0].params.city.city, "Laval");
  assert.equal(calls.sources[0].params.area, "radius");
  assert.equal(s.KS.S.searches[0].params.quantity, 10);
  assert.equal(s.KS.S.credits.balance, 0);
  assert.deepEqual(calls.settlements, [true]);
});

test("une relance conserve les paramètres sauvegardés, même si le formulaire diffère", async () => {
  const { sandbox: s, fields, calls } = await harness({ quantity: "40", balance: 7 });
  const saved = { industry: "sante", cityKey: "québec", quantity: 20, size: null, area: "radius" };
  fields.aSize.value = "11–50";
  await s.runSearch(fields.qInput.value, saved);
  assert.equal(calls.reservations[0].amount, 7);
  assert.equal(calls.sources[0].params.city.city, "Québec");
  assert.equal(calls.sources[0].params.industry, "sante");
  assert.equal(calls.sources[0].params.quantity, 20);
  assert.equal(calls.sources[0].params.size, null);
  assert.equal(fields.aQty.value, "20");
});

test("une ancienne quantité de 500 est plafonnée avant réservation et affichage", async () => {
  const { sandbox: s, fields, calls } = await harness();
  await s.runSearch(fields.qInput.value, { quantity: 500, cityKey: "montréal" });
  assert.equal(calls.reservations[0].amount, 9);
  assert.equal(calls.sources[0].limit, 40);
  assert.equal(s.KS.S.searches[0].params.quantity, 40);
  assert.equal(fields.aQty.value, "40");
});

test("un solde insuffisant pour les paramètres effectifs bloque avant tout appel", async () => {
  const { sandbox: s, fields, calls } = await harness({ quantity: "40", balance: 8 });
  await s.runSearch(fields.qInput.value);
  assert.equal(calls.reservations.length, 0);
  assert.equal(calls.sources.length, 0);
  assert.match(calls.alerts[0], /9 requis/);
});

for (const outcome of ["partial", "empty", "error"]) {
  test(`${outcome} : aucun débit ni quota après résolution des paramètres`, async () => {
    const { sandbox: s, fields, calls } = await harness({ outcome });
    await s.runSearch(fields.qInput.value);
    assert.equal(s.KS.S.credits.balance, 200);
    assert.equal(s.KS.S.usage.searches, 0);
    assert.equal(calls.settlements.includes(true), false);
    assert.equal(s.KS.S.searches.length, outcome === "partial" ? 1 : 0);
    if (outcome === "partial") assert.equal(s.KS.S.prospects[0].collection_status, "partial");
  });
}

test("un double clic ne réserve et n'interroge la source qu'une fois", async () => {
  const { sandbox: s, fields, calls } = await harness();
  await Promise.all([s.runSearch(fields.qInput.value), s.runSearch(fields.qInput.value)]);
  assert.equal(calls.sources.length, 1);
  assert.equal(calls.reservations.length, 1);
  assert.equal(s.KS.S.searches.length, 1);
  assert.equal(s.KS.S.credits.balance, 192);
});
