import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../src/", import.meta.url);
const app = await readFile(new URL("app.js", root), "utf8");
const engineSource = await readFile(new URL("engine.js", root), "utf8");

async function loadEngine() {
  const sandbox = { console, window: {} };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(await readFile(new URL("data.js", root), "utf8"), sandbox);
  vm.runInContext(engineSource, sandbox);
  return sandbox.KlirEngine;
}

function clockedSandbox() {
  const waits = [];
  const sandbox = {
    console: { info() {}, warn() {}, error() {}, log() {} },
    URL, AbortController, Date, Map, Set,
    clearTimeout() {},
    setTimeout(fn, ms) {
      if (ms >= 18000) return 0;
      waits.push(ms);
      fn();
      return waits.length;
    },
    hx: (value) => String(value ?? ""),
    esc: (value) => String(value ?? "")
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return { sandbox, waits };
}

async function loadScripts(sandbox, { sources = false } = {}) {
  vm.runInContext(await readFile(new URL("data.js", root), "utf8"), sandbox);
  vm.runInContext(engineSource, sandbox);
  if (sources) vm.runInContext(await readFile(new URL("sources.js", root), "utf8"), sandbox);
  sandbox.E = sandbox.KlirEngine;
  vm.runInContext(app.slice(app.indexOf("function sizeLabel"), app.indexOf("function spendCredits")), sandbox);
  vm.runInContext(app.slice(app.indexOf("function formControls"), app.indexOf("function vNew")), sandbox);
  vm.runInContext(app.slice(app.indexOf("async function runSearch"), app.indexOf("function toCrm")), sandbox);
  vm.runInContext(app.slice(app.indexOf("async function radarRun"), app.indexOf("async function enrichSelected")), sandbox);
}

function fieldsFor(query, cityKey = "montréal") {
  return Object.fromEntries(Object.entries({
    qInput: query, aInd: "construction", aCity: cityKey, aQty: "10", aSize: "", aArea: "radius",
    searchPrice: "", searchSummary: "", parsed: "", prog: ""
  }).map(([id, value]) => [id, {
    value, innerHTML: "", textContent: "",
    querySelectorAll() { return []; }
  }]));
}

async function harness({ query = "10 restaurants à Montréal", cityKey = "montréal", balance = 200, fetchImpl = null, source } = {}) {
  const { sandbox, waits } = clockedSandbox();
  const fields = fieldsFor(query, cityKey);
  const calls = { reservations: [], sources: [], settlements: [], alerts: [], notices: [] };
  Object.assign(sandbox, {
    document: { getElementById: (id) => fields[id] || null, querySelectorAll: () => [] },
    authState: { user: { email: "tester@example.invalid" } },
    searchRunning: false, radarRunning: false, pendingDebitKey: "", serverLedgerApplied: false, serverSearches: null,
    sel: new Set(), selExplicit: false, selSearch: null, curSearch: null,
    alert: (message) => calls.alerts.push(message),
    nav() {}, render() {}, applyServerUsage() {},
    sectorLabel: (key) => sandbox.KlirEngine.industryLabel(key),
    async reserveServerUsage(amount, label) { calls.reservations.push({ amount, label }); return { ok: true }; },
    async settleServerUsage(debit) { calls.settlements.push(debit); return true; },
    spendCredits(amount) { sandbox.KS.S.credits.balance -= amount; return true; }
  });
  sandbox.KS = {
    S: {
      plan: "Free", demo: false, usage: { searches: 0, prospects: 0 }, credits: { balance },
      searches: [], prospects: [], icp: null, weights: {}, opps: [], radarCfg: { signals: [] }
    },
    uid: () => "search-test", save() {}, addActivity() {}, audit() {},
    notify: (message) => calls.notices.push(message)
  };
  sandbox.KlirStore = { LIMITS: { Free: { searches: 10 } } };
  if (fetchImpl) sandbox.fetch = fetchImpl;
  await loadScripts(sandbox, { sources: !!fetchImpl });
  if (!fetchImpl) {
    sandbox.KlirSources = { osm: { async search(params, limit) {
      calls.sources.push({ params: structuredClone(params), limit });
      if (source === "error") throw new Error("source indisponible");
      const rows = source === "empty" ? [] : [{
        id: "osm_node_1", company_name: "Atelier test", city: params.city.city,
        industry: "Construction / Rénovation", industry_key: "construction",
        source: "OpenStreetMap", phone: "", public_email: "", website: "", signals: []
      }];
      if (source === "partial") rows.osmCoverage = { status: "partial", remark: "timeout" };
      return rows;
    } } };
  } else {
    sandbox.KlirSources.osm.search = new Proxy(sandbox.KlirSources.osm.search, {
      apply(target, thisArg, args) {
        calls.sources.push({ params: args[0], limit: args[1] });
        return Reflect.apply(target, thisArg, args);
      }
    });
  }
  return { sandbox, fields, calls, waits };
}

test("le contrat distingue les six villes, sans repli vers Montréal", async () => {
  const engine = await loadEngine();
  for (const [query, key, city] of [
    ["30 entreprises de rénovation à Montréal", "montréal", "Montréal"],
    ["30 entreprises de renovation a Montreal", "montréal", "Montréal"],
    ["10 restaurants in Montreal", "montréal", "Montréal"],
    ["10 restaurants à Laval", "laval", "Laval"],
    ["20 cliniques dentaires à Québec", "québec", "Québec"],
    ["20 cliniques dentaires a Quebec", "québec", "Québec"],
    ["20 construction companies in Toronto", "toronto", "Toronto"],
    ["10 restaurants à Paris", "paris", "Paris"],
    ["10 restaurants in Paris", "paris", "Paris"],
    ["10 restaurants à Paris, France", "paris", "Paris"],
    ["10 restaurants à Lyon", "lyon", "Lyon"]
  ]) {
    const params = engine.parseQuery(query);
    assert.equal(params.place.status, "supported", query);
    assert.equal(params.cityKey, key, query);
    assert.equal(params.city.city, city, query);
    assert.equal(params.city.lat === 45.5017, key === "montréal", query);
  }
  const unnamed = engine.parseQuery("30 entreprises de rénovation");
  assert.equal(unnamed.place.status, "absent");
  assert.equal(unnamed.city, null);
  const paris = engine.describePlace(engine.parseQuery("10 restaurants à Paris"));
  assert.match(paris, /Paris, Île-de-France, France/);
  assert.match(paris, /48\.8566, 2\.3522/);
  assert.match(paris, /rayon de 2,2 km/);
  assert.match(paris, /ne sont pas recherchés/);
  assert.match(paris, /Pas une couverture mondiale/);
  assert.equal(paris.includes("45.5017"), false);
  const broad = engine.describePlace(engine.parseQuery("30 entreprises à Montréal"));
  assert.match(broad, /rayon de 1,5 km/);
  assert.equal(engineSource.includes("nominatim"), false);
});

test("Paris homonyme, Tokyo, São Paulo et Casablanca ne lancent aucune autre ville", async () => {
  const engine = await loadEngine();
  const ambiguous = [
    ["10 restaurants à Paris, Texas", "Paris, Texas, États-Unis"],
    ["10 restaurants à Paris TX", "Paris, Texas, États-Unis"],
    ["10 restaurants à Paris, Ontario", "Paris, Ontario, Canada"],
    ["entreprises de Montréal vers Québec", "Montréal, QC, Canada"]
  ];
  for (const [query, label] of ambiguous) {
    const params = engine.parseQuery(query);
    assert.equal(params.place.status, "ambiguous", query);
    assert.equal(params.city, null, query);
    assert.equal(params.place.candidates.some((item) => item.label === label), true, query);
    assert.match(params.place.message, /aucun crédit n'est réservé/i);
  }
  const confirmed = engine.applyExplicitPlace(engine.parseQuery("10 restaurants à Paris, Texas"), { placeConfirmation: "paris", quantity: 10 });
  assert.equal(confirmed.place.status, "supported");
  assert.equal(confirmed.city.city, "Paris");
  assert.equal(confirmed.city.lat, 48.8566);
  const refused = engine.applyExplicitPlace(engine.parseQuery("10 restaurants à Paris, Texas"), { placeConfirmation: "paris-texas" });
  assert.equal(refused.place.status, "unsupported");
  assert.equal(refused.city, null);
  assert.match(refused.place.message, /Paris, Texas, États-Unis/);

  const named = engine.parseQuery("30 entreprises de rénovation à Montréal");
  const conflict = engine.applyExplicitPlace(named, { cityKey: "laval", quantity: 10 });
  assert.equal(conflict.place.status, "ambiguous");
  assert.equal(conflict.place.title, "Lieux en contradiction");
  assert.equal(conflict.city, null);
  assert.match(conflict.place.message, /texte indique Montréal, QC, Canada/);
  assert.match(conflict.place.message, /sélection indique Laval, QC, Canada/);
  assert.match(conflict.place.message, /aucun crédit n'est réservé/i);
  const injected = engine.applyExplicitPlace(named, { cityKey: "laval", placeConfirmation: "toronto" });
  assert.equal(injected.city, null);
  assert.equal(injected.place.title, "Lieux en contradiction");
  const chosenText = engine.applyExplicitPlace(named, { cityKey: "laval", placeConfirmation: "montréal" });
  assert.equal(chosenText.city.city, "Montréal");
  assert.equal(chosenText.city.lat, 45.5017);
  const chosenList = engine.applyExplicitPlace(named, { cityKey: "laval", placeConfirmation: "laval", area: "montreal_island" });
  assert.equal(chosenList.city.city, "Laval");
  assert.equal(chosenList.area, "radius");
  const aligned = engine.applyExplicitPlace(named, { cityKey: "montréal" });
  assert.equal(aligned.place.status, "supported");
  assert.equal(aligned.city.city, "Montréal");

  for (const [query, status, display] of [
    ["10 restaurants à Tokyo", "unsupported", "Tokyo"],
    ["10 restaurants à Tōkyō", "unsupported", "Tōkyō"],
    ["10 restaurants à 東京", "unsupported", "東京"],
    ["10 restaurants à São Paulo", "unsupported", "São Paulo"],
    ["10 restaurants a Sao Paulo", "unsupported", "Sao Paulo"],
    ["cafés à Casablanca", "unsupported", "Casablanca"],
    ["cafés à الدار البيضاء", "unsupported", "الدار البيضاء"],
    ["10 restaurants à 北京", "not_found", "北京"],
    ["10 restaurants à Blorpland", "not_found", "Blorpland"]
  ]) {
    const params = engine.parseQuery(query);
    assert.equal(params.place.status, status, query);
    assert.equal(params.city, null, query);
    assert.equal(params.place.display, display, query);
    assert.match(params.place.message, /Pas une couverture mondiale/);
    assert.match(params.place.message, /Aucune autre ville n'est recherchée/);
    const forced = engine.applyExplicitPlace(params, { cityKey: "montréal", quantity: 10 });
    assert.equal(forced.city, null, query);
    assert.equal(forced.place.status === "supported", false, query);
  }
});

test("une ville refusée ne réserve aucun crédit et n'appelle pas OpenStreetMap", async () => {
  const { sandbox, fields, calls } = await harness({ query: "10 restaurants à Tokyo" });
  await sandbox.runSearch(fields.qInput.value);
  assert.equal(calls.sources.length, 0);
  assert.equal(calls.reservations.length, 0);
  assert.equal(calls.settlements.length, 0);
  assert.equal(sandbox.KS.S.credits.balance, 200);
  assert.equal(sandbox.KS.S.prospects.length, 0);
  assert.match(fields.prog.innerHTML, /data-search-state="unsupported"/);
  assert.match(fields.prog.innerHTML, /Tokyo/);
  assert.match(fields.prog.innerHTML, /pas pris en charge/i);
  assert.match(fields.searchSummary.textContent, /Pas une couverture mondiale/);
  assert.equal(fields.searchPrice.textContent, "0");
  assert.equal(sandbox.KS.S.usage.searches, 0);
});

test("São Paulo, Casablanca et un lieu introuvable gardent l'écriture d'origine", async () => {
  for (const [query, display] of [
    ["10 restaurants à São Paulo", "São Paulo"],
    ["cafés à الدار البيضاء", "الدار البيضاء"],
    ["10 restaurants à 北京", "北京"]
  ]) {
    const { sandbox, fields, calls } = await harness({ query });
    await sandbox.runSearch(fields.qInput.value);
    assert.equal(calls.sources.length, 0, query);
    assert.equal(calls.reservations.length, 0, query);
    assert.match(fields.prog.innerHTML, new RegExp(display), query);
    assert.equal(sandbox.KS.S.prospects.length, 0, query);
  }
});

test("un Paris homonyme attend une confirmation et ne cherche pas Montréal", async () => {
  const { sandbox, fields, calls } = await harness({ query: "10 restaurants à Paris, Texas", cityKey: "montréal" });
  await sandbox.runSearch(fields.qInput.value);
  assert.equal(calls.sources.length, 0);
  assert.equal(calls.reservations.length, 0);
  assert.match(fields.prog.innerHTML, /data-search-state="ambiguous"/);
  assert.match(fields.prog.innerHTML, /Paris, Texas/);
  assert.match(fields.prog.innerHTML, /Île-de-France/);
  await sandbox.runSearch(fields.qInput.value, { placeConfirmation: "paris-texas", quantity: 10 });
  assert.equal(calls.sources.length, 0);
  assert.match(fields.prog.innerHTML, /data-search-state="unsupported"/);
  await sandbox.runSearch(fields.qInput.value, { placeConfirmation: "paris", quantity: 10, industry: "restauration" });
  assert.equal(calls.sources.length, 1);
  assert.equal(calls.sources[0].params.city.city, "Paris");
  assert.equal(calls.sources[0].params.city.lat, 48.8566);
  assert.equal(calls.sources[0].params.city.lng, 2.3522);
  assert.equal(calls.reservations.length, 1);
  assert.equal(calls.reservations[0].amount, 6);
});

test("sans lieu dans la phrase, la ville choisie explicitement est affichée et utilisée", async () => {
  const { sandbox, fields, calls } = await harness({ query: "30 entreprises de rénovation", cityKey: "laval" });
  sandbox.updateSearchQuote();
  assert.match(fields.searchSummary.textContent, /Laval, Québec, Canada/);
  assert.match(fields.searchSummary.textContent, /45\.6066, -73\.7124/);
  assert.match(fields.searchSummary.textContent, /Pas une couverture mondiale/);
  await sandbox.runSearch(fields.qInput.value);
  assert.equal(calls.sources[0].params.city.city, "Laval");
  assert.notEqual(calls.sources[0].params.city.lat, 45.5017);
});

test("une clé default historique ne recherche pas Montréal", async () => {
  const { sandbox, fields, calls } = await harness({ query: "30 entreprises de rénovation", cityKey: "default" });
  await sandbox.runSearch(fields.qInput.value);
  assert.equal(calls.sources.length, 0);
  assert.equal(calls.reservations.length, 0);
  assert.match(fields.prog.innerHTML, /data-search-state="not_found"/);
  assert.equal(sandbox.KS.S.credits.balance, 200);
});

test("le radar sans ville prise en charge ne réserve rien", async () => {
  const { sandbox, calls } = await harness();
  sandbox.KS.S.icp = { industry: "restauration", city: "Tokyo", size: "" };
  await sandbox.radarRun();
  assert.equal(calls.reservations.length, 0);
  assert.equal(calls.sources.length, 0);
  assert.match(calls.notices.at(-1), /Aucun crédit n'a été réservé/);
  sandbox.KS.S.icp = { industry: "restauration", city: "Montréal", size: "" };
  await sandbox.radarRun();
  assert.equal(calls.sources.length, 1);
  assert.equal(calls.sources[0].params.city.city, "Montréal");
  assert.equal(calls.reservations.length, 1);
});

test("vide, partiel et erreur libèrent le crédit sans fiche inventée", async () => {
  for (const source of ["empty", "partial", "error"]) {
    const { sandbox, fields, calls } = await harness({ source });
    await sandbox.runSearch(fields.qInput.value);
    assert.equal(sandbox.KS.S.credits.balance, 200, source);
    assert.equal(calls.settlements.includes(true), false, source);
    assert.equal(sandbox.KS.S.usage.searches, 0, source);
    if (source === "partial") {
      assert.equal(sandbox.KS.S.prospects[0].collection_status, "partial");
      assert.equal(sandbox.KS.S.searches[0].status, "partielle");
    } else {
      assert.equal(sandbox.KS.S.prospects.length, 0, source);
      assert.match(fields.prog.innerHTML, new RegExp(source === "error" ? "failure" : "empty"));
    }
  }
});

function scriptedFetch(steps) {
  const calls = [];
  let index = 0;
  return {
    calls,
    fetch: async () => {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      calls.push(step.status == null ? 0 : step.status);
      if (step.error) throw step.error;
      return new Response(step.body, { status: step.status, headers: step.headers || {} });
    }
  };
}

test("429, 502, délai et 200 tronqué libèrent la réservation sans donnée synthétique", async () => {
  const cases = [
    { name: "429", steps: [{ status: 429, body: "", headers: { "Retry-After": "0" } }], calls: [429, 429, 429, 429], message: /429/ },
    { name: "502", steps: [{ status: 502, body: "bad gateway" }], calls: [502, 502, 502, 502], message: /502/ },
    { name: "timeout", steps: [{ error: Object.assign(new Error("aborted"), { name: "AbortError" }) }], calls: [0, 0, 0, 0], message: /temps/ },
    { name: "truncated", steps: [{ status: 200, body: '{"elements":[{"type":"node","id":1' }], calls: [200], message: /invalide/ }
  ];
  for (const item of cases) {
    const http = scriptedFetch(item.steps);
    const { sandbox, fields, calls } = await harness({ fetchImpl: http.fetch, query: "10 restaurants à Montréal" });
    await sandbox.runSearch(fields.qInput.value);
    assert.deepEqual(http.calls, item.calls, item.name);
    assert.equal(calls.reservations.length, 1, item.name);
    assert.deepEqual(calls.settlements, [false], item.name);
    assert.equal(sandbox.KS.S.credits.balance, 200, item.name);
    assert.equal(sandbox.KS.S.prospects.length, 0, item.name);
    assert.equal(sandbox.KS.S.usage.searches, 0, item.name);
    assert.match(fields.prog.innerHTML, /data-search-state="failure"/, item.name);
    assert.match(fields.prog.innerHTML, item.message, item.name);
    assert.equal(fields.prog.innerHTML.includes("Nord"), false, item.name);
    assert.equal(sandbox.KlirSources.osm.limits.requestMs, 18000, item.name);
    assert.equal(sandbox.KlirSources.osm.limits.queryTimeoutSec, 15, item.name);
    assert.equal(sandbox.KlirSources.osm.limits.retryAfterCapMs, 30000, item.name);
  }
});
