import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const city = { city: "Montréal", province: "QC", country: "Canada", lat: 45.5017, lng: -73.5673 };
const named = {
  type: "node",
  id: 343490371,
  tags: {
    name: "Schwartz's",
    amenity: "restaurant",
    phone: "+1-514-842-4813",
    website: "https://schwartzsdeli.com",
    email: "info@schwartzsdeli.com"
  }
};
const bare = {
  type: "node",
  id: 237584792,
  tags: { name: "Frite Alors!", amenity: "restaurant" }
};

function clockedSandbox() {
  const waits = [];
  const logs = [];
  const sandbox = {
    console: {
      info(message) { logs.push(String(message)); },
      warn() {},
      error() {},
      log() {}
    },
    URL,
    AbortController,
    Date,
    clearTimeout() {},
    setTimeout(fn, ms) {
      if (ms >= 18000) return 0;
      waits.push(ms);
      fn();
      return waits.length;
    }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox, waits, logs };
}

async function loadSources(sandbox) {
  vm.runInContext(await readFile(new URL("../src/data.js", import.meta.url), "utf8"), sandbox);
  vm.runInContext(await readFile(new URL("../src/sources.js", import.meta.url), "utf8"), sandbox);
  return sandbox.KlirSources;
}

function scriptedFetch(steps) {
  const calls = [];
  let index = 0;
  return {
    calls,
    fetch: async (_url, _options) => {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      calls.push(step.status);
      return new Response(step.body, { status: step.status, headers: step.headers || {} });
    }
  };
}

function params() {
  return { industry: "restauration", city, quantity: 8 };
}

test("une réponse Overpass valide conserve les contacts publiés et laisse les absents vides", async () => {
  const { sandbox } = clockedSandbox();
  const http = scriptedFetch([{
    status: 200,
    body: JSON.stringify({ elements: [named, bare] })
  }]);
  sandbox.fetch = http.fetch;
  const sources = await loadSources(sandbox);
  const rows = await sources.osm.search(params(), 8);
  assert.equal(http.calls.length, 1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].company_name, "Schwartz's");
  assert.equal(rows[0].phone, "+1-514-842-4813");
  assert.equal(rows[0].website, "https://schwartzsdeli.com/");
  assert.equal(rows[0].public_email, "info@schwartzsdeli.com");
  assert.equal(rows[1].company_name, "Frite Alors!");
  assert.equal(rows[1].phone, "");
  assert.equal(rows[1].website, "");
  assert.equal(rows[1].public_email, "");
  assert.equal(rows[1].employee_range, "");
});

test("un HTTP 504 est repris une seule fois, puis la réponse valide est conservée sans doublon", async () => {
  const { sandbox, waits, logs } = clockedSandbox();
  const http = scriptedFetch([
    { status: 504, body: "" },
    { status: 200, body: JSON.stringify({ elements: [named] }) }
  ]);
  sandbox.fetch = http.fetch;
  const sources = await loadSources(sandbox);
  const rows = await sources.osm.search(params(), 8);
  assert.deepEqual(http.calls, [504, 200]);
  assert.deepEqual(waits, [8000]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "osm_node_343490371");
  const parsed = logs.map((line) => JSON.parse(line.replace("[overpass] ", "")));
  assert.deepEqual(parsed.map((entry) => entry.status), [504, 200]);
  assert.deepEqual(parsed.map((entry) => entry.attempt), [1, 2]);
  assert.equal(parsed.every((entry) => Number.isFinite(entry.durationMs)), true);
  assert.equal(logs.join(" ").includes("+1-514"), false);
  assert.equal(logs.join(" ").includes("schwartzs"), false);
});

test("un HTTP 504 persistant échoue sans troisième appel", async () => {
  const { sandbox, waits } = clockedSandbox();
  const http = scriptedFetch([{ status: 504, body: "timeout" }]);
  sandbox.fetch = http.fetch;
  const sources = await loadSources(sandbox);
  await assert.rejects(sources.osm.search(params(), 8), /Recherche échouée : OpenStreetMap a répondu 504/);
  assert.deepEqual(http.calls, [504, 504]);
  assert.deepEqual(waits, [8000]);
});

test("un HTTP 429 respecte Retry-After et ne dépasse pas une reprise", async () => {
  const { sandbox, waits } = clockedSandbox();
  const http = scriptedFetch([
    { status: 429, body: "", headers: { "Retry-After": "2" } },
    { status: 200, body: JSON.stringify({ elements: [bare] }) }
  ]);
  sandbox.fetch = http.fetch;
  const sources = await loadSources(sandbox);
  const rows = await sources.osm.search(params(), 8);
  assert.deepEqual(http.calls, [429, 200]);
  assert.deepEqual(waits, [2000]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].public_email, "");
});

test("une réponse JSON valide sans fiche n'est pas une erreur", async () => {
  const { sandbox } = clockedSandbox();
  const http = scriptedFetch([{ status: 200, body: JSON.stringify({ elements: [] }) }]);
  sandbox.fetch = http.fetch;
  const sources = await loadSources(sandbox);
  const rows = await sources.osm.search(params(), 8);
  assert.equal(rows.length, 0);
  assert.deepEqual(http.calls, [200]);
});

test("un JSON mal formé échoue sans reprise", async () => {
  const { sandbox, waits } = clockedSandbox();
  const http = scriptedFetch([{ status: 200, body: "<html>pas du json</html>" }]);
  sandbox.fetch = http.fetch;
  const sources = await loadSources(sandbox);
  await assert.rejects(sources.osm.search(params(), 8), /Recherche échouée : réponse OpenStreetMap invalide/);
  assert.deepEqual(http.calls, [200]);
  assert.deepEqual(waits, []);
});

test("des coordonnées absentes arrêtent la recherche avant l'appel réseau", async () => {
  const { sandbox } = clockedSandbox();
  let called = 0;
  sandbox.fetch = async () => { called += 1; return new Response("{}", { status: 200 }); };
  const sources = await loadSources(sandbox);
  await assert.rejects(sources.osm.search({ industry: "all", city: {} }, 8), /coordonnées/);
  assert.equal(called, 0);
});

test("le parcours de production n'appelle ni genProspects ni les signaux aléatoires", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const sources = await readFile(new URL("../src/sources.js", import.meta.url), "utf8");
  const radar = app.slice(app.indexOf("async function radarRun"), app.indexOf("async function enrichSelected"));
  const search = app.slice(app.indexOf("async function runSearch"), app.indexOf("function toCrm"));
  assert.equal(app.includes("genProspects"), false);
  assert.equal(sources.includes("genProspects"), false);
  assert.equal(radar.includes("KlirSecurity.random"), false);
  assert.equal(radar.includes("Nouveau site"), false);
  assert.equal(radar.includes("Recrutement"), false);
  assert.equal(radar.includes("Signal commercial"), false);
  assert.equal(search.includes("spendCredits(searchCost"), true);
  assert.ok(search.indexOf("Recherche échouée") < search.indexOf("spendCredits(searchCost"));
  assert.ok(search.indexOf("Recherche terminée, aucun résultat") < search.indexOf("spendCredits(searchCost"));
  assert.ok(radar.indexOf("Recherche échouée") < radar.indexOf('spendCredits(5,"Scan Radar")'));
  assert.ok(radar.indexOf("Recherche terminée, aucun résultat") < radar.indexOf('spendCredits(5,"Scan Radar")'));
  const importer = app.slice(app.indexOf("function importCsvText"), app.length);
  assert.equal(importer.includes('employee_range:"11'), false);
  assert.equal(importer.includes('employee_range:""'), true);
  assert.equal(app.includes('employee_range||"PME"'), false);
  assert.equal(app.includes('website_status="INACTIVE"'), false);
  assert.equal(app.includes('website_status="NON_RENSEIGNE"'), true);
  assert.equal(app.includes("données simulées"), false);
  assert.equal(app.includes("CET APPAREIL"), true);
  assert.equal(app.includes("© les contributeurs OpenStreetMap"), true);
  assert.equal(app.includes("Nord Rénovation"), false);
});

test("la taille inconnue, la date de collecte et le site absent ont un libellé explicite", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const helpers = app.slice(app.indexOf("function sizeLabel"), app.indexOf("function spendCredits"));
  const sandbox = { Date };
  vm.createContext(sandbox);
  vm.runInContext(helpers, sandbox);
  assert.equal(sandbox.sizeLabel(""), "Non renseigné");
  assert.equal(sandbox.sizeLabel("51–200"), "51–200");
  assert.equal(sandbox.collectedLabel(""), "");
  assert.equal(sandbox.collectedLabel("pas une date"), "");
  assert.equal(sandbox.collectedLabel("2026-10-10T11:20:00.000Z"), "Collecté le 2026-10-10");
  const rows = sandbox.stampCollected([
    { source: "OpenStreetMap", last_verified: "2026-10-10", company_name: "Schwartz's" },
    { source: "Import client", last_verified: "2026-10-10", company_name: "Déjà saisi" }
  ]);
  assert.equal(rows[0].last_verified, "");
  assert.equal(Number.isNaN(Date.parse(rows[0].collected_at)), false);
  assert.equal(rows[1].collected_at, undefined);
  assert.equal(rows[1].last_verified, "2026-10-10");

  const ui = { console, URL, setTimeout, clearTimeout };
  ui.window = ui;
  ui.KlirStore = { S: {} };
  ui.KlirSecurity = { domain(value) { return String(value || "").replace(/^https?:\/\//, "").split("/")[0]; } };
  vm.createContext(ui);
  vm.runInContext(await readFile(new URL("../src/webintel.js", import.meta.url), "utf8"), ui);
  const missing = { website: "", domain: "" };
  assert.equal(ui.WebIntel.badgeSite(missing).includes("Site non renseigné"), true);
  assert.equal(ui.WebIntel.badgeSite(missing).includes("INACTIVE"), false);
  const unpublished = { website: "", domain: "cafe.example", website_status: "NON_RENSEIGNE", signals: [] };
  assert.equal(ui.WebIntel.digitalOpp(unpublished).why, "aucun site publié dans la source");
  const checked = { website: "https://cafe.example", domain: "cafe.example", website_status: "INACTIVE", signals: [] };
  assert.equal(ui.WebIntel.badgeSite(checked).includes("INACTIVE"), true);
  const legacy = { website: "", domain: "", website_status: "INACTIVE", signals: [] };
  assert.equal(ui.WebIntel.badgeSite(legacy).includes("Site non renseigné"), true);
  assert.equal(ui.WebIntel.badgeSite(legacy).includes("INACTIVE"), false);
});

test("un score élevé reste une suggestion et une date non vérifiée n'est pas affichée", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const helpers = app.slice(app.indexOf("function sizeLabel"), app.indexOf("function spendCredits"));
  const sandbox = { Date };
  vm.createContext(sandbox);
  vm.runInContext(helpers, sandbox);
  const scored = sandbox.radarSuggestion({
    company_name: "Schwartz's",
    industry: "Restauration",
    city: "Montréal",
    rel: 92,
    signals: ["Source ouverte"],
    source: "OpenStreetMap",
    phone: "",
    public_email: "",
    website: ""
  }, null);
  assert.equal(scored.kind, "Prospect pertinent à examiner");
  assert.equal(scored.signal, "Pertinence calculée");
  assert.equal(scored.why.includes("Suggestion calculée"), true);
  assert.equal(scored.why.includes("OpenStreetMap"), true);
  assert.equal(scored.why.includes("pas un événement confirmé"), true);
  for (const word of ["Recrutement", "Expansion", "Nouveau site", "Signal commercial"]) {
    assert.equal(scored.kind.includes(word), false);
    assert.equal(scored.signal.includes(word), false);
  }
  const mentioned = sandbox.radarSuggestion({
    industry: "Restauration", city: "Montréal", rel: 90, signals: ["Recrutement"], source: "OpenStreetMap"
  }, null);
  assert.equal(mentioned.signal, "Pertinence calculée");
  assert.equal(mentioned.why.includes("Non revérifiée") || mentioned.why.includes("n'a pas été revérifiée"), true);
  assert.equal(sandbox.sourceDateLabel({ collected_at: "2026-10-10T11:20:00.000Z", last_verified: "2026-10-10" }), "Collecté le 2026-10-10");
  const historical = sandbox.sourceDateLabel({ last_verified: "2026-10-10" });
  assert.equal(historical, "Date de collecte non renseignée");
  assert.equal(historical.includes("2026"), false);
  assert.equal(sandbox.sourceDateLabel({ collected_at: "pas une date", last_verified: "2026-10-10" }), "Date de collecte non renseignée");
});
