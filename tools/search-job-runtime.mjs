import http from "node:http";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { pathToFileURL } from "node:url";
import { createGetUserVerifier } from "../supabase/functions/_shared/search-job-auth.mjs";
import { assertLocalAuthTarget, createSupabaseGetUser } from "../supabase/functions/_shared/search-job-supabase-auth.mjs";
import { handleSearchJob } from "../supabase/functions/_shared/search-job-http.mjs";
import { createSearchJobStore } from "../supabase/functions/_shared/search-job-store.mjs";
import { createLocalSimulatedProvider, runWorkerCycle } from "../supabase/functions/_shared/search-job-worker.mjs";
import { createOverturePilotProvider } from "../supabase/functions/_shared/search-job-overture-pilot.mjs";

const API_ROLE = "klir_job_api";
const RUNNER_ROLE = "klir_job_runner";
const CONNECT_ROLE = "klir_job_connect";

export function assertRuntimeConfig(env = process.env) {
  if (env.SEARCH_JOBS_LOCAL !== "1") {
    const error = new Error("jobs_v2_desactive");
    error.code = "jobs_v2_desactive";
    throw error;
  }
  if (env.SEARCH_JOBS_DB_PASSWORD || env.PGPASSWORD || env.DATABASE_URL || env.SUPABASE_SERVICE_ROLE_KEY) {
    const error = new Error("secret_refuse");
    error.code = "secret_refuse";
    throw error;
  }
  const host = env.SEARCH_JOBS_DB_HOST || "/var/run/postgresql";
  if (host !== "/var/run/postgresql") {
    const error = new Error("socket_local_requis");
    error.code = "socket_local_requis";
    throw error;
  }
  if (env.SEARCH_JOBS_DB_USER !== CONNECT_ROLE) {
    const error = new Error("role_connexion_refuse");
    error.code = "role_connexion_refuse";
    throw error;
  }
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(env.SEARCH_JOBS_DB_NAME || "")) {
    const error = new Error("base_invalide");
    error.code = "base_invalide";
    throw error;
  }
  const port = env.SEARCH_JOBS_PORT == null || env.SEARCH_JOBS_PORT === "" ? 8787 : Number(env.SEARCH_JOBS_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    const error = new Error("port_invalide");
    error.code = "port_invalide";
    throw error;
  }
  const auth = env.SEARCH_JOBS_AUTH || "local";
  if (auth !== "local" && auth !== "supabase") {
    const error = new Error("auth_mode_inconnu");
    error.code = "auth_mode_inconnu";
    throw error;
  }
  const authTarget = auth === "supabase"
    ? assertLocalAuthTarget(env.SEARCH_JOBS_AUTH_URL, env.SEARCH_JOBS_AUTH_KEY)
    : null;
  return {
    host,
    database: env.SEARCH_JOBS_DB_NAME,
    user: CONNECT_ROLE,
    port,
    worker: env.SEARCH_JOBS_WORKER === "manual" ? "manual" : "auto",
    auth,
    authTarget
  };
}

function createRuntimeGetUser(env) {
  if ((env.SEARCH_JOBS_AUTH || "local") === "supabase") return createSupabaseGetUser(env);
  return createLocalGetUser();
}

function createLocalGetUser() {
  return async function getUser(token) {
    const match = /^local:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(token || "");
    if (!match) return { data: { user: null }, error: { message: "jeton_local_refuse" } };
    return { data: { user: { id: match[1].toLowerCase() } }, error: null };
  };
}

function queryOf(client) {
  return async (sql, params) => {
    const result = await client.query(sql, params);
    return { rows: result.rows };
  };
}

function gate(start) {
  let tail = Promise.resolve();
  return (fn) => {
    const run = tail.then(() => fn(), () => fn());
    tail = run.then(() => {}, () => {});
    return run;
  };
}

function publicError(error) {
  const message = String(error && error.message || "");
  if (message.includes("jobs_disabled")) return { status: 403, error: "jobs_disabled" };
  if (message.includes("rate_limited")) return { status: 429, error: "rate_limited" };
  if (message.includes("authentication_required") || message.includes("session_requise")) return { status: 401, error: "authentication_required" };
  if (message.includes("job_not_found")) return { status: 404, error: "job_not_found" };
  if (/place_rejected|quantite_invalide|idempotency_key_invalide|payload_trop_grand/.test(message)) {
    return { status: 422, error: "place_rejected" };
  }
  return { status: 500, error: "server_error" };
}

async function become(client, role) {
  await client.query(`set role ${role}`);
  const who = await client.query(`
    select current_user as role_name,
           session_user as session_name,
           (select rolsuper from pg_roles where rolname = current_user) as is_super
  `);
  const row = who.rows[0];
  if (row.role_name !== role || row.is_super === true || row.session_name !== CONNECT_ROLE) {
    const error = new Error("role_exploitation_refuse");
    error.code = "role_exploitation_refuse";
    throw error;
  }
  return { role: row.role_name, session: row.session_name, superuser: false };
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 9000) {
      const error = new Error("payload_trop_grand");
      error.code = "payload_trop_grand";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

export async function startSearchJobRuntime(env = process.env) {
  const config = assertRuntimeConfig(env);
  const api = new Client({ host: config.host, database: config.database, user: config.user });
  const runner = new Client({ host: config.host, database: config.database, user: config.user });
  try {
  await api.connect();
  await runner.connect();
  const apiWho = await become(api, API_ROLE);
  const runnerWho = await become(runner, RUNNER_ROLE);
  const onApi = gate();
  const onRunner = gate();
  const adapter = await pilotAdapter(env);
  const verifyJwt = createGetUserVerifier(createRuntimeGetUser(env));

  async function withUser(userId, fn) {
    await api.query("begin");
    try {
      await api.query("select set_config('request.jwt.claim.sub', $1, true)", [userId]);
      const value = await fn(queryOf(api));
      await api.query("commit");
      return value;
    } catch (error) {
      try { await api.query("rollback"); } catch { /* transaction déjà annulée */ }
      throw error;
    }
  }

  const deps = {
    verifyJwt,
    jobsEnabled: () => onApi(async () => {
      const result = await api.query("select public.search_jobs_enabled() as enabled");
      return result.rows[0].enabled === true;
    }),
    rateLimit: async () => false,
    readJob: (userId, id) => onApi(() => withUser(userId, async (query) => {
      const store = createSearchJobStore(query);
      return store.readById(id);
    })),
    cancelJob: (userId, jobId) => onApi(async () => {
      try {
        return await withUser(userId, async (query) => {
          const store = createSearchJobStore(query);
          return store.cancel(jobId);
        });
      } catch (error) {
        if (String(error && error.message || "").includes("job_not_found")) return null;
        throw error;
      }
    }),
    enqueue: ({ userId, idempotencyKey, payload }) => onApi(() => withUser(userId, async (query) => {
      const store = createSearchJobStore(query);
      return store.enqueue(idempotencyKey, payload);
    }))
  };

  async function cycle() {
    return onRunner(() => runWorkerCycle(queryOf(runner), adapter));
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/healthz") {
        send(res, 200, {
          local: true,
          worker: config.worker,
          auth: config.auth === "supabase" ? "supabase-getUser" : "local-simulated",
          api: apiWho,
          runner: runnerWho
        });
        return;
      }
      if (req.method === "POST" && url.pathname === "/internal/step") {
        send(res, 200, await cycle());
        return;
      }
      if (url.pathname !== "/search-jobs") {
        send(res, 404, { error: "not_found" });
        return;
      }
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
      const request = new Request(`http://127.0.0.1${req.url}`, {
        method: req.method,
        headers: req.headers,
        body
      });
      const response = await handleSearchJob(request, deps);
      const text = await response.text();
      res.writeHead(response.status, { "content-type": "application/json; charset=utf-8" });
      res.end(text);
    } catch (error) {
      const mapped = publicError(error);
      if (mapped.status === 500) console.error(`search-job-runtime erreur ${error.code || "unknown"}`);
      if (!res.headersSent) send(res, mapped.status, { error: mapped.error });
      else res.end();
    }
  });

  await new Promise((resolve) => server.listen(config.port, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  let timer = null;
  if (config.worker === "auto") {
    timer = setInterval(() => {
      cycle().catch((error) => console.error(`search-job-runtime erreur ${error.code || "unknown"}`));
    }, 200);
    timer.unref();
  }

  async function close() {
    if (timer) clearInterval(timer);
    await new Promise((resolve) => server.close(resolve));
    await api.end();
    await runner.end();
  }

  return { port, close, config };
  } catch (error) {
    try { await api.end(); } catch { /* client non ouvert */ }
    try { await runner.end(); } catch { /* client non ouvert */ }
    throw error;
  }
}

async function pilotAdapter(env) {
  if (env.SEARCH_JOBS_PROVIDER !== "overture-pilot") return createLocalSimulatedProvider();
  const path = String(env.SEARCH_JOBS_PILOT_SNAPSHOT || "");
  if (!path || /^[a-z][a-z0-9+.-]*:/i.test(path)) {
    const error = new Error("instantane_local_requis");
    error.code = "instantane_local_requis";
    throw error;
  }
  return createOverturePilotProvider(JSON.parse(await readFile(path, "utf8")));
}

async function main() {
  const runtime = await startSearchJobRuntime(process.env);
  console.log(`listening 127.0.0.1 ${runtime.port}`);
  const shutdown = () => runtime.close().then(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`search-job-runtime arret ${error.code || "unknown"}`);
    process.exitCode = 1;
  });
}
