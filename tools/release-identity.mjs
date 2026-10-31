export const KNOWN_PRODUCTION_SUPABASE_URL = "https://cbklwmjudobqwbkbxqgy.supabase.co";
const SUPABASE_URL_PATTERN = /^https:\/\/[a-z0-9-]+\.supabase\.co$/;
const NAMED_ENVIRONMENTS = new Set(["production", "preview", "ci", "local"]);
const PUBLIC_CONFIG_ENVIRONMENTS = new Set(["production", "local"]);

// This classifies build inputs; authorization remains enforced by Supabase RLS.
export function isPublicSupabaseKey(value) {
  const key = String(value || "").trim();
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) return true;
  const parts = key.split(".");
  if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) return false;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")).role === "anon";
  } catch {
    return false;
  }
}

export function allowsPublicConfig(environment) {
  return PUBLIC_CONFIG_ENVIRONMENTS.has(environment);
}

function present(value) {
  const text = String(value || "").trim();
  return text !== "" && text !== "0" && text !== "false";
}

function branchName(value) {
  return String(value || "").trim().replace(/^refs\/heads\//, "");
}

export function resolveEnvironment(env = {}) {
  const explicit = String(env.KLIR_ENV || "").trim().toLowerCase();
  if (NAMED_ENVIRONMENTS.has(explicit)) return explicit;
  if (explicit) return "inconnu";
  if (present(env.WORKERS_CI)) {
    const branch = branchName(env.WORKERS_CI_BRANCH);
    if (!branch) return "inconnu";
    return branch === "main" ? "production" : "preview";
  }
  if (present(env.CI)) return "ci";
  return "local";
}

export function productionSupabaseUrl(env = {}) {
  const override = String(env.KLIR_PRODUCTION_SUPABASE_URL || "").trim().replace(/\/+$/, "");
  return override || KNOWN_PRODUCTION_SUPABASE_URL;
}

function blank(source) {
  return {
    supabaseUrl: "",
    supabasePublishableKey: "",
    supabaseSource: source,
    supabaseHost: "",
    fetchPublic: false
  };
}

export function decideSupabase(env = {}, environment = resolveEnvironment(env)) {
  const supabaseUrl = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  const supabasePublishableKey = String(env.SUPABASE_PUBLISHABLE_KEY || "").trim();
  const blocked = supabaseUrl !== "" && supabaseUrl === productionSupabaseUrl(env);
  if (!allowsPublicConfig(environment)) {
    if (!supabaseUrl || !supabasePublishableKey) return blank("absent");
    if (blocked) return blank("production-blocked");
    if (!SUPABASE_URL_PATTERN.test(supabaseUrl) || !isPublicSupabaseKey(supabasePublishableKey)) return blank("absent");
    return {
      supabaseUrl,
      supabasePublishableKey,
      supabaseSource: "env",
      supabaseHost: supabaseUrl.slice("https://".length),
      fetchPublic: false
    };
  }
  const usable = Boolean(supabaseUrl && supabasePublishableKey);
  return {
    supabaseUrl,
    supabasePublishableKey,
    supabaseSource: usable ? "env" : "public-site",
    supabaseHost: SUPABASE_URL_PATTERN.test(supabaseUrl) ? supabaseUrl.slice("https://".length) : "",
    fetchPublic: !usable
  };
}
