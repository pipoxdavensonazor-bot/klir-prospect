import { createClient } from "@supabase/supabase-js";
import {
  confirmedDeletion,
  deletionFailureMessage,
  displayName,
  emailAddress,
  emailLinkParams,
  passwordIssue
} from "./auth-policy.js";

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

const profileColumns = "id, display_name, demo_migrated_at, created_at, updated_at";
let currentUser = null;
let currentProfile = null;
let passwordRecovery = false;
let linkError = "";
let initialized = false;

function redirect(path) {
  return `${window.location.origin}${window.location.pathname}#/${path}`;
}

function requireClient() {
  if (!client) throw new Error("Supabase n’est pas configuré.");
  return client;
}

function authFailure(error, fallback) {
  if (!error) return null;
  const code = String(error.code || "");
  const message = String(error.message || "");
  if (code === "over_request_rate_limit" || /rate limit/i.test(message)) {
    return { message: "Trop de tentatives. Réessayez plus tard." };
  }
  if (code === "weak_password" || /password/i.test(message)) {
    return { message: "Le mot de passe ne respecte pas les exigences." };
  }
  return { message: fallback };
}

function state() {
  return {
    configured,
    user: currentUser,
    profile: currentProfile,
    passwordRecovery,
    linkError
  };
}

async function hydrate() {
  if (!client) return state();
  const { data: { user }, error } = await client.auth.getUser();
  if (error && error.name !== "AuthSessionMissingError") throw error;
  currentUser = user || null;
  currentProfile = null;
  if (currentUser) {
    const result = await client.from("profiles").select(profileColumns).eq("id", currentUser.id).maybeSingle();
    if (result.error) throw result.error;
    currentProfile = result.data;
  }
  return state();
}

async function consumeEmailLink() {
  const parsed = emailLinkParams(window.location.href);
  if (!parsed || !client) return;
  linkError = "";
  const result = await client.auth.verifyOtp({
    token_hash: parsed.tokenHash,
    type: parsed.type
  });
  if (result.error) {
    linkError = "Lien invalide ou expiré. Demandez un nouvel e-mail.";
  } else if (parsed.type === "recovery") {
    passwordRecovery = true;
  }
  const route = parsed.route ? `#/${parsed.route}` : "";
  window.history.replaceState({}, "", `${window.location.pathname}${route}`);
}

async function signUp({ email, password, displayName: name }) {
  const supabase = requireClient();
  const normalizedEmail = emailAddress(email);
  const issue = passwordIssue(password);
  if (!normalizedEmail) return { data: { user: null, session: null }, error: { message: "Adresse e-mail invalide." } };
  if (issue) return { data: { user: null, session: null }, error: { message: issue } };
  const result = await supabase.auth.signUp({
    email: normalizedEmail,
    password,
    options: {
      emailRedirectTo: redirect("auth/callback"),
      data: { display_name: displayName(name) }
    }
  });
  if (result.error) {
    const leaked = /already registered|already been registered|user already exists/i.test(result.error.message || "");
    if (leaked) return { data: { user: null, session: null }, error: null };
    return { data: result.data, error: authFailure(result.error, "Inscription impossible.") };
  }
  return result;
}

async function resendVerification(email) {
  const supabase = requireClient();
  const normalizedEmail = emailAddress(email);
  if (!normalizedEmail) return { error: { message: "Adresse e-mail invalide." } };
  const result = await supabase.auth.resend({
    type: "signup",
    email: normalizedEmail,
    options: { emailRedirectTo: redirect("auth/callback") }
  });
  if (result.error) return { error: authFailure(result.error, "Envoi impossible.") };
  return { error: null };
}

async function signIn({ email, password }) {
  const supabase = requireClient();
  const normalizedEmail = emailAddress(email);
  if (!normalizedEmail || !password) {
    return { data: { user: null, session: null }, error: { message: "E-mail ou mot de passe incorrect." } };
  }
  const result = await supabase.auth.signInWithPassword({ email: normalizedEmail, password });
  if (result.error) {
    if (/rate limit/i.test(result.error.message || "")) {
      return { data: result.data, error: { message: "Trop de tentatives. Réessayez plus tard." } };
    }
    return { data: result.data, error: { message: "E-mail ou mot de passe incorrect." } };
  }
  return result;
}

async function sendRecovery(email) {
  const supabase = requireClient();
  const normalizedEmail = emailAddress(email);
  if (!normalizedEmail) return { error: null };
  const result = await supabase.auth.resetPasswordForEmail(normalizedEmail, {
    redirectTo: redirect("reset-password")
  });
  if (result.error && /rate limit/i.test(result.error.message || "")) {
    return { error: { message: "Trop de tentatives. Réessayez plus tard." } };
  }
  return { error: null };
}

async function updatePassword(password) {
  const supabase = requireClient();
  const issue = passwordIssue(password);
  if (issue) return { data: { user: null }, error: { message: issue } };
  const result = await supabase.auth.updateUser({ password });
  if (result.error) return { data: result.data, error: authFailure(result.error, "Mise à jour impossible.") };
  passwordRecovery = false;
  return result;
}

async function signOut() {
  const supabase = requireClient();
  const result = await supabase.auth.signOut({ scope: "global" });
  if (!result.error) {
    currentUser = null;
    currentProfile = null;
    passwordRecovery = false;
    linkError = "";
  }
  return result;
}

async function updateProfile(name) {
  const supabase = requireClient();
  if (!currentUser) throw new Error("Session requise.");
  const result = await supabase.from("profiles")
    .update({ display_name: displayName(name) })
    .eq("id", currentUser.id)
    .select(profileColumns)
    .single();
  if (!result.error) currentProfile = result.data;
  return result;
}

async function loadWorkspace() {
  const supabase = requireClient();
  if (!currentUser) throw new Error("Session requise.");
  return supabase.from("workspace_states").select("schema_version, payload, updated_at").eq("user_id", currentUser.id).maybeSingle();
}

async function migrateDemo(payload) {
  const supabase = requireClient();
  if (!currentUser) throw new Error("Session requise.");
  const cleanPayload = window.KlirSecurity.cleanState(payload || {});
  delete cleanPayload.user;
  const serialized = JSON.stringify(cleanPayload);
  if (new Blob([serialized]).size > 2 * 1024 * 1024) throw new Error("Les données dépassent 2 Mo.");
  const result = await supabase.from("workspace_states").upsert({
    user_id: currentUser.id,
    schema_version: 1,
    payload: cleanPayload
  }, { onConflict: "user_id" }).select("updated_at").single();
  if (!result.error) {
    const profileResult = await supabase.from("profiles").select(profileColumns).eq("id", currentUser.id).maybeSingle();
    if (!profileResult.error && profileResult.data) currentProfile = profileResult.data;
  }
  return result;
}

async function deleteAccount({ confirmation, password } = {}) {
  const supabase = requireClient();
  if (!currentUser) return { data: null, error: { message: "Session requise." } };
  if (!confirmedDeletion(confirmation)) {
    return { data: null, error: { message: deletionFailureMessage("confirmation_required") } };
  }
  if (passwordIssue(password)) {
    return { data: null, error: { message: deletionFailureMessage("authentication_required") } };
  }
  const result = await supabase.functions.invoke("delete-account", {
    body: { confirmation, password }
  });
  let code = result.data && result.data.error;
  if (!code && result.error && result.error.context && typeof result.error.context.json === "function") {
    try {
      const body = await result.error.context.json();
      code = body && body.error;
    } catch (error) {
      code = "account_deletion_failed";
    }
  }
  if (result.error || !result.data || result.data.deleted !== true) {
    return { data: result.data, error: { message: deletionFailureMessage(code) } };
  }
  currentUser = null;
  currentProfile = null;
  passwordRecovery = false;
  sessionStorage.clear();
  return result;
}

async function initialize() {
  if (!client) return state();
  if (!initialized) {
    initialized = true;
    client.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") passwordRecovery = true;
      if (event === "SIGNED_OUT") {
        passwordRecovery = false;
        currentUser = null;
        currentProfile = null;
      }
      queueMicrotask(async () => {
        try {
          await hydrate();
          window.dispatchEvent(new CustomEvent("klir-auth-change", { detail: { ...state(), event } }));
        } catch (error) {
          console.error("Mise à jour de session impossible", error);
        }
      });
    });
  }
  try {
    await consumeEmailLink();
  } catch (error) {
    linkError = "Lien invalide ou expiré. Demandez un nouvel e-mail.";
    console.error("Lien d’authentification refusé", error);
  }
  return hydrate();
}

window.KlirAuth = {
  initialize,
  state,
  signUp,
  resendVerification,
  signIn,
  sendRecovery,
  updatePassword,
  signOut,
  updateProfile,
  loadWorkspace,
  migrateDemo,
  deleteAccount
};
