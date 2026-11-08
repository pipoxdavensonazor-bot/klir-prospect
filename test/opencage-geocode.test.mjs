import assert from "node:assert/strict";
import test from "node:test";
import { OPENCAGE_SECRET, createOpenCageGeocoder } from "../tools/opencage-geocode.mjs";
import { prepareJobPayload } from "../tools/source-job-bridge.mjs";

const SECRET = "clef-de-test-ne-pas-journaliser";

function place(formatted, country, lat, lng) {
  return {
    formatted,
    confidence: 7,
    bounds: { northeast: { lat: lat + 0.01, lng: lng + 0.01 }, southwest: { lat: lat - 0.01, lng: lng - 0.01 } },
    geometry: { lat, lng },
    components: {
      country_code: country,
      country: country === "ca" ? "Canada" : "France",
      city: formatted.split(",")[0]
    }
  };
}

function harness(handler, options = {}) {
  const calls = [];
  let clock = 10_000;
  const geocoder = createOpenCageGeocoder({
    env: { [OPENCAGE_SECRET]: SECRET, ...options.env },
    budget: options.budget,
    clock: () => clock,
    sleep: async (ms) => { calls.push(["sleep", ms]); clock += ms; },
    fetch: async (url, init) => {
      calls.push(["fetch", url]);
      if (String(url).includes(SECRET) === false) throw new Error("url sans clé");
      return handler(url, init, calls.length);
    },
    ...options.geocoder
  });
  return { geocoder, calls, advance: (ms) => { clock += ms; } };
}

function jsonResponse(results, status = 200) {
  return { status, json: async () => ({ licenses: [{ name: "see attribution guide", url: "https://opencagedata.com/credits" }], results }) };
}

test("sans clé, aucun appel et le nom du secret est explicite", async () => {
  let called = false;
  const geocoder = createOpenCageGeocoder({
    env: {},
    fetch: async () => { called = true; throw new Error("réseau"); }
  });
  const result = await geocoder.lookup({ query: "Montréal", language: "fr", countryCode: "ca" });
  assert.equal(result.outcome, "cle_absente");
  assert.equal(result.secret, "OPENCAGE_API_KEY");
  assert.equal(result.operational, false);
  assert.equal(called, false);
});

test("une réponse unique reste à confirmer et ne fabrique ni contour ni identifiant", async () => {
  const { geocoder, calls } = harness(() => jsonResponse([place("Montréal, Canada", "ca", 45.5017, -73.5673)]));
  const result = await geocoder.lookup({ query: "Montréal", language: "fr", countryCode: "ca", usage: "ponctuel" });
  assert.equal(result.outcome, "a_confirmer");
  assert.equal(result.candidates[0].permanentId, null);
  assert.equal(result.candidates[0].boundary, null);
  assert.equal(JSON.stringify(result).includes("northeast"), false);
  assert.equal(JSON.stringify(result).includes(SECRET), false);
  assert.equal(calls.filter((call) => call[0] === "fetch").length, 1);
});

test("deux pays restent ambigus tant qu'une confirmation exacte manque", async () => {
  const { geocoder } = harness(() => jsonResponse([
    place("Paris, France", "fr", 48.8566, 2.3522),
    place("Paris, United States", "us", 33.6609, -95.5555)
  ]));
  const ambiguous = await geocoder.lookup({ query: "Paris", language: "fr" });
  assert.equal(ambiguous.outcome, "ambigu");
  const refused = await geocoder.lookup({
    query: "Paris",
    language: "fr",
    confirmation: { countryCode: "DE", formatted: "Paris, France", language: "fr" }
  });
  assert.equal(refused.outcome, "confirmation_refusee");
  const confirmed = await geocoder.lookup({
    query: "Paris",
    language: "fr",
    confirmation: { countryCode: "FR", formatted: "Paris, France", language: "fr" }
  });
  assert.equal(confirmed.outcome, "confirme");
  assert.equal(confirmed.selected.countryCode, "FR");
  assert.equal(confirmed.cached, true);
});

test("le géocodage systématique de catalogue n'appelle pas le réseau", async () => {
  let called = false;
  const geocoder = createOpenCageGeocoder({
    env: { [OPENCAGE_SECRET]: SECRET },
    fetch: async () => { called = true; return jsonResponse([]); }
  });
  const result = await geocoder.lookup({ query: "Montréal", usage: "catalogue", language: "fr" });
  assert.equal(result.outcome, "geocodage_systematique_refuse");
  assert.equal(called, false);
});

test("quota, délai et clé dans une erreur restent des refus sans secret", async () => {
  const quota = harness(() => jsonResponse([], 402));
  assert.equal((await quota.geocoder.lookup({ query: "Québec", language: "fr", countryCode: "ca" })).outcome, "quota_fournisseur");
  const expired = createOpenCageGeocoder({
    env: { [OPENCAGE_SECRET]: SECRET },
    fetch: async () => { const error = new Error(`timeout ${SECRET}`); error.name = "AbortError"; throw error; }
  });
  const timed = await expired.lookup({ query: "Lyon", language: "fr", countryCode: "fr" });
  assert.equal(timed.outcome, "delai_depasse");
  assert.equal(JSON.stringify(timed).includes(SECRET), false);
  const leaked = createOpenCageGeocoder({
    env: { [OPENCAGE_SECRET]: SECRET },
    fetch: async () => { throw new Error(`https://api.opencagedata.com/geocode/v1/json?key=${SECRET}`); }
  });
  const down = await leaked.lookup({ query: "Laval", language: "fr", countryCode: "ca" });
  assert.equal(down.outcome, "panne");
  assert.equal(JSON.stringify(down).includes(SECRET), false);
});

test("un second appel identique relit le cache et le cache exporté n'a pas la clé", async () => {
  const { geocoder, calls } = harness(() => jsonResponse([place("Lyon, France", "fr", 45.764, 4.8357)]));
  await geocoder.lookup({ query: "Lyon", language: "fr", countryCode: "fr" });
  const again = await geocoder.lookup({ query: "Lyon", language: "fr", countryCode: "fr" });
  assert.equal(again.cached, true);
  assert.equal(calls.filter((call) => call[0] === "fetch").length, 1);
  const portable = JSON.stringify(geocoder.exportCache());
  assert.equal(portable.includes(SECRET), false);
  assert.match(portable, /OpenStreetMap contributors/);
});

test("une confirmation Montréal prépare le contrat de job sans l'enfiler", async () => {
  const { geocoder } = harness(() => jsonResponse([place("Montréal, Canada", "ca", 45.5017, -73.5673)]));
  const geocode = await geocoder.lookup({
    query: "Montréal",
    language: "fr",
    countryCode: "ca",
    confirmation: { countryCode: "CA", formatted: "Montréal, Canada", language: "fr" }
  });
  const prepared = prepareJobPayload({ geocode, quantity: 10, release: "2026-10-21.0" });
  assert.equal(prepared.ready, true);
  assert.equal(prepared.enqueue, false);
  assert.equal(prepared.jobsEnabled, false);
  assert.equal(prepared.billing, "refuse");
  assert.equal(prepared.payload.place_status, "supported");
  assert.equal(prepared.payload.cityKey, "montréal");
  const outside = prepareJobPayload({
    geocode: { ...geocode, selected: { ...geocode.selected, countryCode: "US", latitude: 33.66, longitude: -95.55 } },
    quantity: 10
  });
  assert.equal(outside.reason, "lieu_hors_contrat");
  assert.equal(outside.payload, null);
});
