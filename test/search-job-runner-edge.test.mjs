import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { handleRunnerDiagnostic, assertRunnerDbConfig, RUNNER_DIAGNOSTIC_SQL, CONNECT_ROLE, PREVIEW_ORIGIN, PILOT_UI_ORIGIN } from "../supabase/functions/_shared/search-job-runner-edge.mjs";
import { TEST_PROJECT_REF, TEST_SUPABASE_URL } from "../supabase/functions/_shared/search-job-edge.mjs";

const ada = "11111111-1111-4111-8111-111111111111";
const password = "fixture-ne-pas-journaliser";

function env(extra = {}) {
  return {
    SUPABASE_URL: TEST_SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_fixture",
    KLIR_JOB_DB_HOST: "aws-0-ca-central-1.pooler.supabase.com",
    KLIR_JOB_DB_PORT: "6543",
    KLIR_JOB_DB_NAME: "postgres",
    KLIR_JOB_DB_USER: `${CONNECT_ROLE}.${TEST_PROJECT_REF}`,
    KLIR_JOB_DB_PASSWORD: password,
    ...extra
  };
}

function request(token, body) {
  return new Request("http://127.0.0.1/search-job-runner", {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function fakeAuth({ admin = false, user = ada } = {}) {
  const calls = [];
  const client = {
    auth: {
      async getUser(jwt) {
        calls.push({ op: "getUser", jwt });
        if (!user) return { data: { user: null }, error: { message: "invalid" } };
        return { data: { user: { id: user } }, error: null };
      }
    },
    async rpc(name) {
      calls.push({ op: "rpc", name });
      if (name !== "is_admin") return { data: null, error: { message: "unexpected" } };
      return { data: admin, error: null };
    }
  };
  return { calls, createClient: () => client };
}

function fakeDb() {
  const calls = [];
  const tx = {
    async unsafe(text) {
      calls.push(text);
      if (text.includes("credit_accounts")) {
        const error = new Error("permission denied for table credit_accounts");
        error.code = "42501";
        throw error;
      }
      if (text.includes("current_user")) return [{ role_name: "klir_job_runner", session_name: "klir_job_connect_test" }];
      if (text.includes("diagnose_search_job_connection")) return [{ jobs_enabled: false }];
      return [];
    }
  };
  let constructed = null;
  const postgres = (options) => {
    constructed = options;
    return { begin: (fn) => fn(tx), end: async () => {} };
  };
  return { postgres, calls, options: () => constructed };
}

test("la configuration du runner échoue fermée et ne répète pas le secret", () => {
  assert.throws(() => assertRunnerDbConfig(env({ KLIR_JOB_DB_PASSWORD: "" })), (error) => {
    assert.equal(error.code, "connexion_serveur_absente");
    assert.equal(String(error.message).includes(password), false);
    return true;
  });
  assert.throws(() => assertRunnerDbConfig(env({ KLIR_JOB_DB_HOST: "db.cbklwmjudobqwbkbxqgy.supabase.co" })), /production_refusee/);
  assert.throws(() => assertRunnerDbConfig(env({ KLIR_JOB_DB_PORT: "5432" })), /port_non_transaction/);
  assert.throws(() => assertRunnerDbConfig(env({ KLIR_JOB_DB_USER: "postgres.pwakjxjjxswdjsapsbxn" })), /role_connexion_refuse/);
  assert.throws(() => assertRunnerDbConfig(env({ KLIR_JOB_DB_USER: "service_role.pwakjxjjxswdjsapsbxn" })), /role_connexion_refuse/);
});

test("un JWT non admin n'ouvre pas la base, et une exécution est fermée", async () => {
  const auth = fakeAuth({ admin: false });
  const db = fakeDb();
  const refused = await handleRunnerDiagnostic(request("jeton-ada", { action: "diagnose" }), {
    env: env(),
    createClient: auth.createClient,
    connect: async () => { throw new Error("ne_pas_connecter"); }
  });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).error, "autorisation_refusee");
  assert.equal(auth.calls.some((call) => call.op === "rpc" && call.name === "is_admin"), true);

  const stranger = fakeAuth({ admin: true });
  const run = await handleRunnerDiagnostic(request("jeton-ada", { action: "run" }), {
    env: env(),
    createClient: stranger.createClient,
    connect: db.postgres
  });
  assert.equal(run.status, 403);
  assert.equal((await run.json()).error, "fournisseur_absent");
  assert.equal(db.options(), null);
  const anonymous = await handleRunnerDiagnostic(request("", { action: "diagnose" }), { env: env(), createClient: auth.createClient });
  assert.equal(anonymous.status, 401);
  assert.equal(JSON.stringify(await anonymous.json()).includes("jobsEnabled"), false);
});

test("le diagnostic admin lit le moteur éteint et refuse la facturation sans exécuter de job", async () => {
  const auth = fakeAuth({ admin: true });
  const db = fakeDb();
  let seen = null;
  const response = await handleRunnerDiagnostic(request("jeton-ada", { action: "diagnose" }), {
    env: env(),
    createClient: auth.createClient,
    connect: async (source) => {
      seen = source.KLIR_JOB_DB_PASSWORD;
      const sql = db.postgres({
        host: source.KLIR_JOB_DB_HOST,
        port: Number(source.KLIR_JOB_DB_PORT),
        database: source.KLIR_JOB_DB_NAME,
        username: source.KLIR_JOB_DB_USER,
        password: source.KLIR_JOB_DB_PASSWORD,
        ssl: "require",
        max: 1,
        prepare: false
      });
      return { begin: sql.begin, close: sql.end };
    }
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.connected, true);
  assert.equal(body.role, "klir_job_runner");
  assert.equal(body.jobsEnabled, false);
  assert.equal(body.billing, "refuse");
  assert.equal(body.provider, "absent");
  assert.equal(body.executed, false);
  assert.equal(body.scheduler, "off");
  assert.equal(JSON.stringify(body).includes(password), false);
  assert.equal(seen, password);
  assert.equal(db.calls.includes(RUNNER_DIAGNOSTIC_SQL.assume), true);
  assert.equal(db.calls.includes(RUNNER_DIAGNOSTIC_SQL.billingProbe), true);
  assert.equal(db.calls.some((text) => /claim_search_jobs|reconcile_search_job|expire_due_search_jobs|record_search_collection|reserve_usage|settle_usage/.test(text)), false);
  const options = db.options();
  assert.equal(options.prepare, false);
  assert.equal(options.max, 1);
  assert.equal(options.ssl, "require");
  assert.equal(options.port, 6543);
});

test("un admin lance un seul cycle local, un autre rôle ne touche pas la base", async () => {
  const stranger = fakeAuth({ admin: false });
  const closed = await handleRunnerDiagnostic(request("jeton-ada", { action: "cycle" }), {
    env: env(),
    createClient: stranger.createClient,
    connect: async () => { throw new Error("ne_pas_connecter"); }
  });
  assert.equal(closed.status, 403);

  const auth = fakeAuth({ admin: true });
  const db = fakeDb();
  let ran = 0;
  const response = await handleRunnerDiagnostic(request("jeton-ada", { action: "cycle" }), {
    env: env(),
    createClient: auth.createClient,
    connect: async () => ({ begin: db.postgres().begin, close: async () => {} }),
    provider: { async run() { ran += 1; return { count: 8 }; } }
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.executed, true);
  assert.equal(body.provider, "overture-places-pilot");
  assert.equal(body.operational, false);
  assert.equal(body.scheduler, "off");
  assert.equal(body.jobs.length, 0);
  assert.equal(ran, 0);
  assert.equal(db.calls.some((text) => text.includes("set local role klir_job_runner")), true);
  assert.equal(db.calls.some((text) => text.includes("claim_search_jobs")), true);
  assert.equal(JSON.stringify(body).includes(password), false);
});

test("la prévisualisation Test peut demander le diagnostic, une autre origine non", async () => {
  const preview = new Request("http://127.0.0.1/search-job-runner", { method: "OPTIONS", headers: { origin: PREVIEW_ORIGIN } });
  const allowed = await handleRunnerDiagnostic(preview, { env: env() });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), PREVIEW_ORIGIN);
  const pilot = new Request("http://127.0.0.1/search-job-runner", { method: "OPTIONS", headers: { origin: PILOT_UI_ORIGIN } });
  const pilotAllowed = await handleRunnerDiagnostic(pilot, { env: env() });
  assert.equal(pilotAllowed.status, 204);
  assert.equal(pilotAllowed.headers.get("access-control-allow-origin"), PILOT_UI_ORIGIN);
  assert.match(allowed.headers.get("access-control-allow-methods"), /POST/);
  const foreign = new Request("http://127.0.0.1/search-job-runner", { method: "OPTIONS", headers: { origin: "https://klirprospect.klirline.ca" } });
  const refused = await handleRunnerDiagnostic(foreign, { env: env() });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get("access-control-allow-origin"), null);
  const auth = fakeAuth({ admin: true });
  const db = fakeDb();
  const posted = new Request("http://127.0.0.1/search-job-runner", {
    method: "POST",
    headers: { authorization: "Bearer jeton-opaque", "content-type": "application/json", origin: PREVIEW_ORIGIN },
    body: JSON.stringify({ action: "diagnose" })
  });
  const response = await handleRunnerDiagnostic(posted, {
    env: env(),
    createClient: auth.createClient,
    connect: async (source) => {
      const sql = db.postgres({
        host: source.KLIR_JOB_DB_HOST,
        port: Number(source.KLIR_JOB_DB_PORT),
        database: source.KLIR_JOB_DB_NAME,
        username: source.KLIR_JOB_DB_USER,
        password: source.KLIR_JOB_DB_PASSWORD,
        ssl: "require",
        max: 1,
        prepare: false
      });
      return { begin: sql.begin, close: sql.end };
    }
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), PREVIEW_ORIGIN);
  const body = await response.json();
  assert.equal(body.connected, true);
  assert.equal(body.executed, false);
});

test("la migration crée le login sans secret et sans droit de facturation", async () => {
  const sql = await readFile(new URL("../supabase/migrations/20261107233000_search_job_connect_test.sql", import.meta.url), "utf8");
  const entry = await readFile(new URL("../supabase/functions/search-job-runner/index.ts", import.meta.url), "utf8");
  assert.match(sql, /create role klir_job_connect_test login noinherit nosuperuser nocreatedb nocreaterole nobypassrls/);
  assert.match(sql, /grant klir_job_runner to klir_job_connect_test/);
  assert.match(sql, /grant execute on function private\.diagnose_search_job_connection\(\) to klir_job_runner/);
  assert.doesNotMatch(sql, /password/i);
  assert.doesNotMatch(sql, /jobs_enabled\s*=\s*true/);
  assert.doesNotMatch(sql, /grant execute on function public\.(reserve_usage|settle_usage)/i);
  assert.doesNotMatch(sql, /grant klir_job_api to klir_job_connect_test/);
  assert.match(entry, /KLIR_JOB_DB_PASSWORD/);
  assert.doesNotMatch(entry, /SUPABASE_SERVICE_ROLE_KEY|SUPABASE_DB_URL|local:/);
  const snapshotSql = await readFile(new URL("../supabase/migrations/20261108163000_search_pilot_snapshot.sql", import.meta.url), "utf8");
  assert.match(snapshotSql, /grant execute on function private\.pilot_snapshot\(\) to klir_job_runner/);
  assert.doesNotMatch(snapshotSql, /jobs_enabled\s*=\s*true/);
  assert.doesNotMatch(snapshotSql, /grant execute on function public\.(reserve_usage|settle_usage)/i);
  assert.equal(JSON.stringify(RUNNER_DIAGNOSTIC_SQL).includes("claim_search_jobs"), false);
});
