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
  const urls = [];
  let index = 0;
  return {
    calls,
    urls,
    fetch: async (url, _options) => {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      calls.push(step.status == null ? 0 : step.status);
      urls.push(String(url));
      if (step.error) throw step.error;
      return new Response(step.body, { status: step.status, headers: step.headers || {} });
    }
  };
}

function abortError() {
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function listed(sources) {
  return Array.from(sources.osm.endpoints);
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

test("un HTTP 504 bascule vers le serveur suivant, puis la réponse valide est conservée sans doublon", async () => {
  const { sandbox, waits, logs } = clockedSandbox();
  const http = scriptedFetch([
    { status: 504, body: "" },
    { status: 200, body: JSON.stringify({ elements: [named] }) }
  ]);
  sandbox.fetch = http.fetch;
  const sources = await loadSources(sandbox);
  const rows = await sources.osm.search(params(), 8);
  assert.deepEqual(http.calls, [504, 200]);
  assert.deepEqual(http.urls, listed(sources).slice(0, 2));
  assert.deepEqual(waits, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "osm_node_343490371");
  const parsed = logs.map((line) => JSON.parse(line.replace("[overpass] ", "")));
  assert.deepEqual(parsed.map((entry) => entry.status), [504, 200]);
  assert.deepEqual(parsed.map((entry) => entry.attempt), [1, 2]);
  assert.deepEqual(parsed.map((entry) => entry.host), ["overpass-api.de", "lz4.overpass-api.de"]);
  assert.equal(parsed.every((entry) => Number.isFinite(entry.durationMs)), true);
  assert.equal(logs.join(" ").includes("+1-514"), false);
  assert.equal(logs.join(" ").includes("schwartzs"), false);
});

test("un HTTP 502 bascule sans attendre et s'arrête au premier succès", async () => {
  const { sandbox, waits } = clockedSandbox();
  const http = scriptedFetch([
    { status: 502, body: "bad gateway" },
    { status: 502, body: "bad gateway" },
    { status: 200, body: JSON.stringify({ elements: [bare] }) }
  ]);
  sandbox.fetch = http.fetch;
  const sources = await loadSources(sandbox);
  const rows = await sources.osm.search(params(), 8);
  assert.deepEqual(http.calls, [502, 502, 200]);
  assert.deepEqual(http.urls, listed(sources).slice(0, 3));
  assert.deepEqual(waits, []);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].company_name, "Frite Alors!");
});

test("un HTTP 504 persistant interroge chaque serveur une seule fois", async () => {
  const { sandbox, waits } = clockedSandbox();
  const http = scriptedFetch([{ status: 504, body: "timeout" }]);
  sandbox.fetch = http.fetch;
  const sources = await loadSources(sandbox);
  await assert.rejects(sources.osm.search(params(), 8), /Recherche échouée : OpenStreetMap a répondu 504/);
  assert.deepEqual(http.calls, [504, 504, 504, 504]);
  assert.deepEqual(http.urls, listed(sources));
  assert.equal(new Set(http.urls).size, listed(sources).length);
  assert.deepEqual(waits, []);
});

test("des HTTP 502 sur tous les serveurs échouent sans autre appel", async () => {
  const { sandbox, waits } = clockedSandbox();
  const http = scriptedFetch([{ status: 502, body: "bad gateway" }]);
  sandbox.fetch = http.fetch;
  const sources = await loadSources(sandbox);
  await assert.rejects(
    sources.osm.search(params(), 8),
    (error) => error && error.message === "Recherche échouée : OpenStreetMap a répondu 502."
  );
  assert.deepEqual(http.calls, [502, 502, 502, 502]);
  assert.deepEqual(http.urls, listed(sources));
  assert.deepEqual(waits, []);
});

test("un délai dépassé ou une coupure bascule, un HTTP 400 s'arrête", async () => {
  const { sandbox, waits } = clockedSandbox();
  const timedOut = scriptedFetch([
    { error: abortError() },
    { status: 200, body: JSON.stringify({ elements: [named] }) }
  ]);
  sandbox.fetch = timedOut.fetch;
  const sources = await loadSources(sandbox);
  const rows = await sources.osm.search(params(), 8);
  assert.deepEqual(timedOut.calls, [0, 200]);
  assert.deepEqual(timedOut.urls, listed(sources).slice(0, 2));
  assert.equal(rows.length, 1);
  assert.deepEqual(waits, []);

  const down = clockedSandbox();
  const dropped = scriptedFetch([
    { error: new TypeError("Failed to fetch") },
    { status: 200, body: JSON.stringify({ elements: [bare] }) }
  ]);
  down.sandbox.fetch = dropped.fetch;
  const recovered = await loadSources(down.sandbox);
  const recoveredRows = await recovered.osm.search(params(), 8);
  assert.deepEqual(dropped.urls, listed(recovered).slice(0, 2));
  assert.equal(recoveredRows.length, 1);

  const rejected = clockedSandbox();
  const invalid = scriptedFetch([{ status: 400, body: "bad request" }]);
  rejected.sandbox.fetch = invalid.fetch;
  const stopped = await loadSources(rejected.sandbox);
  await assert.rejects(stopped.osm.search(params(), 8), /Recherche échouée : OpenStreetMap a répondu 400/);
  assert.deepEqual(invalid.calls, [400]);
  assert.deepEqual(invalid.urls, [listed(stopped)[0]]);
  assert.deepEqual(rejected.waits, []);
});

test("un HTTP 429 attend Retry-After puis bascule vers le serveur suivant", async () => {
  const { sandbox, waits } = clockedSandbox();
  const http = scriptedFetch([
    { status: 429, body: "", headers: { "Retry-After": "2" } },
    { status: 200, body: JSON.stringify({ elements: [bare] }) }
  ]);
  sandbox.fetch = http.fetch;
  const sources = await loadSources(sandbox);
  const rows = await sources.osm.search(params(), 8);
  assert.deepEqual(http.calls, [429, 200]);
  assert.deepEqual(http.urls, listed(sources).slice(0, 2));
  assert.deepEqual(waits, [2000]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].public_email, "");
});

test("le CSP autorise chaque instance Overpass et le parcours Overture reste devant OSM", async () => {
  const { sandbox } = clockedSandbox();
  sandbox.fetch = async () => new Response("{}", { status: 200 });
  const sources = await loadSources(sandbox);
  const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
  const headers = await readFile(new URL("../_headers", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.deepEqual(listed(sources), [
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter"
  ]);
  for (const endpoint of sources.osm.endpoints) {
    const origin = new URL(endpoint).origin;
    assert.equal(html.includes(origin), true, origin);
    assert.equal(headers.includes(origin), true, origin);
  }
  assert.equal(html.includes("https://nominatim.openstreetmap.org"), true);
  assert.equal(headers.includes("https://nominatim.openstreetmap.org"), true);
  const search = app.slice(app.indexOf("async function runSearch"), app.indexOf("function toCrm"));
  const radar = app.slice(app.indexOf("async function radarRun"), app.indexOf("async function enrichSelected"));
  assert.equal(search.includes("KlirAuth.searchJob("), true);
  assert.equal(search.includes("KlirSources.osm.search"), false);
  assert.equal(search.includes("spendCredits("), false);
  assert.equal(search.includes("5+Math.ceil(params.quantity/10)"), true);
  assert.equal(radar.includes("KlirSources.osm.search"), false);
  assert.equal(radar.includes("spendCredits("), false);
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

test("un HTTP 429 sur tous les serveurs échoue sans inventer de fiche", async () => {
  const { sandbox, waits } = clockedSandbox();
  const http = scriptedFetch([{ status: 429, body: "", headers: { "Retry-After": "0" } }]);
  sandbox.fetch = http.fetch;
  const sources = await loadSources(sandbox);
  await assert.rejects(sources.osm.search(params(), 8), /Recherche échouée : OpenStreetMap a répondu 429/);
  assert.deepEqual(http.calls, [429, 429, 429, 429]);
  assert.deepEqual(http.urls, listed(sources));
  assert.deepEqual(waits, []);
});

test("un HTTP 200 tronqué est une panne, sans reprise ni fiche partielle", async () => {
  const { sandbox, waits } = clockedSandbox();
  const http = scriptedFetch([{ status: 200, body: '{"elements":[{"type":"node","id":1' }]);
  sandbox.fetch = http.fetch;
  const sources = await loadSources(sandbox);
  await assert.rejects(sources.osm.search(params(), 8), /Recherche échouée : réponse OpenStreetMap invalide/);
  assert.deepEqual(http.calls, [200]);
  assert.deepEqual(waits, []);
  assert.equal(sources.osm.limits.requestMs, 18000);
  assert.equal(sources.osm.limits.queryTimeoutSec, 15);
  assert.equal(sources.osm.limits.retryAfterCapMs, 30000);
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
  assert.equal(search.includes("KlirAuth.searchJob("), true);
  assert.equal(search.includes("KlirSources.osm.search"), false);
  assert.equal(search.includes("spendCredits("), false);
  assert.equal(search.includes("5+Math.ceil(params.quantity/10)"), true);
  assert.equal(radar.includes("KlirSources.osm.search"), false);
  assert.equal(radar.includes("spendCredits("), false);
  assert.equal(app.includes("genProspects"), false);
  assert.equal(sources.includes("genProspects"), false);
  assert.equal(radar.includes("KlirSecurity.random"), false);
  assert.equal(radar.includes("Nouveau site"), false);
  assert.equal(radar.includes("Recrutement"), false);
  assert.equal(radar.includes("Signal commercial"), false);
  const importer = app.slice(app.indexOf("function importCsvText"), app.length);
  assert.equal(importer.includes('employee_range:"11'), false);
  assert.equal(importer.includes('employee_range:""'), true);
  assert.equal(app.includes('employee_range||"PME"'), false);
  assert.equal(app.includes('website_status="INACTIVE"'), false);
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
