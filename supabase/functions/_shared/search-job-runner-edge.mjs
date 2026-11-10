import { createGetUserVerifier } from "./search-job-auth.mjs";
import { resolveTestAuth, TEST_PROJECT_REF, PROD_PROJECT_REF } from "./search-job-edge.mjs";
import { runWorkerCycle } from "./search-job-worker.mjs";
import { createOverturePilotProvider } from "./search-job-overture-pilot.mjs";

export const CONNECT_ROLE = "klir_job_connect_test";
export const RUNNER_ROLE = "klir_job_runner";
export const PREVIEW_ORIGIN = "https://cursor-test-server-diagnostic-2f07.klirprospect.klirline.ca";
export const PILOT_UI_ORIGIN = "https://cursor-search-pilot-ui-2f07.klirprospect.klirline.ca";
const PREVIEW_ORIGINS = new Set([PREVIEW_ORIGIN, PILOT_UI_ORIGIN]);

export const RUNNER_DIAGNOSTIC_SQL = Object.freeze({
  assume: "set local role klir_job_runner",
  identity: "select current_user as role_name, session_user as session_name",
  flag: "select private.diagnose_search_job_connection() as jobs_enabled",
  billingProbe: "select 1 from public.credit_accounts limit 0"
});

function reject(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "";
  if (!PREVIEW_ORIGINS.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "vary": "origin"
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function withCors(request, response) {
  const extra = corsHeaders(request);
  if (!extra["access-control-allow-origin"]) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

function bearer(request) {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

const CLIENT_TARGET_KEYS = Object.freeze(["jobId", "job_id", "targetJobId", "target"]);
const TEST_JOB_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function clientSuppliedTarget(body) {
  if (!body || typeof body !== "object") return false;
  return CLIENT_TARGET_KEYS.some((key) => Object.prototype.hasOwnProperty.call(body, key));
}

// La cible vient de l'environnement du serveur de prévisualisation Test.
// Un corps HTTP, même administrateur, ne peut pas la fournir.
export function authorizedTestJobId(env = {}) {
  const raw = String(env.KLIR_JOB_TEST_JOB_ID || "").trim();
  if (!raw) return "";
  if (String(env.KLIR_ENV || "") !== "preview") return "";
  const host = String(env.KLIR_JOB_DB_HOST || "").toLowerCase();
  const user = String(env.KLIR_JOB_DB_USER || "").toLowerCase();
  if (host.includes(PROD_PROJECT_REF) || user.includes(PROD_PROJECT_REF)) return "";
  if (!user.endsWith(`.${TEST_PROJECT_REF}`)) return "";
  if (!TEST_JOB_UUID.test(raw)) throw reject("cible_invalide");
  return raw.toLowerCase();
}

export function assertRunnerDbConfig(env = {}) {
  const host = String(env.KLIR_JOB_DB_HOST || "").trim().toLowerCase();
  const port = Number(String(env.KLIR_JOB_DB_PORT || "").trim());
  const database = String(env.KLIR_JOB_DB_NAME || "").trim();
  const user = String(env.KLIR_JOB_DB_USER || "").trim();
  const password = String(env.KLIR_JOB_DB_PASSWORD || "");
  if (!host || !Number.isInteger(port) || !database || !user || !password) throw reject("connexion_serveur_absente");
  if (host.includes(PROD_PROJECT_REF) || user.toLowerCase().includes(PROD_PROJECT_REF)) throw reject("production_refusee");
  if (!host.endsWith(".pooler.supabase.com")) throw reject("hote_non_pooler");
  if (port !== 6543) throw reject("port_non_transaction");
  if (database !== "postgres") throw reject("base_refusee");
  if (user !== `${CONNECT_ROLE}.${TEST_PROJECT_REF}`) throw reject("role_connexion_refuse");
  return { host, port, database, user, password };
}

export function bindRunnerPostgres(postgres) {
  if (typeof postgres !== "function") throw reject("connexion_non_branchee");
  return async function connect(env) {
    const config = assertRunnerDbConfig(env);
    const sql = postgres({
      host: config.host,
      port: config.port,
      database: config.database,
      username: config.user,
      password: config.password,
      ssl: "require",
      max: 1,
      prepare: false
    });
    return {
      begin: (fn) => sql.begin(fn),
      close: () => sql.end({ timeout: 1 })
    };
  };
}

function userClient(createClient, auth, jwt, fetchImpl) {
  return createClient(auth.url, auth.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: { getItem() { return null; }, setItem() {}, removeItem() {} }
    },
    global: {
      headers: { Authorization: `Bearer ${jwt}` },
      ...(fetchImpl ? { fetch: fetchImpl } : {})
    }
  });
}

async function readDiagnosis(sql) {
  await sql.unsafe(RUNNER_DIAGNOSTIC_SQL.assume);
  const who = await sql.unsafe(RUNNER_DIAGNOSTIC_SQL.identity);
  const flag = await sql.unsafe(RUNNER_DIAGNOSTIC_SQL.flag);
  const identity = who && who[0];
  const jobsEnabled = flag && flag[0] ? flag[0].jobs_enabled === true : null;
  if (!identity || identity.role_name !== RUNNER_ROLE || identity.session_name !== CONNECT_ROLE) {
    throw reject("role_exploitation_refuse");
  }
  return { jobsEnabled };
}

function permissionDenied(error) {
  if (!error || typeof error !== "object") return false;
  if (error.code === "42501" || /permission denied/i.test(String(error.message || ""))) return true;
  return permissionDenied(error.cause);
}

async function assertBillingDenied(db) {
  try {
    await db.begin(async (sql) => {
      await sql.unsafe(RUNNER_DIAGNOSTIC_SQL.assume);
      await sql.unsafe(RUNNER_DIAGNOSTIC_SQL.billingProbe);
      throw reject("role_trop_large");
    });
  } catch (error) {
    if (error && error.code === "role_trop_large") throw error;
    if (permissionDenied(error)) return;
    throw reject("connexion_serveur_absente");
  }
  throw reject("role_trop_large");
}

export async function handleRunnerDiagnostic(request, options = {}) {
  if (request.method === "OPTIONS") {
    if (!corsHeaders(request)["access-control-allow-origin"]) return json(403, { error: "origine_refusee" });
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  return withCors(request, await diagnose(request, options));
}

async function diagnose(request, options) {
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" });
  const token = bearer(request);
  if (!token || token.startsWith("local:")) return json(401, { error: "authentication_required" });

  let body;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_request" });
  }
  let auth;
  try {
    auth = resolveTestAuth(options.env || {});
  } catch (error) {
    return json(503, { error: error.code || "configuration_absente" });
  }
  if (typeof options.createClient !== "function") return json(503, { error: "connexion_non_branchee" });

  const supabase = userClient(options.createClient, auth, token, options.fetch);
  const verifyJwt = createGetUserVerifier((jwt) => supabase.auth.getUser(jwt));
  const user = await verifyJwt(token);
  if (!user) return json(401, { error: "authentication_required" });
  const admin = await supabase.rpc("is_admin");
  if (admin.error || admin.data !== true) return json(403, { error: "autorisation_refusee" });
  if (clientSuppliedTarget(body)) return json(400, { error: "cible_refusee" });
  if (!body || (body.action !== "diagnose" && body.action !== "cycle")) return json(403, { error: "fournisseur_absent" });
  let targetJobId = "";
  try {
    targetJobId = authorizedTestJobId(options.env || {});
  } catch (error) {
    return json(400, { error: error.code || "cible_invalide" });
  }
  try {
    assertRunnerDbConfig(options.env || {});
  } catch (error) {
    return json(503, { error: error.code || "configuration_absente" });
  }
  if (typeof options.connect !== "function") return json(503, { error: "connexion_non_branchee" });

  let db;
  try {
    db = await options.connect(options.env);
    if (body.action === "cycle") {
      const cycle = await db.begin(async (sql) => {
        await sql.unsafe("set local role klir_job_runner");
        let provider = options.provider;
        if (!provider) {
          const loaded = await sql.unsafe("select private.pilot_snapshot() as document");
          const snapshot = loaded && loaded[0] ? loaded[0].document : null;
          provider = createOverturePilotProvider(snapshot);
        }
        const query = async (text, params) => ({ rows: await sql.unsafe(text, params || []) });
        return runWorkerCycle(query, provider, { targetJobId });
      });
      const jobs = Array.isArray(cycle && cycle.results) ? cycle.results : [];
      return json(200, {
        connected: true,
        role: RUNNER_ROLE,
        provider: "overture-places-pilot",
        coverage: "sonde_centre",
        operational: false,
        contactsVerified: false,
        executed: true,
        scheduler: "off",
        expired: cycle && cycle.expired ? cycle.expired : 0,
        jobs: jobs.map((row) => ({
          id: row.id,
          status: row.status,
          ledger_status: row.ledger_status || null
        }))
      });
    }
    const diagnosis = await db.begin((sql) => readDiagnosis(sql));
    await assertBillingDenied(db);
    return json(200, {
      connected: true,
      role: RUNNER_ROLE,
      jobsEnabled: diagnosis.jobsEnabled,
      billing: "refuse",
      provider: "absent",
      executed: false,
      scheduler: "off"
    });
  } catch (error) {
    const code = error && /^[a-z0-9_]+$/.test(String(error.code || "")) ? error.code : "connexion_serveur_absente";
    return json(503, { error: code });
  } finally {
    if (db) {
      try { await db.close(); } catch { /* fermeture */ }
    }
  }
}
