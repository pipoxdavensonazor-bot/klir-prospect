import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

const montreal = { city: "Montréal", province: "QC", country: "Canada", lat: 45.5017, lng: -73.5673 };

function clockedSandbox() {
  const sandbox = {
    console: { info() {}, warn() {}, error() {}, log() {} },
    URL,
    AbortController,
    Date,
    clearTimeout() {},
    setTimeout(fn, ms) {
      if (ms >= 18000) return 0;
      fn();
      return 1;
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}

async function loadSources(sandbox) {
  vm.runInContext(await readFile(new URL("../src/data.js", import.meta.url), "utf8"), sandbox);
  vm.runInContext(await readFile(new URL("../src/engine.js", import.meta.url), "utf8"), sandbox);
  vm.runInContext(await readFile(new URL("../src/sources.js", import.meta.url), "utf8"), sandbox);
  return sandbox;
}

function scriptedFetch(body) {
  return async (url) => {
    assert.equal(String(url).includes("overpass-api.de"), true);
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

async function searchWith(body, status = 200) {
  const sandbox = clockedSandbox();
  sandbox.fetch = async (url) => {
    assert.equal(String(url).includes("overpass-api.de"), true);
    if (status !== 200) return new Response("nope", { status });
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const loaded = await loadSources(sandbox);
  return loaded;
}

test("une réponse complète, vide, partielle ou en erreur suit le tarif sans changer le compteur avant validation", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const helpers = app.slice(app.indexOf("function searchAccounting"), app.indexOf("function spendCredits"));
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(helpers, sandbox);
  const cost = 5 + Math.ceil(30 / 10);
  assert.equal(cost, 8);
  const complete = sandbox.searchAccounting("complete");
  const partial = sandbox.searchAccounting("partial");
  assert.equal(complete.debit, true);
  assert.equal(complete.searches, 1);
  assert.equal(partial.debit, false);
  assert.equal(partial.searches, 1);
  for (const kind of ["error", "empty", "partial-empty"]) {
    const outcome = sandbox.searchAccounting(kind);
    assert.equal(outcome.debit, false, kind);
    assert.equal(outcome.searches, 0, kind);
  }
  const search = app.slice(app.indexOf("async function runSearch"), app.indexOf("function toCrm"));
  assert.equal(search.includes("5+Math.ceil(_costQ/10)"), true);
  assert.equal(search.includes('if(account.debit&&!spendCredits(searchCost,"Recherche"))return;'), true);
  assert.equal(search.includes("KS.S.usage.searches+=account.searches"), true);
  assert.ok(search.indexOf("Recherche échouée") < search.indexOf("spendCredits(searchCost"));
  assert.ok(search.indexOf("Recherche partielle, aucun résultat reçu") < search.indexOf("spendCredits(searchCost"));
  assert.ok(search.indexOf("Recherche terminée, aucun résultat") < search.indexOf("spendCredits(searchCost"));
  assert.equal(app.includes("genProspects"), false);
});

test("deux entreprises homonymes restent distinctes, un objet répété et des champs concordants se complètent", async () => {
  const sandbox = clockedSandbox();
  sandbox.fetch = scriptedFetch({
    elements: [
      { type: "node", id: 10, tags: { name: "Atelier Nord", craft: "joiner", phone: "+1 514 555-0100" } },
      { type: "way", id: 11, tags: { name: "Atelier Nord", craft: "joiner", phone: "514-555-0100", email: "nord@exemple.ca", "addr:housenumber": "10", "addr:street": "rue du Pont" } },
      { type: "node", id: 12, tags: { name: "Atelier Nord", craft: "builder", phone: "+1 514 555-0199", "addr:housenumber": "80", "addr:street": "rue Ontario" } },
      { type: "relation", id: 13, tags: { name: "Atelier Nord", office: "construction_company" } },
      { type: "node", id: 14, tags: { name: "Atelier Nord", craft: "painter" } }
    ]
  });
  const loaded = await loadSources(sandbox);
  const rows = await loaded.KlirSources.osm.search({ industry: "construction", city: montreal }, 30);
  assert.equal(rows.length, 4);
  const corroborated = rows.find((row) => row.osm_ids.includes("way/11"));
  assert.equal(corroborated.phone.replace(/\D/g, "").endsWith("5145550100"), true);
  assert.equal(corroborated.public_email, "nord@exemple.ca");
  assert.equal(corroborated.address, "10 rue du Pont");
  assert.equal(corroborated.field_sources.phone, "node/10");
  assert.equal(corroborated.field_sources.public_email, "way/11");
  assert.equal(corroborated.field_sources.address, "way/11");
  assert.equal(corroborated.osm_ids.join(","), "node/10,way/11");
  assert.equal(corroborated.source_url, "https://www.openstreetmap.org/node/10");
  assert.equal(Object.hasOwn(corroborated, "lat"), false);
  const otherPhone = rows.find((row) => row.id === "osm_node_12");
  assert.equal(otherPhone.address, "80 rue Ontario");
  assert.equal(otherPhone.public_email, "");
  assert.equal(otherPhone.osm_ids.includes("way/11"), false);
  const nameOnly = rows.filter((row) => row.id === "osm_relation_13" || row.id === "osm_node_14");
  assert.equal(nameOnly.length, 2);
  assert.equal(nameOnly.every((row) => row.phone === "" && row.public_email === "" && row.website === ""), true);
  const afterEngine = loaded.KlirEngine.dedup(rows);
  assert.equal(afterEngine.unique.length, 4);
  assert.equal(afterEngine.dups.length, 0);
});

test("les autres secteurs restent limités aux nœuds et l'export n'invente pas de coordonnées", async () => {
  const sandbox = clockedSandbox();
  sandbox.fetch = scriptedFetch({ elements: [] });
  const loaded = await loadSources(sandbox);
  const health = loaded.KlirSources.osm.query({ industry: "sante", city: montreal }, 20);
  assert.equal(health.includes('node["name"]'), true);
  assert.equal(health.includes('way["name"]'), false);
  assert.equal(health.includes('relation["name"]'), false);
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const security = await readFile(new URL("../src/security.js", import.meta.url), "utf8");
  const helpers = app.slice(app.indexOf("function sizeLabel"), app.indexOf("function spendCredits"));
  const ui = { Date, console, crypto: webcrypto };
  ui.window = ui;
  ui.KlirStore = { S: {} };
  vm.createContext(ui);
  vm.runInContext(security, ui);
  vm.runInContext(helpers, ui);
  const csv = ui.exportCsvText([{
    company_name: "Atelier Nord",
    industry: "Construction / Rénovation",
    website: "",
    phone: "",
    public_email: "",
    address: "",
    city: "Montréal",
    province: "QC",
    country: "Canada",
    source: "OpenStreetMap",
    collected_at: "2026-10-10T12:00:00.000Z",
    searchId: "s1",
    dq: 25,
    rel: 74
  }]);
  assert.equal(csv.includes("Latitude"), false);
  assert.equal(csv.includes("Longitude"), false);
  const lines = csv.split("\n");
  assert.equal(lines.length, 2);
  assert.equal(lines[1].includes("Atelier Nord"), true);
  assert.match(lines[1], /"","","","Montréal","QC"/);
  const displayed = ui.rowsForExport([
    { id: "a", searchId: "s1", company_name: "Atelier Nord", status: "New" },
    { id: "b", searchId: "s1", company_name: "Archivé", status: "Archived" },
    { id: "c", searchId: "s2", company_name: "Autre recherche" }
  ], "s1", new Set(), false, null);
  assert.deepEqual(displayed.map((row) => row.company_name), ["Atelier Nord"]);
});

test("une erreur technique simulée ne renvoie aucune fiche", async () => {
  const loaded = await searchWith({ elements: [{ type: "node", id: 1, tags: { name: "Ne doit pas passer", craft: "builder" } }] }, 504);
  await assert.rejects(
    loaded.KlirSources.osm.search({ industry: "construction", city: montreal }, 10),
    /Recherche échouée/
  );
});

test("une réponse complète vide et une réponse partielle vide restent des listes vides", async () => {
  const complete = await searchWith({ elements: [] });
  const completeRows = await complete.KlirSources.osm.search({ industry: "construction", city: montreal }, 10);
  assert.equal(completeRows.length, 0);
  assert.equal(completeRows.osmCoverage.status, "complete");
  const partial = await searchWith({ remark: "runtime error: Query timed out.", elements: [] });
  const partialRows = await partial.KlirSources.osm.search({ industry: "construction", city: montreal }, 10);
  assert.equal(partialRows.length, 0);
  assert.equal(partialRows.osmCoverage.status, "partial");
  const withRow = await searchWith({
    remark: "runtime error: Query timed out.",
    elements: [{ type: "way", id: 70, tags: { name: "Menuiserie Est", craft: "joiner" } }]
  });
  const partialRowsWith = await withRow.KlirSources.osm.search({ industry: "construction", city: montreal }, 10);
  assert.equal(partialRowsWith.length, 1);
  assert.equal(partialRowsWith.osmCoverage.status, "partial");
  assert.equal(partialRowsWith[0].phone, "");
  assert.equal(partialRowsWith[0].address, "");
  assert.equal(Object.hasOwn(partialRowsWith[0], "lat"), false);
});
