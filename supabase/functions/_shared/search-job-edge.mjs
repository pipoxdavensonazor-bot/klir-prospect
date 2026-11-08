import { createGetUserVerifier } from "./search-job-auth.mjs";
import { handleSearchJob } from "./search-job-http.mjs";

export const TEST_PROJECT_REF = "pwakjxjjxswdjsapsbxn";
export const PROD_PROJECT_REF = "cbklwmjudobqwbkbxqgy";
export const TEST_SUPABASE_URL = `https://${TEST_PROJECT_REF}.supabase.co`;
export const PREVIEW_ORIGIN = "https://cursor-test-server-diagnostic-2f07.klirprospect.klirline.ca";

function previewCors(request) {
  const origin = request.headers.get("origin") || "";
  if (origin !== PREVIEW_ORIGIN) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    vary: "origin"
  };
}

function withPreviewCors(request, response) {
  const extra = previewCors(request);
  if (!extra["access-control-allow-origin"]) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(response.body, { status: response.status, headers });
}

function reject(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function memoryStorage() {
  return {
    getItem() { return null; },
    setItem() {},
    removeItem() {}
  };
}

function bearer(request) {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function assertPublicKey(key) {
  const lower = key.toLowerCase();
  if (
    lower.startsWith("sb_secret_")
    || lower.startsWith("sb_temp_")
    || lower.includes("service_role")
    || lower.includes("eyjyb2xlijoic2vydmljzv9yb2xl")
  ) {
    throw reject("cle_secrete_refusee");
  }
  if (lower.includes(PROD_PROJECT_REF)) throw reject("production_refusee");
  const publishable = /^sb_publishable_[A-Za-z0-9_-]+$/.test(key);
  const legacyPublic = key.split(".").length === 3;
  if (!publishable && !legacyPublic) throw reject("cle_publique_requise");
  return key;
}

export function resolveTestAuth(env = {}) {
  const url = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  if (!url) throw reject("configuration_absente");
  if (url.toLowerCase().includes(PROD_PROJECT_REF)) throw reject("production_refusee");
  if (url !== TEST_SUPABASE_URL) throw reject("hote_non_test");

  let key = "";
  let source = "";
  const dictionary = String(env.SUPABASE_PUBLISHABLE_KEYS || "").trim();
  if (dictionary) {
    let parsed;
    try {
      parsed = JSON.parse(dictionary);
    } catch {
      throw reject("cle_publique_illisible");
    }
    if (!parsed || typeof parsed.default !== "string" || !parsed.default.trim()) {
      throw reject("configuration_absente");
    }
    key = parsed.default.trim();
    source = "SUPABASE_PUBLISHABLE_KEYS";
  } else if (String(env.SUPABASE_PUBLISHABLE_KEY || "").trim()) {
    key = String(env.SUPABASE_PUBLISHABLE_KEY).trim();
    source = "SUPABASE_PUBLISHABLE_KEY";
  } else if (String(env.SUPABASE_ANON_KEY || "").trim()) {
    key = String(env.SUPABASE_ANON_KEY).trim();
    source = "SUPABASE_ANON_KEY";
  } else {
    throw reject("configuration_absente");
  }
  return { url, key: assertPublicKey(key), source };
}

export function searchJobExecutionPlan() {
  return {
    runnable: false,
    operational: false,
    provider: "absent",
    scheduler: "planificateur_non_choisi",
    runner: "non_connecte",
    database: "jwt-authenticated"
  };
}

function sqlCode(error) {
  const text = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`;
  const known = [
    "jobs_disabled",
    "job_not_found",
    "place_rejected",
    "authentication_required",
    "rate_limited",
    "credits_insuffisants",
    "quantite_invalide",
    "idempotency_key_invalide",
    "payload_trop_grand"
  ];
  return known.find((code) => text.includes(code)) || "";
}

function userClient(createClient, config, jwt, fetchImpl) {
  if (typeof createClient !== "function") throw reject("client_auth_requis");
  return createClient(config.url, config.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: memoryStorage()
    },
    global: {
      headers: { Authorization: `Bearer ${jwt}` },
      ...(fetchImpl ? { fetch: fetchImpl } : {})
    }
  });
}

function depsFor(supabase, verifyJwt) {
  return {
    verifyJwt,
    // Le drapeau n'est pas lu ici : search_jobs_enabled n'est pas accordée
    // à authenticated. enqueue_search_job refuse avant toute réservation.
    jobsEnabled: async () => true,
    rateLimit: async () => false,
    async readJob(_userId, id) {
      const { data, error } = await supabase
        .from("search_jobs")
        .select("id, status, attempt, progress, ledger_status")
        .eq("id", id)
        .maybeSingle();
      if (error) {
        const code = sqlCode(error);
        if (code) throw Object.assign(new Error(code), { code });
        throw reject("lecture_refusee");
      }
      if (!data) return null;
      return { ...data, created: false };
    },
    async cancelJob(_userId, jobId) {
      const { data, error } = await supabase.rpc("cancel_search_job", { p_job_id: jobId });
      if (error) {
        if (sqlCode(error) === "job_not_found") return null;
        const code = sqlCode(error);
        throw Object.assign(new Error(code || "annulation_refusee"), { code: code || "annulation_refusee" });
      }
      return data;
    },
    async enqueue({ idempotencyKey, payload }) {
      const { data, error } = await supabase.rpc("enqueue_search_job", {
        p_key: idempotencyKey,
        p_payload: payload
      });
      if (error) {
        const code = sqlCode(error) || "enqueue_refuse";
        throw Object.assign(new Error(code), { code });
      }
      return data;
    }
  };
}

export async function handleSearchJobRequest(request, options = {}) {
  if (request.method === "OPTIONS") {
    if (!previewCors(request)["access-control-allow-origin"]) return json(403, { error: "origine_refusee" });
    return new Response(null, { status: 204, headers: previewCors(request) });
  }
  return withPreviewCors(request, await handleSearchJobRequestBody(request, options));
}

async function handleSearchJobRequestBody(request, options = {}) {
  const plan = searchJobExecutionPlan();
  let config;
  try {
    config = resolveTestAuth(options.env || {});
  } catch (error) {
    return json(503, { error: error.code || "configuration_absente", scheduler: plan.scheduler, runner: plan.runner });
  }

  const url = new URL(request.url || "/", "http://127.0.0.1");
  if (request.method === "GET" && (url.pathname === "/healthz" || url.pathname.endsWith("/healthz"))) {
    return json(200, {
      target: "test",
      project: TEST_PROJECT_REF,
      auth: "getUser",
      database: plan.database,
      jobsFlag: "enforce_par_enqueue_search_job",
      runner: plan.runner,
      provider: plan.provider,
      scheduler: plan.scheduler,
      operational: false,
      keySource: config.source
    });
  }

  const token = bearer(request);
  if (!token) return json(401, { error: "authentication_required" });
  if (token.startsWith("local:")) return json(401, { error: "jeton_local_refuse" });

  let supabase;
  try {
    supabase = userClient(options.createClient, config, token, options.fetch);
  } catch (error) {
    return json(503, { error: error.code || "configuration_absente", scheduler: plan.scheduler, runner: plan.runner });
  }

  const verifyJwt = createGetUserVerifier((jwt) => {
    if (typeof jwt === "string" && jwt.startsWith("local:")) {
      return Promise.resolve({ data: { user: null }, error: { message: "jeton_local_refuse" } });
    }
    return supabase.auth.getUser(jwt);
  });

  try {
    return await handleSearchJob(request, depsFor(supabase, verifyJwt));
  } catch (error) {
    const code = error?.code || sqlCode(error);
    if (code === "jobs_disabled") return json(403, { error: code });
    if (code === "job_not_found") return json(404, { error: code });
    if (code === "rate_limited") return json(429, { error: code });
    if (code === "place_rejected" || code === "quantite_invalide" || code === "idempotency_key_invalide" || code === "payload_trop_grand") {
      return json(422, { error: code });
    }
    return json(503, { error: "server_error", scheduler: plan.scheduler, runner: plan.runner });
  }
}
