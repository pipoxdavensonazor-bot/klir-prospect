import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { handleRunnerDiagnostic, assertRunnerDbConfig, authorizedTestJobId, bodyHasExtraKeys, TEST_DB_POOLER_HOSTS, RUNNER_DIAGNOSTIC_SQL, CONNECT_ROLE, PREVIEW_ORIGIN, PILOT_UI_ORIGIN, TARGETED_UI_ORIGIN } from "../supabase/functions/_shared/search-job-runner-edge.mjs";
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
  assert.equal(db.calls.some((text) => text.includes("claim_authorized_test_job")), false);
  assert.equal(JSON.stringify(body).includes(password), false);
});

const targetJob = "44444444-4444-4444-8444-444444444444";

function targetedEnv(extra = {}) {
  return env({ KLIR_ENV: "preview", KLIR_JOB_TEST_JOB_ID: targetJob, KLIR_JOB_DB_HOST: "aws-1-ca-central-1.pooler.supabase.com", ...extra });
}

test("un corps HTTP ne choisit pas le job, et seule une cible serveur de prévisualisation est acceptée", async () => {
  const auth = fakeAuth({ admin: true });
  let connected = 0;
  const neverConnect = async () => { connected += 1; throw new Error("ne_pas_connecter"); };
  for (const key of ["jobId", "job_id", "targetJobId", "target", "id", "job"]) {
    for (const envValue of [env({ KLIR_ENV: "preview" }), targetedEnv(), env({ KLIR_ENV: "production" })]) {
      const refused = await handleRunnerDiagnostic(request("jeton-ada", { action: "cycle", [key]: targetJob }), {
        env: envValue,
        createClient: auth.createClient,
        connect: neverConnect
      });
      assert.equal(refused.status, 400, key);
      assert.equal((await refused.json()).error, "cible_refusee", key);
    }
  }
  // En mode ciblé, toute clé en plus de action est refusée.
  const extra = await handleRunnerDiagnostic(request("jeton-ada", { action: "cycle", options: { jobId: targetJob } }), {
    env: targetedEnv(),
    createClient: auth.createClient,
    connect: neverConnect
  });
  assert.equal(extra.status, 400);
  assert.equal((await extra.json()).error, "cible_refusee");
  assert.equal(connected, 0);
  assert.equal(bodyHasExtraKeys({ action: "cycle" }), false);
  assert.equal(bodyHasExtraKeys({ action: "cycle", x: 1 }), true);
  assert.equal(bodyHasExtraKeys([]), true);

  const db = fakeDb();
  const accepted = await handleRunnerDiagnostic(request("jeton-ada", { action: "cycle" }), {
    env: targetedEnv(),
    createClient: auth.createClient,
    connect: async () => ({ begin: db.postgres().begin, close: async () => {} }),
    provider: { async run() { return { count: 0 }; } }
  });
  assert.equal(accepted.status, 200);
  const acceptedBody = await accepted.json();
  assert.equal(acceptedBody.mode, "cible_test");
  assert.equal(acceptedBody.expired, 0);
  assert.equal(db.calls.some((text) => text.includes("claim_authorized_test_job")), true);
  assert.equal(db.calls.some((text) => text.includes("claim_search_jobs")), false);
  assert.equal(db.calls.some((text) => text.includes("expire_due_search_jobs")), false);
  assert.equal(db.calls.some((text) => text.includes("current_user")), true);
  assert.equal(JSON.stringify(acceptedBody).includes(targetJob), false);
  assert.equal(JSON.stringify(acceptedBody).includes(password), false);
});

test("identité Test stricte : environnement, URL, hôte, utilisateur, port, base", () => {
  assert.equal(authorizedTestJobId(env({ KLIR_ENV: "preview" })), "");
  assert.equal(authorizedTestJobId(env()), "");
  assert.equal(authorizedTestJobId(targetedEnv()), targetJob);
  assert.equal(authorizedTestJobId(targetedEnv({ KLIR_JOB_TEST_JOB_ID: targetJob.toUpperCase() })), targetJob);
  for (const host of TEST_DB_POOLER_HOSTS) assert.equal(authorizedTestJobId(targetedEnv({ KLIR_JOB_DB_HOST: host })), targetJob);
  const cases = [
    [{ KLIR_ENV: "production" }, "environnement_refuse"],
    [{ KLIR_ENV: "" }, "environnement_refuse"],
    [{ KLIR_ENV: "Preview" }, "environnement_refuse"],
    [{ KLIR_ENV: "preview " }, "environnement_refuse"],
    [{ SUPABASE_URL: "https://cbklwmjudobqwbkbxqgy.supabase.co" }, "production_refusee"],
    [{ SUPABASE_URL: "https://autre-projet.supabase.co" }, "hote_non_test"],
    [{ SUPABASE_URL: `https://${TEST_PROJECT_REF}.supabase.co.evil.example` }, "hote_non_test"],
    [{ SUPABASE_URL: `http://${TEST_PROJECT_REF}.supabase.co` }, "hote_non_test"],
    [{ KLIR_JOB_DB_HOST: "aws-0-us-east-1.pooler.supabase.com" }, "hote_test_refuse"],
    [{ KLIR_JOB_DB_HOST: "aws-0-ca-central-1.pooler.supabase.com" }, "hote_test_refuse"],
    [{ KLIR_JOB_DB_HOST: "evil.aws-0-ca-central-1.pooler.supabase.com" }, "hote_test_refuse"],
    [{ KLIR_JOB_DB_HOST: `db.${TEST_PROJECT_REF}.supabase.co` }, "hote_test_refuse"],
    [{ KLIR_JOB_DB_HOST: "db.cbklwmjudobqwbkbxqgy.supabase.co" }, "production_refusee"],
    [{ KLIR_JOB_DB_USER: `postgres.${TEST_PROJECT_REF}` }, "utilisateur_test_refuse"],
    [{ KLIR_JOB_DB_USER: `klir_job_runner.${TEST_PROJECT_REF}` }, "utilisateur_test_refuse"],
    [{ KLIR_JOB_DB_USER: `${CONNECT_ROLE}.autreprojet` }, "utilisateur_test_refuse"],
    [{ KLIR_JOB_DB_USER: `${CONNECT_ROLE}.cbklwmjudobqwbkbxqgy` }, "production_refusee"],
    [{ KLIR_JOB_DB_PORT: "5432" }, "port_non_transaction"],
    [{ KLIR_JOB_DB_NAME: "autre" }, "base_refusee"],
    [{ KLIR_JOB_TEST_JOB_ID: "pas-un-uuid" }, "cible_invalide"],
    [{ KLIR_JOB_TEST_JOB_ID: "00000000-0000-0000-0000-000000000000" }, "cible_invalide"],
    [{ KLIR_JOB_TEST_JOB_ID: `${targetJob},55555555-5555-4555-8555-555555555555` }, "cible_invalide"],
    [{ KLIR_JOB_TEST_JOB_ID: `${targetJob}' or true --` }, "cible_invalide"]
  ];
  for (const [extra, code] of cases) {
    assert.throws(() => authorizedTestJobId(targetedEnv(extra)), (error) => error.code === code, JSON.stringify(extra));
  }
});

test("une cible mal configurée refuse le cycle sans connexion ni repli sur la file globale", async () => {
  const auth = fakeAuth({ admin: true });
  for (const [extra, code] of [
    [{ KLIR_ENV: "production" }, "environnement_refuse"],
    [{ KLIR_JOB_DB_HOST: "aws-0-us-east-1.pooler.supabase.com" }, "hote_test_refuse"],
    [{ KLIR_JOB_TEST_JOB_ID: "pas-un-uuid" }, "cible_invalide"]
  ]) {
    let connected = 0;
    const response = await handleRunnerDiagnostic(request("jeton-ada", { action: "cycle" }), {
      env: targetedEnv(extra),
      createClient: auth.createClient,
      connect: async () => { connected += 1; throw new Error("ne_pas_connecter"); }
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, code);
    assert.equal(connected, 0);
  }
});

test("la fonction Edge transmet KLIR_ENV et KLIR_JOB_TEST_JOB_ID au mode ciblé", async () => {
  const entry = await readFile(new URL("../supabase/functions/search-job-runner/index.ts", import.meta.url), "utf8");
  const names = entry.slice(entry.indexOf("const NAMES"), entry.indexOf("] as const"));
  for (const name of ["KLIR_ENV", "KLIR_JOB_TEST_JOB_ID", "SUPABASE_URL", "KLIR_JOB_DB_HOST", "KLIR_JOB_DB_USER"]) {
    assert.match(names, new RegExp(`"${name}"`), name);
  }
});

test("rôles non autorisés : non-admin, sans jeton, session base inattendue", async () => {
  let connected = 0;
  const connect = async () => { connected += 1; throw new Error("ne_pas_connecter"); };
  const nonAdmin = await handleRunnerDiagnostic(request("jeton-ada", { action: "cycle" }), {
    env: targetedEnv(), createClient: fakeAuth({ admin: false }).createClient, connect
  });
  assert.equal(nonAdmin.status, 403);
  const anonymous = await handleRunnerDiagnostic(request("", { action: "cycle" }), {
    env: targetedEnv(), createClient: fakeAuth({ admin: true }).createClient, connect
  });
  assert.equal(anonymous.status, 401);
  const invalid = await handleRunnerDiagnostic(request("jeton-ada", { action: "cycle" }), {
    env: targetedEnv(), createClient: fakeAuth({ admin: true, user: null }).createClient, connect
  });
  assert.equal(invalid.status, 401);
  assert.equal(connected, 0);

  // La base répond avec une autre identité : rien n'est réclamé.
  const calls = [];
  const tx = {
    async unsafe(text) {
      calls.push(text);
      if (text.includes("current_user")) return [{ role_name: "postgres", session_name: "postgres" }];
      return [];
    }
  };
  const wrong = await handleRunnerDiagnostic(request("jeton-ada", { action: "cycle" }), {
    env: targetedEnv(),
    createClient: fakeAuth({ admin: true }).createClient,
    connect: async () => ({ begin: (fn) => fn(tx), close: async () => {} }),
    provider: { async run() { throw new Error("ne_pas_executer"); } }
  });
  assert.equal(wrong.status, 503);
  assert.equal((await wrong.json()).error, "role_exploitation_refuse");
  assert.equal(calls.some((text) => text.includes("claim_")), false);
  assert.equal(calls.some((text) => text.includes("expire_due_search_jobs")), false);
});

test("non-régression : sans cible, le cycle de production garde expiration puis file globale", async () => {
  for (const extra of [{}, { KLIR_ENV: "production" }, { KLIR_ENV: "preview" }]) {
    const db = fakeDb();
    const response = await handleRunnerDiagnostic(request("jeton-ada", { action: "cycle" }), {
      env: env(extra),
      createClient: fakeAuth({ admin: true }).createClient,
      connect: async () => ({ begin: db.postgres().begin, close: async () => {} }),
      provider: { async run() { return { count: 0 }; } }
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.mode, undefined);
    const expireAt = db.calls.findIndex((text) => text.includes("expire_due_search_jobs"));
    const claimAt = db.calls.findIndex((text) => text.includes("claim_search_jobs(1)"));
    assert.equal(expireAt >= 0 && claimAt > expireAt, true);
    assert.equal(db.calls.some((text) => text.includes("claim_authorized_test_job")), false);
    // Pas de contrôle d'identité ajouté au cycle normal.
    assert.equal(db.calls.some((text) => text.includes("current_user")), false);
  }
});

test("l'aperçu de la branche du cycle ciblé passe la prévérification, pas la production", async () => {
  const allowed = await handleRunnerDiagnostic(new Request("http://127.0.0.1/search-job-runner", { method: "OPTIONS", headers: { origin: TARGETED_UI_ORIGIN } }), { env: env() });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), TARGETED_UI_ORIGIN);
  const prod = await handleRunnerDiagnostic(new Request("http://127.0.0.1/search-job-runner", { method: "OPTIONS", headers: { origin: "https://klirprospect.klirline.ca" } }), { env: env() });
  assert.equal(prod.status, 403);
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
  const catalogSql = await readFile(new URL("../supabase/migrations/20261113120000_search_catalog_places.sql", import.meta.url), "utf8");
  assert.match(catalogSql, /grant execute on function private\.search_catalog_lookup\(text, text, integer\) to klir_job_runner/);
  assert.match(catalogSql, /force row level security/);
  assert.doesNotMatch(catalogSql, /jobs_enabled\s*=\s*true/);
  assert.doesNotMatch(catalogSql, /grant execute on function public\.(reserve_usage|settle_usage)/i);
  const placesSql = await readFile(new URL("../supabase/migrations/20261108170000_search_job_places.sql", import.meta.url), "utf8");
  assert.match(placesSql, /grant select on table public\.search_job_places to authenticated/);
  assert.match(placesSql, /grant execute on function private\.record_search_places\(uuid, jsonb\) to klir_job_runner/);
  assert.doesNotMatch(placesSql, /grant insert|grant update|grant delete|jobs_enabled\s*=\s*true/i);
  assert.equal(JSON.stringify(RUNNER_DIAGNOSTIC_SQL).includes("claim_search_jobs"), false);
});
