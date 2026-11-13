import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const SEVEN = "'montréal', 'laval', 'québec', 'toronto', 'paris', 'lyon', 'marseille'";

test("la migration Marseille élargit la contrainte et la lecture bornée, sans écrire de fiche", () => {
  const sql = read("supabase/migrations/20261113190000_search_catalog_marseille.sql");
  assert.ok(sql.includes(`check (city_key in (${SEVEN}))`));
  assert.ok(sql.includes(`p_city_key not in (${SEVEN})`));
  assert.ok(sql.includes("least(40, greatest(0, coalesce(p_quantity, 10)))"));
  assert.ok(sql.includes("grant execute on function private.search_catalog_lookup(text, text, integer) to klir_job_runner;"));
  assert.equal(/insert\s+into/i.test(sql), false);
  assert.equal(/jobs_enabled\s*=|credit_accounts|update\s+public\./i.test(sql), false);
});

test("Marseille est acceptée par le front, le runner et les bornes d'extraction", async () => {
  assert.match(read("src/auth.js"), /SEARCH_JOB_CITY_KEYS = new Set\(\[[^\]]*"marseille"\]\)/);
  assert.match(read("supabase/functions/_shared/search-job-overture-pilot.mjs"), /CITY_KEYS = new Set\(\[[^\]]*"marseille"\]\)/);
  const data = read("src/data.js");
  assert.match(data, /"marseille": \{city:"Marseille"/);
  assert.match(data, /SUPPORTED_CITY_KEYS = \[[^\]]*"marseille"\]/);
  const { CITY_CENTERS } = await import("../tools/overture-places-bounds.mjs");
  const marseille = CITY_CENTERS.find((city) => city.key === "marseille");
  assert.deepEqual({ ...marseille }, { key: "marseille", countryCode: "FR", latitude: 43.2965, longitude: 5.3698 });
});
