// Recette du projet Test déjà publié. Elle n'allume pas le moteur, n'envoie aucune
// ville à OpenCage, et n'utilise pas la production. Lancer avec SEARCH_TEST_LIVE=1.
import assert from "node:assert/strict";
import test from "node:test";

const LIVE = process.env.SEARCH_TEST_LIVE === "1";
const TEST_REF = "pwakjxjjxswdjsapsbxn";
const PROD_REF = "cbklwmjudobqwbkbxqgy";
const FUNCTIONS = `https://${TEST_REF}.supabase.co/functions/v1`;
const PREVIEW = "https://cursor-search-pilot-ui-2f07.klirprospect.klirline.ca";
const DIAGNOSTIC = "https://cursor-test-server-diagnostic-2f07.klirprospect.klirline.ca";
const PUBLIC_SITE = "https://klirprospect.klirline.ca";
const CITIES = ["montréal", "laval", "québec", "toronto", "paris", "lyon"];

function live(t) {
  if (LIVE) return true;
  t.skip("SEARCH_TEST_LIVE=1 interroge le projet Test publié");
  return false;
}

async function read(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(20000),
    headers: {
      "user-agent": "KlirRequirements/1.0",
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const project = response.headers.get("sb-project-ref");
  if (project) assert.equal(project, TEST_REF);
  if (project) assert.equal(text.includes(PROD_REF), false, url);
  return { response, text };
}

test("la prévisualisation pilote pointe vers Test et passe par les jobs", async (t) => {
  if (!live(t)) return;
  const config = await read(`${PREVIEW}/config.js`);
  assert.equal(config.response.status, 200);
  assert.equal(config.text.includes(PROD_REF), false);
  assert.match(config.text, new RegExp(`"supabaseUrl":"https://${TEST_REF}\\.supabase\\.co"`));
  assert.match(config.text, /"environment":"preview"/);
  assert.match(config.text, /"stripeTestCheckout":false/);
  assert.equal(config.text.includes("sb_secret_"), false);
  assert.equal(config.text.includes("OPENCAGE_API_KEY"), false);

  const app = await read(`${PREVIEW}/app.js`);
  assert.equal(app.response.status, 200);
  assert.equal(app.text.includes(PROD_REF), false);
  const search = app.text.slice(app.text.indexOf("async function runSearch"));
  assert.match(search, /overturePreview\(\)\)return runPilotJob\(q,savedParams\)/);
  assert.equal(app.text.includes("return runOvertureSearch"), false);
  assert.equal(app.text.split("runOvertureSearch(").length, 2);
  assert.match(app.text, /jobs_disabled:"Le moteur est éteint/);
  assert.equal(app.text.includes("OPENCAGE_API_KEY"), false);
  assert.equal(app.text.includes("opencagedata.com"), false);

  const auth = await read(`${PREVIEW}/auth.js`);
  assert.equal(auth.response.status, 200);
  assert.equal(auth.text.includes(`PROD_SUPABASE_URL = "https://${PROD_REF}.supabase.co"`), true);
  assert.equal(auth.text.split(PROD_REF).length, 2);
  const cities = auth.text.slice(auth.text.indexOf("PILOT_CITY_KEYS"), auth.text.indexOf("PILOT_CITY_KEYS") + 240)
    .replace(/\\x([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  for (const city of CITIES) assert.equal(cities.includes(`"${city}"`), true, city);
  assert.equal(auth.text.includes('functions.invoke("search-jobs"'), true);
  assert.equal(auth.text.includes('place_status: "supported"'), true);
  assert.equal(auth.text.includes("OPENCAGE_API_KEY"), false);

  const engine = await read(`${PREVIEW}/engine.js`);
  assert.equal(engine.response.status, 200);
  assert.equal(engine.text.includes(PROD_REF), false);
  assert.equal(engine.text.includes("OPENCAGE_API_KEY"), false);
  assert.equal(engine.text.includes("opencagedata.com"), false);
  assert.equal(engine.text.toLowerCase().includes("nominatim"), false);
});

test("les trois fonctions Test acceptent seulement les deux prévisualisations", async (t) => {
  if (!live(t)) return;
  const functions = ["search-jobs", "search-job-runner", "search-geocode"];
  const allowed = [PREVIEW, DIAGNOSTIC];
  const refused = [PUBLIC_SITE, "https://exemple.invalid"];
  for (const name of functions) {
    for (const origin of allowed) {
      const result = await read(`${FUNCTIONS}/${name}`, {
        method: "OPTIONS",
        headers: {
          origin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization,apikey,content-type,x-client-info"
        }
      });
      assert.equal(result.response.status, 204, `${name} ${origin}`);
      assert.equal(result.response.headers.get("access-control-allow-origin"), origin);
    }
    for (const origin of refused) {
      const result = await read(`${FUNCTIONS}/${name}`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "POST" }
      });
      assert.equal(result.response.status, 403, `${name} ${origin}`);
      assert.equal(result.response.headers.get("access-control-allow-origin"), null);
      assert.equal(JSON.parse(result.text).error, "origine_refusee");
    }
  }
});

test("sans session, aucune fonction ne lance une recherche ni un géocodage", async (t) => {
  if (!live(t)) return;
  const jobs = await read(`${FUNCTIONS}/search-jobs`, {
    method: "POST",
    headers: { origin: PREVIEW, "content-type": "application/json" },
    body: JSON.stringify({
      action: "enqueue",
      idempotencyKey: "pilot-montréal-10",
      payload: { place_status: "supported", cityKey: "montréal", quantity: 10 }
    })
  });
  assert.equal(jobs.response.status, 401);
  assert.equal(jobs.text.includes("created"), false);

  const runner = await read(`${FUNCTIONS}/search-job-runner`, {
    method: "POST",
    headers: { origin: PREVIEW, "content-type": "application/json" },
    body: JSON.stringify({ action: "diagnose" })
  });
  assert.equal(runner.response.status, 401);
  assert.equal(runner.text.includes("\"executed\":true"), false);

  const geocode = await read(`${FUNCTIONS}/search-geocode`, {
    method: "POST",
    headers: { origin: PREVIEW, "content-type": "application/json" },
    body: JSON.stringify({ action: "geocode", usage: "ponctuel", query: "Lyon", language: "fr", countryCode: "fr" })
  });
  assert.equal(geocode.response.status, 401);
  const body = JSON.parse(geocode.text);
  assert.equal(body.candidates, undefined);
  assert.equal(geocode.text.includes("opencagedata.com"), false);
  assert.equal(geocode.text.includes("OPENCAGE_API_KEY"), false);

  const status = await read(`${FUNCTIONS}/search-geocode`, {
    method: "POST",
    headers: { origin: PREVIEW, "content-type": "application/json" },
    body: JSON.stringify({ action: "status" })
  });
  assert.equal(status.response.status, 401);
  assert.equal(status.text.includes("configured"), false);
});
