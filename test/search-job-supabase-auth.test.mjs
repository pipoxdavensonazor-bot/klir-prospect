import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { createGetUserVerifier } from "../supabase/functions/_shared/search-job-auth.mjs";
import { assertLocalAuthTarget, createSupabaseGetUser } from "../supabase/functions/_shared/search-job-supabase-auth.mjs";

const ada = "11111111-1111-4111-8111-111111111111";
const ced = "33333333-3333-4333-8333-333333333333";
const key = "sb_publishable_local_runtime";
const socket = "/var/run/postgresql";

function forgedJwt(sub) {
  const body = Buffer.from(JSON.stringify({ sub, role: "authenticated" })).toString("base64url");
  return `eyJhbGciOiJub25lIn0.${body}.signature`;
}

function startAuthStub() {
  const users = new Map([
    ["jeton-ada", { id: ada }],
    ["jeton-ced", { id: ced }]
  ]);
  const seen = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    seen.push({
      method: req.method,
      path: url.pathname,
      apikey: req.headers.apikey || "",
      authorization: req.headers.authorization || ""
    });
    if (req.method !== "GET" || url.pathname !== "/auth/v1/user") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "not_found" }));
      return;
    }
    const token = String(req.headers.authorization || "").replace(/^Bearer /, "");
    const user = users.get(token);
    if (!user || req.headers.apikey !== key) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "invalid", error: "invalid_token" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: user.id, aud: "authenticated", role: "authenticated" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        origin: `http://127.0.0.1:${port}`,
        seen,
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

test("le client supabase-js getUser interroge le service local et ne décode pas le jeton", async () => {
  const stub = await startAuthStub();
  try {
    const getUser = createSupabaseGetUser({ url: stub.origin, key });
    const verify = createGetUserVerifier(getUser);
    const user = await verify("jeton-ada");
    assert.equal(user.id, ada);
    const other = await verify("jeton-ced");
    assert.equal(other.id, ced);
    const forged = await verify(forgedJwt(ada));
    assert.equal(forged, null);
    const calls = stub.seen.filter((call) => call.path === "/auth/v1/user");
    assert.equal(calls.length, 3);
    assert.equal(stub.seen.every((call) => call.path === "/auth/v1/user"), true);
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].apikey, key);
    assert.equal(calls[0].authorization, "Bearer jeton-ada");
    assert.equal(calls[2].authorization, `Bearer ${forgedJwt(ada)}`);
    const source = await readFile(new URL("../supabase/functions/_shared/search-job-supabase-auth.mjs", import.meta.url), "utf8");
    assert.match(source, /auth\.getUser\(jwt\)/);
    assert.doesNotMatch(source, /jwt\.decode|atob\(|JSON\.parse\(Buffer/);
    const entry = await readFile(new URL("../supabase/functions/search-jobs/index.ts", import.meta.url), "utf8");
    assert.match(entry, /handleSearchJobRequest/);
    assert.match(entry, /createClient/);
    assert.doesNotMatch(entry, /verifyJwt: async \(\) => null|local:|SUPABASE_SERVICE_ROLE_KEY|atob\(/);
  } finally {
    await stub.close();
  }
});

test("un projet distant, une clé secrète ou un hôte public sont refusés avant tout appel", async () => {
  let called = false;
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("appel_interdit");
  };
  try {
    assert.throws(() => assertLocalAuthTarget("https://pwakjxjjxswdjsapsbxn.supabase.co", key), /projet_distant_refuse/);
    assert.throws(() => assertLocalAuthTarget("https://cbklwmjudobqwbkbxqgy.supabase.co", key), /projet_distant_refuse/);
    assert.throws(() => assertLocalAuthTarget("http://127.0.0.1:9", "sb_secret_local_runtime"), /cle_secrete_refusee/);
    assert.throws(() => assertLocalAuthTarget("http://127.0.0.1:9", "sb_publishable_local_service_role"), /cle_secrete_refusee/);
    assert.throws(() => assertLocalAuthTarget("http://127.0.0.1:9", "eyJhbGciOiJub25lIn0.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.x"), /cle_locale_requise/);
    assert.throws(() => assertLocalAuthTarget("http://example.test", key), /hote_non_local/);
    assert.throws(() => createSupabaseGetUser({ url: "https://pwakjxjjxswdjsapsbxn.supabase.co", key }), /projet_distant_refuse/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("l'entrée locale avec getUser réel isole, reprend et n'effectue qu'un mouvement", { timeout: 60_000 }, async (t) => {
  const admin = new Client({ host: socket, database: "postgres" });
  try {
    await admin.connect();
  } catch (error) {
    t.skip(`PostgreSQL local indisponible (${error.code || "connexion"}). Le parcours getUser vers la file n'a pas été exécuté. Le test du client getUser, lui, a tourné.`);
    return;
  }
  const who = await admin.query("select rolsuper from pg_roles where rolname = current_user");
  if (who.rows[0].rolsuper !== true) {
    await admin.end();
    t.skip("Rôle propriétaire du socket absent. Le parcours getUser vers la file n'a pas été exécuté.");
    return;
  }
  const name = `klir_au_${process.pid.toString(16).slice(0, 6)}`;
  const stub = await startAuthStub();
  let db = null;
  let runtime = null;
  await admin.query(`create database ${name}`);
  try {
    const applied = await runNode("tools/search-job-local-db.mjs", {
      SEARCH_JOBS_DB_HOST: socket,
      SEARCH_JOBS_DB_NAME: name
    });
    assert.match(applied.stdout, /jobs_enabled=false/);
    db = new Client({ host: socket, database: name });
    await db.connect();
    await db.query(`
      insert into auth.users (id, email) values
        ('${ada}', 'ada@example.invalid'),
        ('${ced}', 'ced@example.invalid')
    `);
    await db.query("update private.search_job_settings set jobs_enabled = true");
    runtime = await startRuntime(name, stub.origin);
    const health = await call(runtime.port, "GET", "/healthz");
    assert.equal(health.body.auth, "supabase-getUser");
    assert.equal(health.body.api.role, "klir_job_api");
    assert.equal(health.body.runner.role, "klir_job_runner");
    assert.equal(health.body.api.superuser, false);

    const missing = await call(runtime.port, "POST", "/search-jobs", {
      token: forgedJwt(ada),
      body: enqueue("auth-ada-retry", { simulateFailures: 1, simulateCount: 2 })
    });
    assert.equal(missing.status, 401);
    assert.equal((await account(db, ada)).balance, 200);

    const created = await call(runtime.port, "POST", "/search-jobs", {
      token: "jeton-ada",
      body: enqueue("auth-ada-retry", { simulateFailures: 1, simulateCount: 2 })
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.created, true);
    assert.equal(created.body.balance, 194);
    const replay = await call(runtime.port, "POST", "/search-jobs", {
      token: "jeton-ada",
      body: enqueue("auth-ada-retry", { simulateFailures: 1, simulateCount: 2 })
    });
    assert.equal(replay.body.created, false);
    assert.equal((await account(db, ada)).balance, 194);

    const hidden = await call(runtime.port, "GET", `/search-jobs?id=${created.body.id}`, { token: "jeton-ced" });
    assert.equal(hidden.status, 404);
    const foreign = await call(runtime.port, "POST", "/search-jobs", {
      token: "jeton-ced",
      body: { action: "cancel", jobId: created.body.id }
    });
    assert.equal(foreign.status, 404);

    const retry = await call(runtime.port, "POST", "/internal/step");
    assert.equal(retry.body.results[0].status, "retry");
    assert.equal((await account(db, ada)).searches_used, 0);
    const settled = await call(runtime.port, "POST", "/internal/step");
    assert.equal(settled.body.results[0].status, "succeeded");
    assert.equal((await account(db, ada)).balance, 194);
    assert.equal((await account(db, ada)).searches_used, 1);
    const again = await call(runtime.port, "POST", "/internal/step");
    assert.equal(again.body.results.length, 0);
    assert.equal((await account(db, ada)).searches_used, 1);

    const cancelJob = await call(runtime.port, "POST", "/search-jobs", {
      token: "jeton-ada",
      body: enqueue("auth-ada-cancel", { simulateCount: 1 })
    });
    assert.equal((await account(db, ada)).balance, 188);
    const cancelled = await call(runtime.port, "POST", "/search-jobs", {
      token: "jeton-ada",
      body: { action: "cancel", jobId: cancelJob.body.id }
    });
    assert.equal(cancelled.body.status, "cancelled");
    assert.equal(cancelled.body.ledger_status, "released");
    assert.equal((await account(db, ada)).balance, 194);
    assert.equal((await account(db, ada)).searches_used, 1);
    const negative = await db.query("select count(*)::int as n from public.credit_accounts where balance < 0");
    assert.equal(negative.rows[0].n, 0);
  } finally {
    if (runtime) await stopProcess(runtime);
    if (db) await db.end();
    await stub.close();
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  }
});

function enqueue(idempotencyKey, extra) {
  return {
    action: "enqueue",
    idempotencyKey,
    payload: { place_status: "supported", cityKey: "laval", quantity: 10, ...extra }
  };
}

async function account(db, id) {
  const row = await db.query("select balance, searches_used from public.credit_accounts where user_id = $1", [id]);
  return row.rows[0];
}

function runNode(script, env) {
  const child = spawn(process.execPath, [script], {
    env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  return collect(child);
}

async function startRuntime(database, authUrl) {
  const child = spawn(process.execPath, ["tools/search-job-runtime.mjs"], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      USER: process.env.USER,
      SEARCH_JOBS_LOCAL: "1",
      SEARCH_JOBS_AUTH: "supabase",
      SEARCH_JOBS_AUTH_URL: authUrl,
      SEARCH_JOBS_AUTH_KEY: key,
      SEARCH_JOBS_DB_HOST: socket,
      SEARCH_JOBS_DB_NAME: database,
      SEARCH_JOBS_DB_USER: "klir_job_connect",
      SEARCH_JOBS_PORT: "0",
      SEARCH_JOBS_WORKER: "manual"
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
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
  });
  return { child, port };
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
  if (runtime.child.exitCode !== null) return;
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
