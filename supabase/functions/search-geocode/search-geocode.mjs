import { createOpenCageGeocoder, OPENCAGE_SECRET } from "./opencage-geocode.mjs";

export { OPENCAGE_SECRET };
export const PREVIEW_ORIGINS = new Set([
  "https://cursor-test-server-diagnostic-2f07.klirprospect.klirline.ca",
  "https://cursor-search-pilot-ui-2f07.klirprospect.klirline.ca"
]);

function json(status, body, origin) {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (PREVIEW_ORIGINS.has(origin)) {
    headers["access-control-allow-origin"] = origin;
    headers["access-control-allow-headers"] = "authorization, x-client-info, apikey, content-type";
    headers["access-control-allow-methods"] = "POST, OPTIONS";
    headers.vary = "origin";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function publicKeyFrom(env) {
  const dictionary = String(env.SUPABASE_PUBLISHABLE_KEYS || "").trim();
  if (dictionary) {
    const parsed = JSON.parse(dictionary);
    if (!parsed || typeof parsed.default !== "string" || !parsed.default.trim()) {
      const error = new Error("configuration_absente");
      error.code = "configuration_absente";
      throw error;
    }
    return parsed.default.trim();
  }
  return String(env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "").trim();
}

export async function handleSearchGeocode(request, options = {}) {
  const origin = request.headers.get("origin") || "";
  if (request.method === "OPTIONS") {
    if (!PREVIEW_ORIGINS.has(origin)) return json(403, { error: "origine_refusee" }, "");
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
        "access-control-allow-methods": "POST, OPTIONS",
        vary: "origin"
      }
    });
  }
  if (request.method !== "POST") return json(405, { error: "method_not_allowed" }, origin);
  const env = options.env || {};
  const url = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  if (!url || url.includes("cbklwmjudobqwbkbxqgy") || url !== "https://pwakjxjjxswdjsapsbxn.supabase.co") {
    return json(503, { error: "hote_non_test", operational: false }, origin);
  }
  const header = request.headers.get("authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || token.startsWith("local:")) return json(401, { error: "authentication_required", operational: false }, origin);
  if (typeof options.createClient !== "function") return json(503, { error: "connexion_non_branchee", operational: false }, origin);
  let publicKey = "";
  try {
    publicKey = publicKeyFrom(env);
  } catch {
    return json(503, { error: "cle_publique_illisible", operational: false }, origin);
  }
  if (!publicKey) return json(503, { error: "configuration_absente", operational: false }, origin);
  const supabase = options.createClient(url, publicKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${token}` } }
  });
  const user = await supabase.auth.getUser(token);
  if (!user || user.error || !user.data || !user.data.user) return json(401, { error: "authentication_required", operational: false }, origin);
  const admin = await supabase.rpc("is_admin");
  if (admin.error || admin.data !== true) return json(403, { error: "autorisation_refusee", operational: false }, origin);
  let body = {};
  try { body = await request.json(); } catch { return json(400, { error: "invalid_request", operational: false }, origin); }
  const geocoder = createOpenCageGeocoder({ env, fetch: options.fetch });
  if (body.action === "status") {
    return json(200, { configured: geocoder.hasKey, operational: false, secret: OPENCAGE_SECRET }, origin);
  }
  if (body.action !== "geocode" || body.usage !== "ponctuel") {
    return json(403, { error: "geocodage_systematique_refuse", operational: false }, origin);
  }
  const result = await geocoder.lookup(body);
  const status = result.outcome === "cle_absente" ? 503 : result.ok || result.outcome === "ambigu" || result.outcome === "a_confirmer" ? 200 : 422;
  return json(status, result, origin);
}
