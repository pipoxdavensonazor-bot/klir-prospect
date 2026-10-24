import { createClient } from "@supabase/supabase-js";
import {
  CONFIRM_PHRASE,
  accountSessionPlan,
  appRedirectUrl,
  combineWorkspace,
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
  const result=await supabase.from("workspace_states").select(overturePreview()?"schema_version, payload, updated_at, revision":"schema_version, payload, updated_at").eq("user_id", currentUser.id).maybeSingle();
  if(overturePreview()&&result.data)result.data.payload={...result.data.payload,_workspaceRevision:Number(result.data.revision)};
  return result;
}

let workspaceQueue = Promise.resolve();
let revisionUser="", ownRevision=null, acknowledgedRevisions=new Set();

async function writeWorkspace(payload) {
  const supabase = await requireClient();
  if (!currentUser) throw new Error("Session requise.");
  if(overturePreview()){
    if(revisionUser!==currentUser.id){revisionUser=currentUser.id;ownRevision=null;acknowledgedRevisions=new Set();}
    let expected=Number.isSafeInteger(payload._workspaceRevision)?payload._workspaceRevision:0;
    if(ownRevision!==null&&acknowledgedRevisions.has(expected))expected=ownRevision;
    const clean=workspaceForMigration(window.KlirSecurity.cleanState(payload||{}));delete clean._workspaceRevision;delete clean._savedAt;
    if(new Blob([JSON.stringify(clean)]).size>2097152)return {error:{code:"WORKSPACE_TOO_LARGE",message:"Espace de compte supérieur à 2 Mo : copie locale conservée. Téléchargez la sauvegarde locale avant de fermer cet onglet ; aucune limite n’a été augmentée."}};
    const result=await supabase.rpc("workspace_save",{p_expected_revision:expected,p_payload:clean});
    if(result.error){
      if(["PT409","40001"].includes(result.error.code))result.error={...result.error,code:"WORKSPACE_CONFLICT",message:"Conflit : une autre session a enregistré cet espace. Votre copie locale est conservée. Téléchargez-la et comparez les notes/actions avant toute reprise ; aucun écrasement automatique."};
      else if(result.error.message?.includes("payload_too_large"))result.error={...result.error,code:"WORKSPACE_TOO_LARGE",message:"Limite serveur de 2 Mo atteinte. Copie locale conservée : téléchargez-la avant de fermer cet onglet. Aucune donnée du compte remplacée."};
      return result;
    }
    acknowledgedRevisions.add(expected);acknowledgedRevisions.add(Number(result.data.revision));ownRevision=Number(result.data.revision);
    if(window.KlirStore&&window.KlirStore.ackWorkspaceRevision)window.KlirStore.ackWorkspaceRevision(ownRevision);
    return result;
  }
  const existing = await supabase.from("workspace_states").select("payload").eq("user_id", currentUser.id).maybeSingle();
  if (existing.error) return existing;
  const cleanPayload = workspaceForMigration(window.KlirSecurity.cleanState(payload || {}));
  const combined = combineWorkspace(existing.data && existing.data.payload, cleanPayload);
  const serialized = JSON.stringify(combined);
  if (new Blob([serialized]).size > 2 * 1024 * 1024) throw new Error("Les données dépassent 2 Mo.");
  const result = await supabase.from("workspace_states").upsert({
    user_id: currentUser.id,
    schema_version: 1,
    payload: combined
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

function usageMessage(error) {
  const message = error && error.message ? String(error.message) : "";
  if (/credits_insuffisants/i.test(message)) return "Crédits insuffisants. L'achat de crédits n'est pas ouvert. Le solde reste celui du compte.";
  if (/quota_mensuel/i.test(message)) return "Quota mensuel atteint. Il repart à zéro au mois suivant, fuseau America/Toronto.";
  if (/session_requise/i.test(message)) return "Session requise.";
  return "Le registre des crédits n'a pas accepté l'opération. Aucune recherche n'est lancée.";
}

async function readCreditAccount() {
  try {
    const supabase = await requireClient();
    if (!currentUser) return { ok: false, message: "Session requise." };
    const result = await supabase.rpc(overturePreview() ? "overture_account" : "read_credit_account");
    if (result.error) return { ok: false, message: usageMessage(result.error) };
    const row = result.data || {};
    return { ok: true, balance: row.balance, searches: row.searches_used, period: row.usage_period };
  } catch (error) {
    return { ok: false, message: usageMessage(error) };
  }
}

function overturePreview() {
  return config.environment === "preview" && config.supabaseUrl === "https://pwakjxjjxswdjsapsbxn.supabase.co";
}

async function searchOverture(request) {
  if (!overturePreview() || !currentUser) throw new Error("Recherche Overture réservée au pilote connecté.");
  const supabase = await requireClient();
  const reserved = await supabase.rpc("overture_begin", {
    p_receipt: request.receipt, p_city: request.city, p_sector: request.sector, p_quantity: request.quantity
  });
  if (reserved.error) throw new Error(usageMessage(reserved.error));
  const result = await supabase.rpc("overture_execute", { p_receipt: request.receipt }).abortSignal(AbortSignal.timeout(10000));
  if (result.error) throw new Error("Réponse serveur indisponible. Réessayez la même recherche : le reçu est conservé pour éviter un double débit. Une réservation non terminée expire après 60 secondes.");
  return result.data;
}

async function reserveUsage(request) {
  try {
    const supabase = await requireClient();
    if (!currentUser) return { ok: false, message: "Session requise." };
    const result = await supabase.rpc("reserve_usage", {
      p_receipt: request && request.receipt,
      p_amount: request && request.amount,
      p_label: request && request.label
    });
    if (result.error) return { ok: false, message: usageMessage(result.error) };
    const row = result.data || {};
    return { ok: true, balance: row.balance, searches: row.searches_used };
  } catch (error) {
    return { ok: false, message: usageMessage(error) };
  }
}

async function settleUsage(request) {
  try {
    const supabase = await requireClient();
    if (!currentUser) return { ok: false, message: "Session requise." };
    const result = await supabase.rpc("settle_usage", {
      p_receipt: request && request.receipt,
      p_outcome: request && request.outcome
    });
    if (result.error) return { ok: false, message: usageMessage(result.error) };
    const row = result.data || {};
    return { ok: true, balance: row.balance, searches: row.searches_used, status: row.status };
  } catch (error) {
    return { ok: false, message: usageMessage(error) };
  }
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
  workspaceRecovery: payload=>workspaceForMigration(window.KlirSecurity.cleanState(payload)),
  accountSessionPlan,
  combineWorkspace,
  describeSearch,
  mergeWorkspace,
  resyncWorkspace,
  deleteAccount,
  readCreditAccount,
  overturePreview,
  searchOverture,
  reserveUsage,
  settleUsage,
  completeCallback,
  dismissCallback
};
