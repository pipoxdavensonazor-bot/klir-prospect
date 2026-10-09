import { createClient } from "@supabase/supabase-js";
import {
  CONFIRM_PHRASE,
  accountSessionPlan,
  appRedirectUrl,
  describeSearch,
  mergeWorkspace,
  resyncWorkspace,
  displayName,
  isLiveProfile,
  parseAuthCallback,
  passwordIssues,
  passwordMessage,
  workspaceForMigration
} from "./auth-policy.js";

const CALLBACK_KEY = "klir-auth-callback";
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
    storage,
    storageKey: "klir-auth"
  }
}) : null;

let currentUser = null;
let currentProfile = null;
let passwordRecovery = false;
let initialized = false;

function redirectUrl() {
  return appRedirectUrl(window.location.origin, window.location.pathname);
}

function readPending() {
  try {
    const raw = sessionStorage.getItem(CALLBACK_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.tokenHash || !parsed.type) return null;
    return { tokenHash: String(parsed.tokenHash), type: String(parsed.type) };
  } catch {
    return null;
  }
}

function captureCallback() {
  const parsed = parseAuthCallback(window.location.search);
  if (parsed) {
    sessionStorage.setItem(CALLBACK_KEY, JSON.stringify(parsed));
    const url = new URL(window.location.href);
    url.searchParams.delete("token_hash");
    url.searchParams.delete("type");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }
  return readPending();
}

async function requireClient() {
  if (!client) throw new Error("Supabase n’est pas configuré.");
  return client;
}

async function hydrate() {
  if (!client) return state();
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
    passwordRecovery,
    pending: readPending(),
    live: isLiveProfile(currentProfile)
  };
}

async function signUp({ email, password, displayName: name }) {
  if (passwordIssues(password).length) return { data: { user: null, session: null }, error: { message: passwordMessage() } };
  const supabase = await requireClient();
  return supabase.auth.signUp({
    email: String(email || "").trim(),
    password,
    options: {
      emailRedirectTo: redirectUrl(),
      data: { display_name: displayName(name) }
    }
  });
}

async function resendSignUp(email) {
  const supabase = await requireClient();
  return supabase.auth.resend({
    type: "signup",
    email: String(email || "").trim(),
    options: { emailRedirectTo: redirectUrl() }
  });
}

async function signIn({ email, password }) {
  const supabase = await requireClient();
  return supabase.auth.signInWithPassword({ email: String(email || "").trim(), password });
}

async function sendRecovery(email) {
  const supabase = await requireClient();
  return supabase.auth.resetPasswordForEmail(String(email || "").trim(), {
    redirectTo: redirectUrl()
  });
}

async function updatePassword(password) {
  if (passwordIssues(password).length) return { data: { user: null }, error: { message: passwordMessage() } };
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
    sessionStorage.removeItem(CALLBACK_KEY);
  }
  return result;
}

async function updateProfile(name) {
  const supabase = await requireClient();
  if (!currentUser) throw new Error("Session requise.");
  const result = await supabase.from("profiles")
    .update({ display_name: displayName(name) })
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

let workspaceQueue = Promise.resolve();

async function writeWorkspace(payload) {
  const supabase = await requireClient();
  if (!currentUser) throw new Error("Session requise.");
  const cleanPayload = workspaceForMigration(window.KlirSecurity.cleanState(payload || {}));
  const serialized = JSON.stringify(cleanPayload);
  if (new Blob([serialized]).size > 2 * 1024 * 1024) throw new Error("Les données dépassent 2 Mo.");
  const result = await supabase.from("workspace_states").upsert({
    user_id: currentUser.id,
    schema_version: 1,
    payload: cleanPayload
  }, { onConflict: "user_id" }).select("updated_at").single();
  if (!result.error && (!currentProfile || !currentProfile.demo_migrated_at)) await hydrate();
  return result;
}

async function migrateDemo(payload) {
  return persistWorkspace(payload);
}

function persistWorkspace(payload) {
  const job = workspaceQueue.then(() => writeWorkspace(payload)).catch((error) => ({
    data: null,
    error: { message: error && error.message ? error.message : "Enregistrement impossible." }
  }));
  workspaceQueue = job.then(() => {}, () => {});
  return job;
}

async function deleteAccount(confirmation, password) {
  if (confirmation !== CONFIRM_PHRASE) return { data: null, error: { message: "Écrivez SUPPRIMER pour confirmer." } };
  if (passwordIssues(password).length) return { data: null, error: { message: "Saisissez votre mot de passe actuel pour supprimer le compte." } };
  const supabase = await requireClient();
  if (!currentUser || !currentUser.email) throw new Error("Session requise.");
  const reauth = await supabase.auth.signInWithPassword({ email: currentUser.email, password });
  if (reauth.error) return reauth;
  const result = await supabase.functions.invoke("delete-account", {
    body: { confirmation }
  });
  if (!result.error && result.data?.deleted) {
    currentUser = null;
    currentProfile = null;
    passwordRecovery = false;
    sessionStorage.clear();
  }
  return result;
}

async function completeCallback() {
  const pending = readPending();
  if (!pending) return { data: null, error: { message: "Lien absent ou déjà utilisé." } };
  const supabase = await requireClient();
  const result = await supabase.auth.verifyOtp({ token_hash: pending.tokenHash, type: pending.type });
  sessionStorage.removeItem(CALLBACK_KEY);
  if (!result.error && pending.type === "recovery") passwordRecovery = true;
  if (!result.error) await hydrate();
  return result;
}

function dismissCallback() {
  sessionStorage.removeItem(CALLBACK_KEY);
  return state();
}

async function initialize() {
  captureCallback();
  if (!client) return state();
  if (!initialized) {
    initialized = true;
    client.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") passwordRecovery = true;
      if (event === "SIGNED_OUT") {
        currentUser = null;
        currentProfile = null;
        passwordRecovery = false;
      }
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
  resendSignUp,
  signIn,
  sendRecovery,
  updatePassword,
  signOut,
  updateProfile,
  loadWorkspace,
  migrateDemo,
  persistWorkspace,
  accountSessionPlan,
  describeSearch,
  mergeWorkspace,
  resyncWorkspace,
  deleteAccount,
  completeCallback,
  dismissCallback
};
