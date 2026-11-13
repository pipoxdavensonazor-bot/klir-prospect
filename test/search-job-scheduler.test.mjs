import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { handleRunnerDiagnostic, CONNECT_ROLE, SCHEDULER_HEADER } from "../supabase/functions/_shared/search-job-runner-edge.mjs";
import { TEST_PROJECT_REF, TEST_SUPABASE_URL } from "../supabase/functions/_shared/search-job-edge.mjs";

const root = new URL("../supabase/migrations/", import.meta.url);
const schedulerFile = "20261113090000_search_job_scheduler.sql";
const files = [
  "20261006004359_create_profiles_and_rls.sql",
  "20261011221500_credit_ledger.sql",
  "20261022130000_enforce_reserved_search_quota.sql",
  "20261105014500_admin_role.sql",
  "20261107190000_search_jobs.sql",
  "20261107201000_search_job_ledger.sql",
  "20261107220000_search_job_runner_role.sql",
  "20261107233000_search_job_connect_test.sql",
  "20261108170000_search_job_places.sql",
  schedulerFile
];
const sql = {};
for (const file of files) sql[file] = await readFile(new URL(file, root), "utf8");
const schedulerSql = sql[schedulerFile];

const ada = "11111111-1111-4111-8111-111111111111";
const secret = "s".repeat(48);
const testUrl = `https://${TEST_PROJECT_REF}.supabase.co/functions/v1/search-job-runner`;

// Bouchons : Vault et pg_net n'existent pas dans PGlite. net.http_post journalise l'appel.
const stub = `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end
$$;
grant usage on schema public to anon, authenticated;
grant usage on schema auth to anon, authenticated;
create schema if not exists vault;
create table vault.decrypted_secrets (name text primary key, decrypted_secret text);
create schema if not exists net;
create table net.calls (id bigint generated always as identity primary key, url text, body jsonb, headers jsonb);
create function net.http_post(url text, body jsonb, headers jsonb, timeout_milliseconds integer)
returns bigint language sql as $$
  insert into net.calls (url, body, headers) values (url, body, headers) returning id
$$;
`;

async function database() {
  const db = new PGlite();
  await db.exec(stub);
  for (const file of files) await db.exec(sql[file]);
  await db.exec(`insert into auth.users (id, email) values ('${ada}', 'ada@example.invalid')`);
  return db;
}

async function configure(db, url = testUrl) {
  await db.query(
    "update private.search_scheduler_settings set enabled = true, runner_url = $1, gateway_key = $2",
    [url, "cle-publique-passerelle-fixture"]
  );
}

async function enqueue(db) {
  await db.exec(`select set_config('request.jwt.claim.sub', '${ada}', false)`);
  await db.exec("set role authenticated");
  await db.query("select public.enqueue_search_job($1, $2::jsonb)", [
    "planif-laval-0001",
    JSON.stringify({ place_status: "supported", cityKey: "laval", quantity: 10 })
  ]);
  await db.exec("reset role");
}

async function tick(db) {
  return (await db.query("select private.search_scheduler_tick() as outcome")).rows[0].outcome;
}

async function calls(db) {
  return (await db.query("select url, body, headers from net.calls order by id")).rows;
}

test("la migration ne touche ni jobs_enabled ni secret, et reste inactive par défaut", async () => {
  assert.doesNotMatch(schedulerSql, /jobs_enabled\s*=\s*true/);
  assert.doesNotMatch(schedulerSql, /update private\.search_job_settings/);
  assert.doesNotMatch(schedulerSql, /eyJ|sb_secret|sb_publishable|service_role/);
  assert.match(schedulerSql, /enabled boolean not null default false/);
  assert.match(schedulerSql, /min_interval_seconds between 30 and 3600/);
  assert.match(schedulerSql, /'\* \* \* \* \*'/);
  const db = await database();
  await db.exec("update private.search_job_settings set jobs_enabled = true");
  await enqueue(db);
  assert.equal(await tick(db), "inactif");
  assert.equal((await calls(db)).length, 0);
  // Rejouable.
  await db.exec(schedulerSql);
  assert.equal(await tick(db), "inactif");
});

test("garde moteur : jobs_enabled=false ne fait aucun appel", async () => {
  const db = await database();
  await configure(db);
  assert.equal(await tick(db), "moteur_off");
  assert.equal((await calls(db)).length, 0);
});

test("file vide, puis secret absent : aucun appel", async () => {
  const db = await database();
  await configure(db);
  await db.exec("update private.search_job_settings set jobs_enabled = true");
  assert.equal(await tick(db), "file_vide");
  await enqueue(db);
  assert.equal(await tick(db), "secret_absent");
  await db.query("insert into vault.decrypted_secrets values ('klir_job_scheduler_secret', 'court')");
  assert.equal(await tick(db), "secret_absent");
  assert.equal((await calls(db)).length, 0);
});

test("un appel au plus par intervalle, avec le secret serveur et l'action fixe", async () => {
  const db = await database();
  await configure(db);
  await db.exec("update private.search_job_settings set jobs_enabled = true");
  await db.query("insert into vault.decrypted_secrets values ('klir_job_scheduler_secret', $1)", [secret]);
  await enqueue(db);
  assert.equal(await tick(db), "appel");
  assert.equal(await tick(db), "debit");
  assert.equal(await tick(db), "debit");
  const sent = await calls(db);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].url, testUrl);
  assert.deepEqual(sent[0].body, { action: "scheduled" });
  assert.equal(sent[0].headers["x-klir-scheduler"], secret);
  assert.equal(sent[0].headers.authorization, "Bearer cle-publique-passerelle-fixture");
  assert.equal(Object.keys(sent[0].body).length, 1);
  // Après l'intervalle, un nouvel appel est permis.
  await db.exec("update private.search_scheduler_settings set last_called_at = now() - interval '56 seconds'");
  assert.equal(await tick(db), "appel");
  const runs = await db.query("select outcome from private.search_scheduler_runs order by id");
  assert.deepEqual(runs.rows.map((row) => row.outcome), ["appel", "appel"]);
});

test("URL de production refusée, URL arbitraire rejetée par contrainte", async () => {
  const db = await database();
  await db.exec("update private.search_job_settings set jobs_enabled = true");
  await db.query("insert into vault.decrypted_secrets values ('klir_job_scheduler_secret', $1)", [secret]);
  await enqueue(db);
  await configure(db, "https://cbklwmjudobqwbkbxqgy.supabase.co/functions/v1/search-job-runner");
  assert.equal(await tick(db), "production_refusee");
  assert.equal((await calls(db)).length, 0);
  await assert.rejects(configure(db, "https://example.com/functions/v1/search-job-runner"), /check/i);
  await assert.rejects(configure(db, `${testUrl}?x=1`), /check/i);
});

test("aucun rôle client ni runner ne lit la configuration ni n'appelle le tick", async () => {
  const db = await database();
  for (const role of ["anon", "authenticated", "klir_job_api", "klir_job_runner"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(db.query("select private.search_scheduler_tick()"), /permission denied/i, role);
    await assert.rejects(db.query("select * from private.search_scheduler_settings"), /permission denied/i, role);
    await assert.rejects(db.query("update private.search_scheduler_settings set enabled = true"), /permission denied/i, role);
    await db.exec("reset role");
  }
});

// --- Fonction Edge : chemin planifié ---

function env(extra = {}) {
  return {
    SUPABASE_URL: TEST_SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_fixture",
    KLIR_ENV: "preview",
    KLIR_JOB_DB_HOST: "aws-1-ca-central-1.pooler.supabase.com",
    KLIR_JOB_DB_PORT: "6543",
    KLIR_JOB_DB_NAME: "postgres",
    KLIR_JOB_DB_USER: `${CONNECT_ROLE}.${TEST_PROJECT_REF}`,
    KLIR_JOB_DB_PASSWORD: "fixture-ne-pas-journaliser",
    KLIR_JOB_SCHEDULER_SECRET: secret,
    ...extra
  };
}

function scheduledRequest(header = secret, body = { action: "scheduled" }) {
  return new Request("http://127.0.0.1/search-job-runner", {
    method: "POST",
    headers: {
      authorization: "Bearer cle-publique-passerelle-fixture",
      "content-type": "application/json",
      ...(header ? { [SCHEDULER_HEADER]: header } : {})
    },
    body: JSON.stringify(body)
  });
}

function fakeConnect({ jobsEnabled = true, identity = { role_name: "klir_job_runner", session_name: "klir_job_connect_test" } } = {}) {
  const calls = [];
  const tx = {
    async unsafe(text) {
      calls.push(text);
      if (text.includes("current_user")) return [identity];
      if (text.includes("diagnose_search_job_connection")) return [{ jobs_enabled: jobsEnabled }];
      if (text.includes("expire_due_search_jobs")) return [{ row: { expired: 0 } }];
      if (text.includes("claim_search_jobs")) return [{ row: [] }];
      return [];
    }
  };
  let connected = 0;
  return {
    calls,
    connected: () => connected,
    connect: async () => {
      connected += 1;
      return { begin: (fn) => fn(tx), close: async () => {} };
    }
  };
}

const neverAuth = () => { throw new Error("pas_de_client_utilisateur"); };
const provider = { async run() { return { count: 0, records: [] }; } };

test("Edge planifié : sans le bon secret, rien ne se connecte", async () => {
  for (const [header, extra, status, code] of [
    ["", {}, 401, "planificateur_refuse"],
    ["mauvais".repeat(8), {}, 401, "planificateur_refuse"],
    [secret.slice(0, 47), {}, 401, "planificateur_refuse"],
    [secret, { KLIR_JOB_SCHEDULER_SECRET: "" }, 503, "planificateur_inactif"],
    [secret, { KLIR_JOB_SCHEDULER_SECRET: "court" }, 503, "planificateur_inactif"],
    [secret, { KLIR_ENV: "production" }, 401, "environnement_refuse"],
    [secret, { SUPABASE_URL: "https://cbklwmjudobqwbkbxqgy.supabase.co" }, 401, "production_refusee"],
    [secret, { KLIR_JOB_DB_HOST: "aws-0-us-east-1.pooler.supabase.com" }, 401, "hote_test_refuse"],
    [secret, { KLIR_JOB_TEST_JOB_ID: ada }, 409, "cible_active"]
  ]) {
    const db = fakeConnect();
    const response = await handleRunnerDiagnostic(scheduledRequest(header), { env: env(extra), createClient: neverAuth, connect: db.connect, provider });
    assert.equal(response.status, status, code);
    const body = await response.json();
    assert.equal(body.error, code);
    assert.equal(JSON.stringify(body).includes(secret), false);
    assert.equal(db.connected(), 0, code);
  }
});

test("Edge planifié : corps strict, aucune cible client", async () => {
  const db = fakeConnect();
  const response = await handleRunnerDiagnostic(scheduledRequest(secret, { action: "scheduled", jobId: ada }), { env: env(), createClient: neverAuth, connect: db.connect, provider });
  assert.equal(response.status, 400);
  assert.equal(db.connected(), 0);
});

test("Edge planifié : moteur éteint, aucune réclamation ni expiration", async () => {
  const db = fakeConnect({ jobsEnabled: false });
  const response = await handleRunnerDiagnostic(scheduledRequest(), { env: env(), createClient: neverAuth, connect: db.connect, provider });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { mode: "planifie", executed: false, skipped: "moteur_off" });
  assert.equal(db.calls.some((text) => /expire_due_search_jobs|claim_search_jobs|claim_authorized/.test(text)), false);
});

test("Edge planifié : moteur allumé, expiration puis réclamation d'un seul job", async () => {
  const db = fakeConnect({ jobsEnabled: true });
  const response = await handleRunnerDiagnostic(scheduledRequest(), { env: env(), createClient: neverAuth, connect: db.connect, provider });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.mode, "planifie");
  assert.equal(body.executed, true);
  const order = db.calls.filter((text) => /expire_due|claim_/.test(text));
  assert.deepEqual(order, ["select private.expire_due_search_jobs() as row", "select private.claim_search_jobs(1) as row"]);
  assert.equal(db.calls[0], "set local role klir_job_runner");
});

test("Edge planifié : session base inattendue refusée", async () => {
  const db = fakeConnect({ identity: { role_name: "postgres", session_name: "postgres" } });
  const response = await handleRunnerDiagnostic(scheduledRequest(), { env: env(), createClient: neverAuth, connect: db.connect, provider });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error, "role_exploitation_refuse");
  assert.equal(db.calls.some((text) => /claim_/.test(text)), false);
});

test("Edge : l'en-tête planificateur ne sert pas de passe-droit sur le chemin admin", async () => {
  const request = new Request("http://127.0.0.1/search-job-runner", {
    method: "POST",
    headers: { authorization: "Bearer jeton", "content-type": "application/json", [SCHEDULER_HEADER]: secret },
    body: JSON.stringify({ action: "cycle" })
  });
  const response = await handleRunnerDiagnostic(request, { env: env(), createClient: neverAuth, connect: async () => { throw new Error("non"); } });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "planificateur_refuse");
});

test("la fonction Edge transmet KLIR_JOB_SCHEDULER_SECRET", async () => {
  const index = await readFile(new URL("../supabase/functions/search-job-runner/index.ts", import.meta.url), "utf8");
  assert.match(index, /"KLIR_JOB_SCHEDULER_SECRET"/);
});
