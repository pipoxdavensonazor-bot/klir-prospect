import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const montreal = { city: "Montréal", province: "QC", country: "Canada", lat: 45.5017, lng: -73.5673 };
const laval = { city: "Laval", province: "QC", country: "Canada", lat: 45.6066, lng: -73.7124 };

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
  vm.runInContext(await readFile(new URL("../src/sources.js", import.meta.url), "utf8"), sandbox);
  return sandbox.KlirSources;
}

function scriptedFetch(body, calls) {
  return async () => {
    calls.push("overpass");
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
}

test("la construction interroge nœuds, chemins et relations sans élargir le rayon", async () => {
  const sources = await loadSources(clockedSandbox());
  const query = sources.osm.query({ industry: "construction", city: montreal }, 30);
  for (const type of ["node", "way", "relation"]) {
    assert.equal(query.includes(type + '["name"]'), true, type);
  }
  for (const craft of ["builder", "electrician", "plumber", "roofer", "painter", "carpenter"]) {
    assert.equal(query.includes(craft), true, craft);
  }
  for (const craft of sources.osm.renovationCrafts) {
    assert.equal(query.includes(craft), true, craft);
  }
  assert.equal(query.includes('["office"="construction_company"]'), true);
  assert.equal(query.includes("around:2200,45.5017,-73.5673"), true);
  assert.equal(query.includes("out tags 30"), true);
  assert.equal(query.includes('["shop"]'), false);
  assert.equal(query.includes('["office"]'), false);
  assert.equal(query.includes("45.4102"), false);
  const health = sources.osm.query({ industry: "sante", city: montreal }, 40);
  assert.equal(health.includes('node["name"]'), true);
  assert.equal(health.includes('way["name"]'), false);
  assert.equal(health.includes('relation["name"]'), false);
  assert.equal(health.includes("around:2200"), true);
  const broad = sources.osm.query({ industry: "all", city: montreal }, 10);
  assert.equal(broad.includes("around:1500,45.5017,-73.5673"), true);
  assert.equal(broad.includes('way["name"]'), false);
});

test("l'emprise de Montréal est optionnelle et ne remplace pas Laval", async () => {
  const sources = await loadSources(clockedSandbox());
  const island = sources.osm.query({ industry: "construction", city: montreal, area: "montreal_island" }, 30);
  const bounds = sources.osm.areas.montreal_island;
  assert.equal(island.includes("(" + bounds.south + "," + bounds.west + "," + bounds.north + "," + bounds.east + ")"), true);
  assert.equal(island.includes("around:"), false);
  assert.equal(island.includes('way["name"]'), true);
  const elsewhere = sources.osm.query({ industry: "construction", city: laval, area: "montreal_island" }, 30);
  assert.equal(elsewhere.includes("around:2200,45.6066,-73.7124"), true);
  assert.equal(elsewhere.includes(String(bounds.south)), false);
  assert.throws(() => sources.osm.query({ industry: "construction", city: {} }, 10), /coordonnées/);
  const islandOnly = sources.osm.query({ industry: "construction", city: { city: "Montréal" }, area: "montreal_island" }, 10);
  assert.equal(islandOnly.includes("around:"), false);
});

test("un chemin publié ne reçoit ni coordonnée ni contact inventé", async () => {
  const sources = await loadSources(clockedSandbox());
  const row = sources.osm.mapElement({
    type: "way",
    id: 88,
    lat: 45.5,
    lon: -73.5,
    center: { lat: 45.5, lon: -73.5 },
    tags: { name: "Atelier Nord", craft: "plasterer" }
  }, { industry: "all", city: montreal });
  assert.equal(row.company_name, "Atelier Nord");
  assert.equal(row.id, "osm_way_88");
  assert.equal(row.source_url, "https://www.openstreetmap.org/way/88");
  assert.equal(row.industry_key, "construction");
  assert.equal(row.phone, "");
  assert.equal(row.public_email, "");
  assert.equal(row.website, "");
  assert.equal(row.address, "");
  assert.equal(row.employee_range, "");
  assert.equal(Object.hasOwn(row, "lat"), false);
  assert.equal(Object.hasOwn(row, "lng"), false);
  assert.equal(Object.hasOwn(row, "lon"), false);
  const office = sources.osm.mapElement({
    type: "relation",
    id: 9,
    tags: { name: "Bureau général", office: "company" }
  }, { industry: "all", city: montreal });
  assert.equal(office.industry_key, "services");
  assert.equal(office.id, "osm_relation_9");
});

test("le même identifiant OSM ne produit qu'une fiche et ne mélange pas deux téléphones", async () => {
  const calls = [];
  const sandbox = clockedSandbox();
  sandbox.fetch = scriptedFetch({
    elements: [
      { type: "node", id: 1, tags: { name: "F. Dussault Inc.", office: "construction_company", phone: "+1-514-555-0101" } },
      { type: "node", id: 1, tags: { name: "F. Dussault Inc.", office: "construction_company", phone: "+1 514 555-0199", website: "https://dussault.example" } },
      { type: "node", id: 4, tags: { name: "Toiture Laval", craft: "roofer" } }
    ]
  }, calls);
  const sources = await loadSources(sandbox);
  const rows = await sources.osm.search({ industry: "construction", city: montreal }, 30);
  assert.deepEqual(calls, ["overpass"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "osm_node_1");
  assert.equal(rows[0].phone, "+1-514-555-0101");
  assert.equal(rows[0].website, "https://dussault.example/");
  assert.equal(rows[0].field_sources.phone, "node/1");
  assert.equal(rows[0].field_sources.website, "node/1");
  assert.equal(rows[0].osm_ids.join(","), "node/1");
  assert.equal(rows[0].employee_range, "");
  assert.equal(Object.hasOwn(rows[0], "lat"), false);
  assert.equal(rows[1].company_name, "Toiture Laval");
  assert.equal(rows.osmCoverage.status, "complete");
});

test("une remarque Overpass marque la collecte partielle sans la transformer en erreur", async () => {
  const calls = [];
  const sandbox = clockedSandbox();
  sandbox.fetch = scriptedFetch({
    remark: " runtime error: Query timed out in \"query\" at line 1 after 15 seconds. ",
    elements: [
      { type: "way", id: 50, tags: { name: "Menuiserie Est", craft: "joiner" } }
    ]
  }, calls);
  const sources = await loadSources(sandbox);
  const rows = await sources.osm.search({ industry: "construction", city: montreal, area: "montreal_island" }, 30);
  assert.equal(calls.length, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company_name, "Menuiserie Est");
  assert.equal(rows[0].phone, "");
  assert.equal(rows[0].id, "osm_way_50");
  assert.equal(rows.osmCoverage.status, "partial");
  assert.match(rows.osmCoverage.remark, /timed out/);
  assert.equal(rows.osmCoverage.area, "montreal_island");
  assert.equal(rows.osmCoverage.areaFallback, false);

  const emptySandbox = clockedSandbox();
  const emptyCalls = [];
  emptySandbox.fetch = scriptedFetch({ remark: "runtime error: Query run out of memory.", elements: [] }, emptyCalls);
  const emptySources = await loadSources(emptySandbox);
  const empty = await emptySources.osm.search({ industry: "construction", city: laval, area: "montreal_island" }, 30);
  assert.equal(empty.length, 0);
  assert.equal(empty.osmCoverage.status, "partial");
  assert.equal(empty.osmCoverage.area, "radius");
  assert.equal(empty.osmCoverage.areaFallback, true);
  assert.equal(emptyCalls.length, 1);
});

test("le parcours de production ne facture pas une collecte partielle", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const search = app.slice(app.indexOf("async function runSearch"), app.indexOf("function toCrm"));
  const radar = app.slice(app.indexOf("async function radarRun"), app.indexOf("async function enrichSelected"));
  assert.equal(search.includes("genProspects"), false);
  assert.equal(search.includes('if(account.debit&&!spendCredits(searchCost,"Recherche"))return;'), true);
  assert.equal(search.includes("searchAccounting(accountKind)"), true);
  assert.equal(search.includes("5+Math.ceil(_costQ/10)"), true);
  assert.ok(search.indexOf("Recherche partielle, aucun résultat reçu") < search.indexOf("spendCredits(searchCost"));
  assert.equal(app.includes("Collecte partielle, non exhaustive."), true);
  assert.equal(radar.includes('if(!radarPartial&&!spendCredits(5,"Scan Radar"))return;'), true);
  assert.ok(radar.indexOf("Recherche partielle, aucun résultat reçu") < radar.indexOf('spendCredits(5,"Scan Radar")'));
  assert.equal(radar.includes("Aucun crédit n'a été débité."), true);
  assert.equal(app.includes('id="aArea"'), true);
  assert.equal(app.includes("montreal_island"), true);
});
