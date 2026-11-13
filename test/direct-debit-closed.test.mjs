import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const migration = await readFile(new URL("../supabase/migrations/20261113160000_revoke_direct_debit_rpcs.sql", import.meta.url), "utf8");
const auth = await readFile(new URL("../src/auth.js", import.meta.url), "utf8");
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

test("la migration ferme les RPC de débit direct sans rien rouvrir", () => {
  for (const fn of ["reserve_usage", "settle_usage", "overture_begin", "overture_execute"]) {
    assert.match(migration, new RegExp(`revoke execute on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`), fn);
  }
  assert.doesNotMatch(migration, /\bgrant\b/i);
  assert.doesNotMatch(migration, /jobs_enabled\s*=\s*true|update public\.credit_accounts|eyJ|sb_secret/);
});

test("le navigateur ne connaît plus que la file serveur pour rechercher", () => {
  assert.doesNotMatch(auth, /rpc\("(reserve_usage|settle_usage|overture_begin|overture_execute)"/);
  assert.doesNotMatch(auth, /searchOverture|reserveUsage|settleUsage/);
  assert.match(auth, /functions\.invoke\("search-jobs"/);
  assert.match(auth, /from\("search_job_places"\)/);
  assert.match(auth, /place_status: "supported"/);
  assert.doesNotMatch(app, /reserveServerUsage|settleServerUsage|runOvertureSearch|KlirSources\.osm\.search\(/);
});
