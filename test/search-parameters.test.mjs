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
  const calls = { jobs: [], alerts: [] };
  const sandbox = {
    console, Date, Set, document: { getElementById: id => fields[id] || null, querySelectorAll: () => [] },
    authState: { user: { email: "tester@example.invalid" } },
    searchRunning: false,
    sel: new Set(), selExplicit: false, selSearch: null, curSearch: null,
    alert: message => calls.alerts.push(message), esc: String, hx: String, nav() {},
    applyServerUsage() {}, sectorLabel: key => sandbox.KlirEngine.industryLabel(key),
    KS: {
      S: { plan: "Free", demo: false, usage: { searches: 0, prospects: 0 }, credits: { balance },
        searches: [], prospects: [], icp: null },
      uid: () => "search-test", save() {}, addActivity() {}, notify() {}, audit() {}
    },
    spendCredits() { throw new Error("aucun débit local"); }
  };
  sandbox.window = sandbox;
  sandbox.KlirStore = { LIMITS: { Free: { searches: 10 } } };
  sandbox.KlirAuth = { async searchJob(request) {
    calls.jobs.push(structuredClone(request));
    const payload = request.payload;
    const cost = 5 + Math.ceil(payload.quantity / 10);
    const job = { id: "11111111-1111-4111-8111-11111111111" + calls.jobs.length, status: outcome === "complete" || outcome === "empty" ? "succeeded" : "failed" };
    if (outcome === "disabled") return { ok: false, outcome: "jobs_disabled", balance };
    if (outcome === "error") return { ok: false, outcome: "echec", job, balance, searches: 0 };
    if (outcome === "empty") return { ok: true, outcome: "termine", job, places: [], balance, searches: 0 };
    return { ok: true, outcome: "termine", job, balance: balance - cost, searches: 1,
      places: [{ name: "Atelier test", basic_category: "contractor", release: "2026-10-21.0", contacts_verified: false }] };
  } };
  vm.createContext(sandbox);
  for (const file of ["data.js", "engine.js"]) vm.runInContext(await readFile(new URL(file, root), "utf8"), sandbox);
  sandbox.E = sandbox.KlirEngine;
  vm.runInContext(app.slice(app.indexOf("function sizeLabel"), app.indexOf("function spendCredits")), sandbox);
  vm.runInContext(app.slice(app.indexOf("function formControls"), app.indexOf("function vNew")), sandbox);
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

test("le devis, la demande serveur et l'historique utilisent la quantité avancée", async () => {
  const { sandbox: s, fields, calls } = await harness({ quantity: "10", balance: 6 });
  fields.aCity.value = "laval";
  fields.aArea.value = "montreal_island";
  s.updateSearchQuote();
  assert.equal(fields.searchPrice.textContent, "0");
  assert.match(fields.searchSummary.textContent, /texte indique Montréal/);
  assert.match(fields.searchSummary.textContent, /sélection indique Laval/);
  assert.match(fields.searchSummary.textContent, /aucun crédit n'est réservé/i);
  await s.runSearch(fields.qInput.value);
  assert.equal(calls.jobs.length, 0);
  await s.runSearch(fields.qInput.value, {
    placeConfirmation: "laval", cityKey: "laval", industry: "construction",
    quantity: 10, size: null, area: "montreal_island"
  });
  assert.equal(calls.jobs.length, 1);
  assert.equal(calls.jobs[0].payload.quantity, 10);
  assert.equal(calls.jobs[0].payload.cityKey, "laval");
  assert.equal(calls.jobs[0].payload.industry, "construction");
  assert.equal(calls.jobs[0].payload.place_status, "supported");
  assert.equal(s.KS.S.searches[0].params.quantity, 10);
  assert.equal(s.KS.S.searches[0].params.area, "radius");
  assert.equal(s.KS.S.prospects[0].city, "Laval");
  // Le solde vient du serveur (6 crédits réglés par le serveur), jamais d'un débit local.
  assert.equal(s.KS.S.credits.balance, 0);
});

test("une relance conserve les paramètres sauvegardés, même si le formulaire diffère", async () => {
  const { sandbox: s, fields, calls } = await harness({ quantity: "40", balance: 7 });
  const saved = { industry: "sante", cityKey: "québec", quantity: 20, size: null, area: "radius" };
  fields.aSize.value = "11–50";
  await s.runSearch(fields.qInput.value, saved);
  assert.equal(calls.jobs.length, 0);
  assert.match(fields.prog.innerHTML, /Lieux en contradiction/);
  await s.runSearch(fields.qInput.value, { ...saved, placeConfirmation: "québec" });
  assert.equal(calls.jobs[0].payload.cityKey, "québec");
  assert.equal(calls.jobs[0].payload.industry, "sante");
  assert.equal(calls.jobs[0].payload.quantity, 20);
  assert.equal(s.KS.S.searches[0].params.size, null);
  assert.equal(s.KS.S.credits.balance, 0);
  assert.equal(fields.aQty.value, "20");
});

test("une ancienne quantité de 500 est plafonnée avant réservation et affichage", async () => {
  const { sandbox: s, fields, calls } = await harness();
  await s.runSearch(fields.qInput.value, { quantity: 500, cityKey: "montréal" });
  assert.equal(calls.jobs[0].payload.quantity, 40);
  assert.equal(s.KS.S.searches[0].params.quantity, 40);
  assert.equal(fields.aQty.value, "40");
});

test("un solde insuffisant pour les paramètres effectifs bloque avant tout appel", async () => {
  const { sandbox: s, fields, calls } = await harness({ quantity: "40", balance: 8 });
  await s.runSearch(fields.qInput.value);
  assert.equal(calls.jobs.length, 0);
  assert.match(calls.alerts[0], /9 requis/);
});

for (const outcome of ["disabled", "empty", "error"]) {
  test(`${outcome} : aucun débit ni quota après résolution des paramètres`, async () => {
    const { sandbox: s, fields, calls } = await harness({ outcome });
    await s.runSearch(fields.qInput.value);
    assert.equal(calls.jobs.length, 1);
    assert.equal(s.KS.S.credits.balance, 200);
    assert.equal(s.KS.S.usage.searches, 0);
    assert.equal(s.KS.S.searches.length, 0);
    assert.equal(s.KS.S.prospects.length, 0);
  });
}

test("un double clic n'envoie qu'une demande serveur", async () => {
  const { sandbox: s, fields, calls } = await harness();
  await Promise.all([s.runSearch(fields.qInput.value), s.runSearch(fields.qInput.value)]);
  assert.equal(calls.jobs.length, 1);
  assert.equal(s.KS.S.searches.length, 1);
  assert.equal(s.KS.S.credits.balance, 192);
});
