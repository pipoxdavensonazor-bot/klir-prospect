import test from "node:test";
import assert from "node:assert/strict";
import { handleSearchJobRequest, PROD_SITE_ORIGIN, TARGETED_UI_ORIGIN } from "../supabase/functions/_shared/search-job-edge.mjs";

const preflight = (origin) => handleSearchJobRequest(new Request("http://127.0.0.1/search-jobs", { method: "OPTIONS", headers: { origin } }), { env: {} });

test("CORS : l'origine du site de production est acceptée", async () => {
  assert.equal(PROD_SITE_ORIGIN, "https://klirprospect.klirline.ca");
  const r = await preflight(PROD_SITE_ORIGIN);
  assert.equal(r.headers.get("access-control-allow-origin"), PROD_SITE_ORIGIN);
});

test("CORS : la preview reste acceptée, une origine voisine est refusée", async () => {
  assert.equal((await preflight(TARGETED_UI_ORIGIN)).headers.get("access-control-allow-origin"), TARGETED_UI_ORIGIN);
  for (const o of ["https://evil.klirprospect.klirline.ca", "http://klirprospect.klirline.ca", "https://klirprospect.klirline.ca.evil.com"]) {
    assert.equal((await preflight(o)).headers.get("access-control-allow-origin"), null, o);
  }
});
