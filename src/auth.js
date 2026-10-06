import { createClient } from "@supabase/supabase-js";

const config = window.__KLIR_CONFIG__ || {};
const configured = Boolean(config.supabaseUrl && config.supabasePublishableKey);
const storage = {
  getItem(key) { return sessionStorage.getItem(key); },
  setItem(key, value) { sessionStorage.setItem(key, value); },
  removeItem(key) { sessionStorage.removeItem(key); }
};
const client = configured ? createClient(config.supabaseUrl, config.supabasePublishableKey, {
  auth: {
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: "pkce",
    persistSession: true,
    storage
  }
}) : null;

let currentUser = null;
let currentProfile = null;
let passwordRecovery = false;
let initialized = false;

function redirect(path) {
  return `${window.location.origin}${window.location.pathname}#/${path}`;
}

async function requireClient() {
  if (!client) throw new Error("Supabase n’est pas configuré.");
  return client;
}

async function hydrate() {
  if (!client) return { configured: false, user: null, profile: null };
  const { data: { user }, error } = await client.auth.getUser();
  if (error && error.name !== "AuthSessionMissingError") throw error;
  currentUser = user || null;
  currentProfile = null;
  if (currentUser) {
    const result = await client.from("profiles").select("id, display_name, demo_migrated_at, created_at, updated_at").eq("id", currentUser.id).single();
    if (result.error) throw result.error;
    currentProfile = result.data;
  }
  return state();
}

function state() {
  return {
    configured,
    user: currentUser,
    profile: currentProfile,
    passwordRecovery
  };
}

async function signUp({ email, password, displayName }) {
  const supabase = await requireClient();
  return supabase.auth.signUp({
    email: String(email || "").trim(),
    password,
    options: {
      emailRedirectTo: redirect("auth/callback"),
      data: { display_name: String(displayName || "").trim().slice(0, 120) }
    }
  });
}

async function signIn({ email, password }) {
  const supabase = await requireClient();
  return supabase.auth.signInWithPassword({ email: String(email || "").trim(), password });
}

async function sendRecovery(email) {
  const supabase = await requireClient();
  return supabase.auth.resetPasswordForEmail(String(email || "").trim(), {
    redirectTo: redirect("reset-password")
  });
}

async function updatePassword(password) {
  const supabase = await requireClient();
  const result = await supabase.auth.updateUser({ password });
  if (!result.error) passwordRecovery = false;
  return result;
}

async function signOut() {
  const supabase = await requireClient();
  const result = await supabase.auth.signOut({ scope: "global" });
  if (!result.error) {
    currentUser = null;
    currentProfile = null;
    passwordRecovery = false;
  }
  return result;
}

async function updateProfile(displayName) {
  const supabase = await requireClient();
  if (!currentUser) throw new Error("Session requise.");
  const result = await supabase.from("profiles")
    .update({ display_name: String(displayName || "").trim().slice(0, 120) })
    .eq("id", currentUser.id)
    .select("id, display_name, demo_migrated_at, created_at, updated_at")
    .single();
  if (!result.error) currentProfile = result.data;
  return result;
}

async function loadWorkspace() {
  const supabase = await requireClient();
  if (!currentUser) throw new Error("Session requise.");
  return supabase.from("workspace_states").select("schema_version, payload, updated_at").eq("user_id", currentUser.id).maybeSingle();
}

async function migrateDemo(payload) {
  const supabase = await requireClient();
  if (!currentUser) throw new Error("Session requise.");
  const cleanPayload = window.KlirSecurity.cleanState(payload || {});
  const serialized = JSON.stringify(cleanPayload);
  if (new Blob([serialized]).size > 2 * 1024 * 1024) throw new Error("Les données dépassent 2 Mo.");
  const result = await supabase.from("workspace_states").upsert({
    user_id: currentUser.id,
    schema_version: 1,
    payload: cleanPayload
  }, { onConflict: "user_id" }).select("updated_at").single();
  if (!result.error) {
    const profileResult = await supabase.from("profiles")
      .update({ demo_migrated_at: new Date().toISOString() })
      .eq("id", currentUser.id)
      .select("id, display_name, demo_migrated_at, created_at, updated_at")
      .single();
    if (!profileResult.error) currentProfile = profileResult.data;
  }
  return result;
}

async function deleteAccount(confirmation) {
  const supabase = await requireClient();
  if (!currentUser) throw new Error("Session requise.");
  const result = await supabase.functions.invoke("delete-account", {
    body: { confirmation }
  });
  if (!result.error && result.data?.deleted) {
    currentUser = null;
    currentProfile = null;
    sessionStorage.clear();
  }
  return result;
}

async function initialize() {
  if (!client) return state();
  if (!initialized) {
    initialized = true;
    client.auth.onAuthStateChange((event) => {
      passwordRecovery = event === "PASSWORD_RECOVERY" || passwordRecovery;
      queueMicrotask(async () => {
        try {
          await hydrate();
          window.dispatchEvent(new CustomEvent("klir-auth-change", { detail: state() }));
        } catch (error) {
          console.error("Mise à jour de session impossible", error);
        }
      });
    });
  }
  return hydrate();
}

window.KlirAuth = {
  initialize,
  state,
  signUp,
  signIn,
  sendRecovery,
  updatePassword,
  signOut,
  updateProfile,
  loadWorkspace,
  migrateDemo,
  deleteAccount
};
