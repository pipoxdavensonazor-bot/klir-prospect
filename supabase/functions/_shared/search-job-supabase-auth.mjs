import { createClient } from "@supabase/supabase-js";

const BLOCKED_PROJECTS = ["pwakjxjjxswdjsapsbxn", "cbklwmjudobqwbkbxqgy"];

function reject(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// Cible autorisée : boucle locale et clé publique de fixture.
// Aucun projet Supabase, aucune clé secrète, aucun appel tant que ce contrôle échoue.
export function assertLocalAuthTarget(url, key) {
  const rawUrl = String(url || "").trim();
  const rawKey = String(key || "").trim();
  const haystack = `${rawUrl} ${rawKey}`.toLowerCase();
  if (BLOCKED_PROJECTS.some((id) => haystack.includes(id)) || /supabase\.co/i.test(rawUrl)) {
    throw reject("projet_distant_refuse");
  }
  if (/service_role/i.test(rawKey) || rawKey.startsWith("sb_secret_") || rawKey.startsWith("sb_temp_")) {
    throw reject("cle_secrete_refusee");
  }
  if (rawUrl.includes("@")) throw reject("secret_refuse");
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw reject("url_auth_invalide");
  }
  if (parsed.username || parsed.password) throw reject("secret_refuse");
  if (parsed.protocol !== "http:") throw reject("url_auth_invalide");
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") throw reject("hote_non_local");
  if (parsed.pathname !== "/" && parsed.pathname !== "") throw reject("url_auth_invalide");
  if (parsed.search || parsed.hash) throw reject("url_auth_invalide");
  if (!/^sb_publishable_local_[a-z0-9_]+$/.test(rawKey)) throw reject("cle_locale_requise");
  return { origin: parsed.origin, key: rawKey };
}

function memoryStorage() {
  return {
    getItem() { return null; },
    setItem() {},
    removeItem() {}
  };
}

// getUser est celui de supabase-js. Le jeton n'est pas décodé ici :
// l'identifiant vient uniquement de la réponse HTTP du service d'auth.
export function createSupabaseGetUser(source = {}) {
  const target = assertLocalAuthTarget(
    source.SEARCH_JOBS_AUTH_URL || source.url,
    source.SEARCH_JOBS_AUTH_KEY || source.key
  );
  const client = createClient(target.origin, target.key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storage: memoryStorage()
    }
  });
  return function getUser(jwt) {
    return client.auth.getUser(jwt);
  };
}
