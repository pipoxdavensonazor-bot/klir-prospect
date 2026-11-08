import assert from "node:assert/strict";
import test from "node:test";
import { handleSearchGeocode, OPENCAGE_SECRET } from "../supabase/functions/search-geocode/search-geocode.mjs";

const origin = "https://cursor-search-pilot-ui-2f07.klirprospect.klirline.ca";
const env = {
  SUPABASE_URL: "https://pwakjxjjxswdjsapsbxn.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_fixture",
  OPENCAGE_API_KEY: "clef-de-test-ne-pas-journaliser"
};

function request(body, method = "POST") {
  return new Request("http://127.0.0.1/search-geocode", {
    method,
    headers: { origin, authorization: "Bearer jeton-opaque", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
}

function client({ admin = true } = {}) {
  return () => ({
    auth: { async getUser() { return { data: { user: { id: "user" } }, error: null }; } },
    async rpc() { return { data: admin, error: null }; }
  });
}

test("sans admin le géocodeur ne part pas", async () => {
  let called = false;
  const response = await handleSearchGeocode(request({ action: "geocode", query: "Lyon" }), {
    env,
    createClient: client({ admin: false }),
    fetch: async () => { called = true; throw new Error("réseau"); }
  });
  assert.equal(response.status, 403);
  assert.equal(called, false);
});

test("le statut admin dit si la clé est posée sans la renvoyer", async () => {
  const response = await handleSearchGeocode(request({ action: "status" }), { env, createClient: client() });
  const body = await response.json();
  assert.equal(body.configured, true);
  assert.equal(body.operational, false);
  assert.equal(body.secret, OPENCAGE_SECRET);
  assert.equal(JSON.stringify(body).includes(env.OPENCAGE_API_KEY), false);
});

test("une ville ponctuelle appelle OpenCage et masque la clé", async () => {
  let seen = "";
  const response = await handleSearchGeocode(request({
    action: "geocode",
    usage: "ponctuel",
    query: "Lyon",
    language: "fr",
    countryCode: "fr"
  }), {
    env,
    createClient: client(),
    fetch: async (url) => {
      seen = String(url);
      return {
        ok: true,
        status: 200,
        json: async () => ({
          licenses: [{ name: "see attribution", url: "https://opencagedata.com/credits" }],
          results: [{ formatted: "Lyon, France", confidence: 9, geometry: { lat: 45.75, lng: 4.85 }, components: { country: "France", country_code: "fr", city: "Lyon" } }]
        })
      };
    }
  });
  const body = await response.json();
  assert.equal(body.outcome, "a_confirmer");
  assert.equal(body.candidates.length, 1);
  assert.equal(body.candidates[0].permanentId, null);
  assert.equal(body.operational, false);
  assert.equal(seen.includes("key="), true);
  assert.equal(JSON.stringify(body).includes(env.OPENCAGE_API_KEY), false);
});

test("un catalogue ne part pas vers OpenCage", async () => {
  let called = false;
  const response = await handleSearchGeocode(request({ action: "geocode", usage: "catalogue", query: "Lyon" }), {
    env,
    createClient: client(),
    fetch: async () => { called = true; throw new Error("réseau"); }
  });
  assert.equal(response.status, 403);
  assert.equal(called, false);
});
