import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { splitSql } from "../tools/search-job-local-db.mjs";
import { assertRuntimeConfig } from "../tools/search-job-runtime.mjs";

const ada = "11111111-1111-4111-8111-111111111111";
const ced = "33333333-3333-4333-8333-333333333333";
const bea = "22222222-2222-4222-8222-222222222222";
const socket = "/var/run/postgresql";

test("le contrat local refuse un secret, un hôte distant et le rôle propriétaire", () => {
  assert.throws(() => assertRuntimeConfig({ SEARCH_JOBS_LOCAL: "0" }), /jobs_v2_desactive/);
  assert.throws(() => assertRuntimeConfig({
    SEARCH_JOBS_LOCAL: "1",
    SEARCH_JOBS_DB_PASSWORD: "absent",
    SEARCH_JOBS_DB_USER: "klir_job_connect",
    SEARCH_JOBS_DB_NAME: "klir_jobs_local"
  }), /secret_refuse/);
  assert.throws(() => assertRuntimeConfig({
    SEARCH_JOBS_LOCAL: "1",
    SEARCH_JOBS_DB_HOST: "db.exemple.supabase.co",
    SEARCH_JOBS_DB_USER: "klir_job_connect",
    SEARCH_JOBS_DB_NAME: "klir_jobs_local"
  }), /socket_local_requis/);
  assert.throws(() => assertRuntimeConfig({
    SEARCH_JOBS_LOCAL: "1",
    SEARCH_JOBS_DB_USER: "postgres",
    SEARCH_JOBS_DB_NAME: "klir_jobs_local"
  }), /role_connexion_refuse/);
  const accepted = assertRuntimeConfig({
    SEARCH_JOBS_LOCAL: "1",
    SEARCH_JOBS_DB_USER: "klir_job_connect",
    SEARCH_JOBS_DB_NAME: "klir_jobs_local",
    SEARCH_JOBS_WORKER: "manual",
    SEARCH_JOBS_PORT: "0"
  });
  assert.equal(accepted.user, "klir_job_connect");
  assert.equal(accepted.worker, "manual");
  assert.equal(accepted.port, 0);
});

test("la migration du rôle ne crée pas de connexion et le script local sépare les fonctions", async () => {
  const migration = await readFile(new URL("../supabase/migrations/20261107220000_search_job_runner_role.sql", import.meta.url), "utf8");
  const runtime = await readFile(new URL("../tools/search-job-runtime.mjs", import.meta.url), "utf8");
  const worker = await readFile(new URL("../supabase/functions/_shared/search-job-worker.mjs", import.meta.url), "utf8");
  const entry = await readFile(new URL("../supabase/functions/search-jobs/index.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(migration, /create role klir_job_runner nologin noinherit/);
  assert.match(migration, /create role klir_job_api nologin noinherit/);
  assert.doesNotMatch(migration, /\blogin\b/i);
  assert.doesNotMatch(migration, /password/i);
  assert.doesNotMatch(migration, /jobs_enabled\s*=\s*true/);
  assert.match(migration, /grant execute on function private\.reconcile_search_job\(uuid\) to klir_job_runner/);
  assert.match(migration, /revoke all on function private\.apply_usage_outcome\(uuid, text, text\) from klir_job_api, klir_job_runner/);
  const visibleRuntime = runtime
    .replaceAll("SEARCH_JOBS_DB_PASSWORD", "")
    .replaceAll("PGPASSWORD", "")
    .replaceAll("SUPABASE_SERVICE_ROLE_KEY", "");
  assert.doesNotMatch(visibleRuntime, /password|service_role|overpass|nominatim/i);
  assert.doesNotMatch(visibleRuntime, /jobs_enabled\s*=\s*true/);
  assert.doesNotMatch(runtime, /fetch\s*\(/);
  assert.doesNotMatch(worker, /fetch\s*\(/);
  assert.match(entry, /jobsEnabled: async \(\) => false/);
  assert.match(entry, /verifyJwt: async \(\) => null/);
  assert.doesNotMatch(app, /search-jobs/);
  const parts = splitSql("select 1; create function f() returns int as $$ begin return 1; end $$ language plpgsql;");
  assert.equal(parts.length, 2);
  assert.match(parts[1], /return 1;/);
});

test("PostgreSQL local, deux connexions : HTTP, file, collecte, grand livre", { timeout: 60_000 }, async (t) => {
  const admin = new Client({ host: socket, database: "postgres" });
  const name = `klir_rt_${process.pid.toString(16).slice(0, 6)}`;
  let db = null;
  let manual = null;
  let automatic = null;
  const runners = [];
  try {
    await admin.connect();
  } catch (error) {
    t.skip(`PostgreSQL local indisponible (${error.code || "connexion"}). Le test multi-connexion n'a pas été exécuté. Commande : SEARCH_JOBS_DB_NAME=klir_jobs_local node tools/search-job-local-db.mjs`);
    return;
  }
  const who = await admin.query("select current_user as role_name, rolsuper from pg_roles where rolname = current_user");
  if (who.rows[0].rolsuper !== true) {
    await admin.end();
    t.skip("Le rôle du socket local n'est pas propriétaire. Le test multi-connexion n'a pas été exécuté. Préparer une fois : sudo -u postgres createuser --superuser \"$USER\", puis dans pg_hba.conf la ligne « local all klir_job_connect trust » et recharger.");
    return;
  }
  await admin.query(`create database ${name}`);
  try {
    const applied = await runNode("tools/search-job-local-db.mjs", {
      SEARCH_JOBS_DB_HOST: socket,
      SEARCH_JOBS_DB_NAME: name
    });
    assert.match(applied.stdout, /schema_local_applique jobs_enabled=false/);
    db = new Client({ host: socket, database: name });
    await db.connect();
    const flag = await db.query("select jobs_enabled from private.search_job_settings");
    assert.equal(flag.rows[0].jobs_enabled, false, "le script local laisse le drapeau éteint");
    await db.query(`
      insert into auth.users (id, email) values
        ('${ada}', 'ada@example.invalid'),
        ('${ced}', 'ced@example.invalid'),
        ('${bea}', 'contact@klirline.ca')
    `);
    await db.query(`insert into private.admins (user_id) values ('${bea}') on conflict (user_id) do nothing`);
    assert.equal((await account(db, ada)).balance, 200);

    manual = await startRuntime(name, "manual");
    const health = await call(manual.port, "GET", "/healthz");
    assert.equal(health.status, 200);
    assert.equal(health.body.api.role, "klir_job_api");
    assert.equal(health.body.runner.role, "klir_job_runner");
    assert.equal(health.body.api.session, "klir_job_connect");
    assert.equal(health.body.api.superuser, false);
    assert.equal(health.body.runner.superuser, false);

    const blocked = await call(manual.port, "POST", "/search-jobs", {
      token: `local:${ada}`,
      body: enqueueBody("runtime-ada-retry", { simulateFailures: 1, simulateCount: 2 })
    });
    assert.equal(blocked.status, 403, "drapeau éteint");
    assert.equal(blocked.body.error, "jobs_disabled");
    assert.equal((await account(db, ada)).balance, 200);

    await db.query("update private.search_job_settings set jobs_enabled = true, rate_limit_per_minute = 30");
    const anonymous = await call(manual.port, "POST", "/search-jobs", {
      body: enqueueBody("runtime-ada-retry", { simulateFailures: 1, simulateCount: 2 })
    });
    assert.equal(anonymous.status, 401);
    const forged = await call(manual.port, "POST", "/search-jobs", {
      token: "local:pas-un-uuid",
      body: enqueueBody("runtime-ada-retry")
    });
    assert.equal(forged.status, 401);

    const created = await call(manual.port, "POST", "/search-jobs", {
      token: `local:${ada}`,
      body: enqueueBody("runtime-ada-retry", { simulateFailures: 1, simulateCount: 2 })
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.created, true);
    assert.equal(created.body.ledger_status, "open");
    assert.equal(created.body.balance, 194);
    const replay = await call(manual.port, "POST", "/search-jobs", {
      token: `local:${ada}`,
      body: enqueueBody("runtime-ada-retry", { simulateFailures: 1, simulateCount: 2 })
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.created, false);
    assert.equal(replay.body.id, created.body.id);
    assert.equal((await account(db, ada)).balance, 194);
    assert.equal((await account(db, ada)).searches_used, 0);

    const hiddenCed = await call(manual.port, "GET", `/search-jobs?id=${created.body.id}`, { token: `local:${ced}` });
    const hiddenAdmin = await call(manual.port, "GET", `/search-jobs?id=${created.body.id}`, { token: `local:${bea}` });
    assert.equal(hiddenCed.status, 404);
    assert.equal(hiddenAdmin.status, 404);
    const foreignCancel = await call(manual.port, "POST", "/search-jobs", {
      token: `local:${ced}`,
      body: { action: "cancel", jobId: created.body.id }
    });
    assert.equal(foreignCancel.status, 404);
    assert.equal((await account(db, ada)).balance, 194);

    const firstStep = await call(manual.port, "POST", "/internal/step");
    assert.equal(firstStep.status, 200);
    assert.equal(firstStep.body.results.length, 1);
    assert.equal(firstStep.body.results[0].status, "retry");
    assert.equal(firstStep.body.results[0].attempt, 1);
    assert.equal((await account(db, ada)).balance, 194);
    assert.equal((await account(db, ada)).searches_used, 0);
    const secondStep = await call(manual.port, "POST", "/internal/step");
    assert.equal(secondStep.body.results[0].status, "succeeded");
    assert.equal(secondStep.body.results[0].ledger_status, "complete");
    assert.equal((await account(db, ada)).balance, 194);
    assert.equal((await account(db, ada)).searches_used, 1);
    const thirdStep = await call(manual.port, "POST", "/internal/step");
    assert.equal(thirdStep.body.results.length, 0);
    assert.equal((await account(db, ada)).searches_used, 1);

    const cedJob = await call(manual.port, "POST", "/search-jobs", {
      token: `local:${ced}`,
      body: enqueueBody("runtime-ced-0001", { simulateCount: 1 })
    });
    assert.equal(cedJob.body.created, true);
    assert.equal((await account(db, ced)).balance, 194);
    assert.equal((await account(db, ada)).balance, 194);
    const cedCancel = await call(manual.port, "POST", "/search-jobs", {
      token: `local:${ced}`,
      body: { action: "cancel", jobId: cedJob.body.id }
    });
    assert.equal(cedCancel.body.status, "cancelled");
    assert.equal(cedCancel.body.ledger_status, "released");
    assert.equal((await account(db, ced)).balance, 200);
    assert.equal((await account(db, ced)).searches_used, 0);

    const toCancel = await call(manual.port, "POST", "/search-jobs", {
      token: `local:${ada}`,
      body: enqueueBody("runtime-ada-cancel", { simulateCount: 1 })
    });
    assert.equal((await account(db, ada)).balance, 188);
    const cancelled = await call(manual.port, "POST", "/search-jobs", {
      token: `local:${ada}`,
      body: { action: "cancel", jobId: toCancel.body.id }
    });
    assert.equal(cancelled.body.status, "cancelled");
    assert.equal((await account(db, ada)).balance, 194);
    const afterCancel = await call(manual.port, "POST", "/internal/step");
    assert.equal(afterCancel.body.results.length, 0);
    assert.equal((await account(db, ada)).balance, 194);

    const crash = await call(manual.port, "POST", "/search-jobs", {
      token: `local:${ada}`,
      body: enqueueBody("runtime-ada-crash", { simulateCount: 3 })
    });
    assert.equal((await account(db, ada)).balance, 188);
    const direct = await connectRunner(name);
    runners.push(direct);
    const claimed = await direct.query("select private.claim_search_jobs(1) as row");
    const claimedJobs = asJobs(claimed.rows[0].row);
    assert.equal(claimedJobs.length, 1);
    assert.equal(claimedJobs[0].id, crash.body.id);
    await direct.query("select private.record_search_collection($1::uuid, 'complete', 3)", [crash.body.id]);
    assert.equal((await account(db, ada)).searches_used, 1, "collecte enregistrée, pas encore réglée");
    await db.query("update public.search_jobs set payload = payload || '{\"simulateFailures\": 9}'::jsonb where id = $1", [crash.body.id]);
    const resumed = await call(manual.port, "POST", "/internal/step");
    assert.equal(resumed.body.results.length, 1);
    assert.equal(resumed.body.results[0].status, "succeeded");
    assert.equal((await account(db, ada)).balance, 188);
    assert.equal((await account(db, ada)).searches_used, 2);
    const resumedAgain = await call(manual.port, "POST", "/internal/step");
    assert.equal(resumedAgain.body.results.length, 0);
    assert.equal((await account(db, ada)).searches_used, 2);

    const locked = await call(manual.port, "POST", "/search-jobs", {
      token: `local:${ada}`,
      body: enqueueBody("runtime-ada-double", { simulateCount: 1 })
    });
    assert.equal((await account(db, ada)).balance, 182);
    const left = await connectRunner(name);
    const right = await connectRunner(name);
    runners.push(left, right);
    const [leftClaim, rightClaim] = await Promise.all([
      left.query("select private.claim_search_jobs(1) as row"),
      right.query("select private.claim_search_jobs(1) as row")
    ]);
    const delivered = asJobs(leftClaim.rows[0].row).concat(asJobs(rightClaim.rows[0].row));
    assert.equal(delivered.length, 1, "une seule connexion reçoit le job");
    assert.equal(delivered[0].id, locked.body.id);
    const released = await call(manual.port, "POST", "/search-jobs", {
      token: `local:${ada}`,
      body: { action: "cancel", jobId: locked.body.id }
    });
    assert.equal(released.body.status, "cancelled");
    assert.equal((await account(db, ada)).balance, 188);
    assert.equal((await account(db, ada)).searches_used, 2);

    const expired = await call(manual.port, "POST", "/search-jobs", {
      token: `local:${ada}`,
      body: enqueueBody("runtime-ada-expire", { simulateCount: 1 })
    });
    assert.equal((await account(db, ada)).balance, 182);
    await db.query("update public.search_jobs set reserved_until = now() - interval '1 minute' where id = $1", [expired.body.id]);
    const holder = await connectRunner(name);
    const waiter = await connectRunner(name);
    runners.push(holder, waiter);
    await holder.query("begin");
    await holder.query("select private.reconcile_search_job($1::uuid)", [expired.body.id]);
    const expireWait = waiter.query("select private.record_search_collection($1::uuid, 'complete', 1)", [expired.body.id]);
    const expireBlocked = await assertBlocked(expireWait);
    await holder.query("commit");
    await assert.rejects(expireBlocked.promise, /job_clos/);
    assert.equal((await account(db, ada)).balance, 188);
    assert.equal((await account(db, ada)).searches_used, 2);

    const race = await call(manual.port, "POST", "/search-jobs", {
      token: `local:${ada}`,
      body: enqueueBody("runtime-ada-race", { simulateCount: 1 })
    });
    assert.equal((await account(db, ada)).balance, 182);
    const settler = await connectRunner(name);
    const contender = await connectRunner(name);
    runners.push(settler, contender);
    await settler.query("begin");
    const raceClaim = await settler.query("select private.claim_search_jobs(1) as row");
    assert.equal(asJobs(raceClaim.rows[0].row)[0].id, race.body.id);
    const raceWait = contender.query("select private.record_search_collection($1::uuid, 'complete', 1) as row", [race.body.id]);
    const raceBlocked = await assertBlocked(raceWait);
    await settler.query("select private.record_search_collection($1::uuid, 'complete', 1)", [race.body.id]);
    await settler.query("select private.reconcile_search_job($1::uuid)", [race.body.id]);
    await settler.query("commit");
    const raceRow = await raceBlocked.promise;
    assert.equal(raceRow.rows[0].row.recorded, false);
    const raceReplay = await contender.query("select private.reconcile_search_job($1::uuid) as row", [race.body.id]);
    assert.equal(raceReplay.rows[0].row.replayed, true);
    assert.equal((await account(db, ada)).balance, 182);
    assert.equal((await account(db, ada)).searches_used, 3);

    const inflight = await call(manual.port, "POST", "/search-jobs", {
      token: `local:${ada}`,
      body: enqueueBody("runtime-ada-inflight", { simulateCount: 1 })
    });
    assert.equal((await account(db, ada)).balance, 176);
    const keeper = await connectRunner(name);
    runners.push(keeper);
    await keeper.query("begin");
    const inflightClaim = await keeper.query("select private.claim_search_jobs(1) as row");
    assert.equal(asJobs(inflightClaim.rows[0].row)[0].id, inflight.body.id);
    const cancelWait = call(manual.port, "POST", "/search-jobs", {
      token: `local:${ada}`,
      body: { action: "cancel", jobId: inflight.body.id }
    });
    const cancelBlocked = await assertBlocked(cancelWait);
    await keeper.query("select private.record_search_collection($1::uuid, 'complete', 1)", [inflight.body.id]);
    await keeper.query("select private.reconcile_search_job($1::uuid)", [inflight.body.id]);
    await keeper.query("commit");
    const cancelResponse = await cancelBlocked.promise;
    assert.equal(cancelResponse.status, 200);
    assert.equal(cancelResponse.body.status, "succeeded");
    assert.equal(cancelResponse.body.ledger_status, "complete");
    assert.equal((await account(db, ada)).balance, 176);
    assert.equal((await account(db, ada)).searches_used, 4);

    await stopProcess(manual);
    manual = null;
    automatic = await startRuntime(name, "auto");
    const looped = await call(automatic.port, "POST", "/search-jobs", {
      token: `local:${ada}`,
      body: enqueueBody("runtime-ada-loop", { simulateCount: 1 })
    });
    assert.equal(looped.body.created, true);
    let loopedJob = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const read = await call(automatic.port, "GET", `/search-jobs?id=${looped.body.id}`, { token: `local:${ada}` });
      if (read.status === 200 && read.body.status === "succeeded") {
        loopedJob = read.body;
        break;
      }
      await delay(100);
    }
    assert.ok(loopedJob, "la boucle locale règle le job sans appel manuel");
    assert.equal((await account(db, ada)).balance, 170);
    assert.equal((await account(db, ada)).searches_used, 5);
    assert.equal((await account(db, ced)).balance, 200);

    const openHolds = await db.query("select count(*)::int as n from public.usage_holds where status = 'open'");
    const negative = await db.query("select count(*)::int as n from public.credit_accounts where balance < 0");
    assert.equal(openHolds.rows[0].n, 0);
    assert.equal(negative.rows[0].n, 0);

    const privileges = await db.query(`
      select
        has_function_privilege('klir_job_runner', 'private.reconcile_search_job(uuid)', 'execute') as runner_reconcile,
        has_function_privilege('klir_job_api', 'private.reconcile_search_job(uuid)', 'execute') as api_reconcile,
        has_function_privilege('authenticated', 'private.reconcile_search_job(uuid)', 'execute') as client_reconcile,
        has_function_privilege('anon', 'private.claim_search_jobs(integer)', 'execute') as anon_claim,
        has_function_privilege('public', 'private.record_search_collection(uuid, text, integer)', 'execute') as public_record,
        has_function_privilege('klir_job_runner', 'private.apply_usage_outcome(uuid, text, text)', 'execute') as runner_money,
        has_function_privilege('klir_job_api', 'public.enqueue_search_job(text, jsonb)', 'execute') as api_enqueue,
        has_function_privilege('klir_job_runner', 'public.settle_usage(text, text)', 'execute') as runner_settle,
        has_function_privilege('klir_job_connect', 'public.enqueue_search_job(text, jsonb)', 'execute') as connect_enqueue
    `);
    const grant = privileges.rows[0];
    assert.equal(grant.runner_reconcile, true);
    assert.equal(grant.api_reconcile, false);
    assert.equal(grant.client_reconcile, false);
    assert.equal(grant.anon_claim, false);
    assert.equal(grant.public_record, false);
    assert.equal(grant.runner_money, false);
    assert.equal(grant.api_enqueue, true);
    assert.equal(grant.runner_settle, false);
    assert.equal(grant.connect_enqueue, false);

    await assert.rejects(
      asRole(db, "klir_job_runner", () => db.query("update public.credit_accounts set balance = 0")),
      /permission denied/i
    );
    await assert.rejects(
      asRole(db, "klir_job_api", () => db.query("select private.reconcile_search_job($1::uuid)", [created.body.id])),
      /permission denied/i
    );
    await assert.rejects(
      asRole(db, "klir_job_runner", () => db.query("select * from private.admins")),
      /permission denied/i
    );
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [bea]);
    const adminView = await asRole(db, "authenticated", async () => {
      const identity = await db.query("select public.is_admin() as admin");
      const jobs = await db.query("select id from public.search_jobs");
      return { admin: identity.rows[0].admin, jobs: jobs.rows.length };
    });
    assert.equal(adminView.admin, true);
    assert.equal(adminView.jobs, 0);
    await db.query("select set_config('request.jwt.claim.sub', '', false)");
  } finally {
    if (manual) await stopProcess(manual);
    if (automatic) await stopProcess(automatic);
    for (const runner of runners) {
      try { await runner.query("rollback"); } catch { /* pas de transaction */ }
      try { await runner.end(); } catch { /* déjà fermé */ }
    }
    if (db) await db.end();
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  }
});

function enqueueBody(key, extra = {}) {
  return {
    action: "enqueue",
    idempotencyKey: key,
    payload: { place_status: "supported", cityKey: "laval", quantity: 10, ...extra }
  };
}

function asJobs(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return JSON.parse(value);
  return [];
}

async function account(db, id) {
  const row = await db.query("select balance, searches_used from public.credit_accounts where user_id = $1", [id]);
  return row.rows[0];
}

async function asRole(db, role, fn) {
  await db.query(`set role ${role}`);
  try {
    return await fn();
  } finally {
    await db.query("reset role");
  }
}

async function connectRunner(database) {
  const client = new Client({ host: socket, database, user: "klir_job_connect" });
  await client.connect();
  await client.query("set role klir_job_runner");
  await client.query("set lock_timeout = '5s'");
  return client;
}

async function assertBlocked(promise) {
  let settled = false;
  const tracked = promise.finally(() => { settled = true; });
  await delay(300);
  if (settled) {
    await tracked.catch(() => {});
    throw new Error("la seconde connexion n'a pas attendu le verrou");
  }
  return { promise: tracked };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runNode(script, env) {
  const child = spawn(process.execPath, [script], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  return collect(child);
}

async function startRuntime(database, worker) {
  const child = spawn(process.execPath, ["tools/search-job-runtime.mjs"], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      SEARCH_JOBS_LOCAL: "1",
      SEARCH_JOBS_DB_HOST: socket,
      SEARCH_JOBS_DB_NAME: database,
      SEARCH_JOBS_DB_USER: "klir_job_connect",
      SEARCH_JOBS_PORT: "0",
      SEARCH_JOBS_WORKER: worker
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`runtime muet ${stderr}`)), 8000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`runtime arrêté ${code} ${stderr}`));
    });
    child.stdout.on("data", () => {
      const match = /listening 127\.0\.0\.1 (\d+)/.exec(stdout);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
  });
  return { child, port, stderr: () => stderr };
}

function collect(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`commande ${code} ${stderr || stdout}`));
    });
  });
}

async function stopProcess(runtime) {
  if (!runtime || runtime.child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      runtime.child.kill("SIGKILL");
      resolve();
    }, 2000);
    runtime.child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    runtime.child.kill("SIGTERM");
  });
}

async function call(port, method, path, { token, body } = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
