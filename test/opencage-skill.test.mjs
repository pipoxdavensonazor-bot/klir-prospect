import assert from "node:assert/strict";
import test from "node:test";
import { createOpenCageGeocoder } from "../tools/opencage-geocode.mjs";

const env = { OPENCAGE_API_KEY: "clef-de-test-ne-pas-journaliser" };

function okBody(results, total = results.length) {
  return {
    status: { code: 200, message: "OK" },
    total_results: total,
    licenses: [{ name: "see attribution", url: "https://opencagedata.com/credits" }],
    results
  };
}

function place(formatted, lat, lng, type, confidence) {
  return {
    formatted,
    confidence,
    geometry: { lat, lng },
    components: { country: "Germany", country_code: "de", city: "Berlin", _type: type }
  };
}

test("un préfixe trop court ne part pas vers OpenCage", async () => {
  let called = false;
  const geocoder = createOpenCageGeocoder({
    env,
    fetch: async () => { called = true; throw new Error("réseau"); }
  });
  const result = await geocoder.lookup({ usage: "ponctuel", query: "pa", language: "fr" });
  assert.equal(result.outcome, "requete_incomplete");
  assert.equal(called, false);
});

test("le code de statut du corps prime sur un HTTP 200", async () => {
  const geocoder = createOpenCageGeocoder({
    env,
    sleep: async () => {},
    fetch: async () => ({
      status: 200,
      json: async () => ({ status: { code: 402, message: "quota exceeded" }, results: [] })
    })
  });
  const result = await geocoder.lookup({ usage: "ponctuel", query: "Berlin", language: "de", countryCode: "de" });
  assert.equal(result.outcome, "quota_fournisseur");
  assert.equal(result.ok, false);
});

test("une réponse 200 sans résultat reste introuvable", async () => {
  const geocoder = createOpenCageGeocoder({
    env,
    fetch: async () => ({ status: 200, json: async () => okBody([], 0) })
  });
  const result = await geocoder.lookup({ usage: "ponctuel", query: "NOWHERE-INTERESTING" });
  assert.equal(result.outcome, "introuvable");
  assert.equal(result.candidates.length, 0);
});

test("l'ordre renvoyé est conservé et le type de lieu est lu sans supposer la ville", async () => {
  const geocoder = createOpenCageGeocoder({
    env,
    fetch: async () => ({
      status: 200,
      json: async () => okBody([
        place("Berlin, Germany", 52.52, 13.4, "city", 2),
        place("Berlin Street", 52.51, 13.41, "road", 9)
      ])
    })
  });
  const result = await geocoder.lookup({ usage: "ponctuel", query: "Berlin", language: "de", countryCode: "de" });
  assert.equal(result.outcome, "ambigu");
  assert.equal(result.candidates[0].formatted, "Berlin, Germany");
  assert.equal(result.candidates[0].confidence, 2);
  assert.equal(result.candidates[0].placeType, "city");
  assert.equal(result.candidates[1].placeType, "road");
  assert.equal(result.candidates[0].permanentId, null);
  assert.equal(result.candidates[0].boundary, null);
});

test("la clé publique de démonstration OpenCage répond sans utiliser notre secret", { skip: process.env.OPENCAGE_SKILL_LIVE !== "1" }, async () => {
  const geocoder = createOpenCageGeocoder({
    env: { OPENCAGE_API_KEY: "6d0e711d72d74daeb2b0bfd2a5cdfdba" },
    budget: 1
  });
  const result = await geocoder.lookup({ usage: "ponctuel", query: "Berlin, Germany", language: "en", countryCode: "de" });
  assert.equal(result.ok, true);
  assert.equal(result.candidates[0].countryCode, "DE");
  assert.equal(Number.isFinite(result.candidates[0].latitude), true);
  assert.equal(JSON.stringify(result).includes("6d0e711d72d74daeb2b0bfd2a5cdfdba"), false);
});
