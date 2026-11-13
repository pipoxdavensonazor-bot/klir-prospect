import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runChecks } from "../ops/monitor/check.mjs";

const URL_TEST = "https://pwakjxjjxswdjsapsbxn.supabase.co";
const healthy = { jobs_enabled: false, queued_over_15m: 0, running_over_15m: 0, open_reservations_expired: 0,
  runner_http_errors_1h: 0, scheduler_enabled: true, scheduler_last_call: null, scheduler_last_outcome: null };

function fake(routes) {
  return async (url) => {
    const u = String(url);
    for (const [k, v] of Object.entries(routes)) {
      if (u.includes(k)) {
        if (v instanceof Error) throw v;
        return new Response(v.body === undefined ? "{}" : JSON.stringify(v.body), { status: v.status ?? 200, headers: v.headers ?? {} });
      }
    }
    return new Response("", { status: 404 });
  };
}
const base = { "/build.json": { body: { commit: "abc" } }, "/healthz": { body: {} }, "search-job-runner": { status: 401 }, "klir_ops_health": { body: healthy } };
const run = (routes, extra = {}) => runChecks({ supabaseUrl: URL_TEST, anonKey: "k", siteUrl: "https://site.example", fetchImpl: fake({ ...base, ...routes }), ...extra });
const failed = (rs) => rs.filter((r) => !r.ok).map((r) => r.name);

test("tout est vert sur une cible saine", async () => {
  assert.deepEqual(failed(await run({})), []);
});

test("jobs bloqués et réservations échues => échec", async () => {
  const rs = await run({ klir_ops_health: { body: { ...healthy, queued_over_15m: 2, open_reservations_expired: 1 } } });
  assert.deepEqual(failed(rs).sort(), ["jobs bloqués", "réservations échues"].sort());
});

test("runner en 5xx ou injoignable => échec ; 401 => démarré", async () => {
  assert.deepEqual(failed(await run({ "search-job-runner": { status: 503 } })), ["runner"]);
  assert.deepEqual(failed(await run({ "search-job-runner": new TypeError("x") })), ["runner"]);
});

test("défi Cloudflare : attention par défaut, échec en mode strict", async () => {
  const challenge = { "/build.json": { status: 403, headers: { "cf-mitigated": "challenge" } } };
  assert.deepEqual(failed(await run(challenge)), []);
  assert.deepEqual(failed(await run(challenge, { siteStrict: true })), ["site"]);
});

test("URL Supabase invalide refusée", async () => {
  const rs = await runChecks({ supabaseUrl: "https://evil.example", anonKey: "k", fetchImpl: fake(base) });
  assert.deepEqual(failed(rs), ["configuration"]);
});

test("klir_ops_health : lecture seule, aucune donnée personnelle, droits bornés", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20261113100000_ops_health.sql", import.meta.url), "utf8");
  const body = sql.toLowerCase();
  assert.match(body, /\bstable\b/);
  assert.match(body, /set search_path = ''/);
  assert.doesNotMatch(body, /\b(insert|update|delete)\s+(into|from)?\s*(public|private)\./);
  assert.doesNotMatch(body, /email|user_id|payload|balance/);
  assert.match(body, /revoke all on function public\.klir_ops_health\(\) from public/);
});

test("workflows : planification inactive tant que la variable d'activation est absente", async () => {
  for (const f of ["backup.yml", "monitor.yml"]) {
    const y = await readFile(new URL(`../ops/workflows/${f}`, import.meta.url), "utf8");
    assert.match(y, /vars\.KLIR_(BACKUP|MONITOR)_ENABLED == 'true'/);
    assert.doesNotMatch(y, /cbklwmjudobqwbkbxqgy/);
  }
});

test("restore.sh refuse toute cible distante", async () => {
  const s = await readFile(new URL("../ops/backup/restore.sh", import.meta.url), "utf8");
  assert.match(s, /supabase\.co\*\|\*supabase\.com\*\|\*pooler\*/);
});
