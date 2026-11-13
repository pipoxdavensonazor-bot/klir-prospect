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
  parseAuthError,
  recoveryRequestMessage,
  passwordIssues,
  passwordMessage,
  workspaceForMigration
} from "./auth-policy.js";
import { createServerDiagnostic, createServerCycle, publicDiagnosticBody, publicCycleBody } from "./server-diagnostic.js";
import { awaitServerJob, listRecoverableServerJobs, readServerJobPlaces } from "./server-jobs.js";

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
let currentAdmin = false;
let passwordRecovery = false;
let initialized = false;
let callbackError = null;

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
  callbackError = parseAuthError(window.location.search) || parseAuthError(window.location.hash);
  if (callbackError) {
    sessionStorage.removeItem(CALLBACK_KEY);
    const url = new URL(window.location.href);
    for (const key of ["error", "error_code", "error_description", "token_hash", "type", "code"]) url.searchParams.delete(key);
    if (parseAuthError(url.hash)) url.hash = "";
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
    return null;
  }
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

async function readAdminFlag(supabase) {
  try {
    const result = await supabase.rpc("is_admin");
    return !result.error && result.data === true;
  } catch {
    return false;
  }
}

async function hydrate() {
  if (!client) {
    currentAdmin = false;
    return state();
  }
  const { data: { user }, error } = await client.auth.getUser();
  if (error && error.name !== "AuthSessionMissingError") throw error;
  currentUser = user || null;
  currentProfile = null;
  currentAdmin = false;
  if (currentUser) {
    const result = await client.from("profiles").select("id, display_name, demo_migrated_at, created_at, updated_at").eq("id", currentUser.id).single();
    if (result.error) throw result.error;
    currentProfile = result.data;
    currentAdmin = await readAdminFlag(client);
  }
  return state();
}

function state() {
  return {
    configured,
    user: currentUser,
    profile: currentProfile,
    admin: currentAdmin === true,
    passwordRecovery,
    callbackError,
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
    currentAdmin = false;
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
    currentAdmin = false;
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
  callbackError = null;
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

async function startStripeTestCheckout() {
  const flags = window.__KLIR_CONFIG__ || {};
  if (!overturePreview() || flags.stripeTestCheckout !== true || !currentUser || !currentUser.email) return { ok: false, outcome: "purchases_closed" };
  const supabase = await requireClient();
  const result = await supabase.functions.invoke("stripe-test-checkout", { body: {} });
  const data = result.data || {};
  if (result.error || !/^https:\/\/checkout\.stripe\.com\//.test(data.url || "") || !/^cs_test_[A-Za-z0-9_]+$/.test(data.sessionId || "")) {
    return { ok: false, outcome: data.outcome || "unavailable" };
  }
  sessionStorage.setItem("klir_stripe_test_session", data.sessionId);
  return { ok: true, url: data.url };
}

async function confirmStripeTestCheckout(sessionId) {
  const flags = window.__KLIR_CONFIG__ || {};
  if (!overturePreview() || flags.stripeTestCheckout !== true || !currentUser) return { ok: false, outcome: "purchases_closed" };
  const supabase = await requireClient();
  const result = await supabase.functions.invoke("stripe-test-confirm", { body: { sessionId: sessionId || "" } });
  const data = result.data || {};
  if (result.error) return { ok: false, outcome: data.outcome || "unavailable" };
  return { ok: true, outcome: data.outcome, active: data.active === true, balance: Number.isInteger(data.balance) ? data.balance : null };
}

const SEARCH_JOB_CITY_KEYS = new Set(["montréal", "laval", "québec", "toronto", "paris", "lyon", "marseille"]);
const SEARCH_JOB_TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

async function functionReply(result) {
  let data = result && result.data && typeof result.data === "object" ? result.data : null;
  const context = result && result.error && result.error.context;
  if (!data && context && typeof context.clone === "function") {
    try {
      const body = await context.clone().json();
      data = body && typeof body === "object" ? body : null;
    } catch {
      data = null;
    }
  }
  const status = context && typeof context.status === "number" ? context.status : (result && result.error ? 0 : 200);
  return { data, status, failed: Boolean(result && result.error) };
}

const SEARCH_JOB_ERRORS = new Set(["jobs_disabled", "credits_insuffisants", "rate_limited", "place_rejected", "quantite_invalide"]);

// Recherche par la file serveur : enqueue, attente du runner, lecture des fiches du propriétaire (RLS).
// Le navigateur n'appelle aucune RPC de débit : le serveur réserve et règle le reçu.
async function searchJob(request, options = {}) {
  if (!currentUser) return { ok: false, outcome: "session_requise" };
  const payload = request && request.payload && typeof request.payload === "object" ? request.payload : {};
  const cityKey = String(payload.cityKey || "");
  const quantity = Number(payload.quantity);
  if (!SEARCH_JOB_CITY_KEYS.has(cityKey)) return { ok: false, outcome: "lieu_hors_pilote" };
  if (!Number.isInteger(quantity) || quantity < 10 || quantity > 40) return { ok: false, outcome: "quantite_invalide" };
  const idempotencyKey = String(request && request.idempotencyKey || "");
  if (idempotencyKey.length < 8 || idempotencyKey.length > 80) return { ok: false, outcome: "jobs_injoignable" };
  const supabase = await requireClient();
  const enqueued = await functionReply(await supabase.functions.invoke("search-jobs", {
    body: {
      action: "enqueue",
      idempotencyKey,
      payload: {
        place_status: "supported",
        cityKey,
        industry: String(payload.industry || "all"),
        quantity,
        source: "overture-places-pilot",
        coverage: "rayon_2200m_six_centres"
      }
    }
  }));
  const code = enqueued.data && typeof enqueued.data.error === "string" ? enqueued.data.error : "";
  if (SEARCH_JOB_ERRORS.has(code)) return { ok: false, outcome: code };
  if (enqueued.failed || !enqueued.data || typeof enqueued.data.id !== "string") return { ok: false, outcome: "jobs_injoignable" };
  const job = await awaitServerJob(pollJobStatus(supabase), enqueued.data, { sleep: options.sleep });
  return finishServerJob(supabase, job);
}

function pollJobStatus(supabase) {
  return async (id) => {
    const polled = await functionReply(await supabase.functions.invoke(`search-jobs?id=${encodeURIComponent(id)}`, { method: "GET" }));
    return polled.data && typeof polled.data.status === "string" ? polled.data : null;
  };
}

// Lecture finale d'un job : solde serveur, puis fiches du propriétaire (RLS). Aucun débit ici.
async function finishServerJob(supabase, job) {
  const account = await readCreditAccount();
  const money = account.ok ? { balance: account.balance, searches: account.searches } : {};
  if (!SEARCH_JOB_TERMINAL.has(job.status)) return { ok: false, outcome: "en_attente", job, ...money };
  if (job.status !== "succeeded") return { ok: false, outcome: "echec", job, ...money };
  const listed = await readServerJobPlaces(supabase, job.id);
  if (!listed.ok) return { ok: false, outcome: "jobs_injoignable", job, ...money };
  return { ok: true, outcome: "termine", job, places: listed.places, ...money };
}

// Après un rechargement : jobs du compte terminés mais absents de l'historique,
// et jobs encore en file. Lecture seule, aucune mise en file, aucun débit.
async function syncServerJobs(options = {}) {
  if (!currentUser) return { ok: false, completed: [], active: [], terminal: [] };
  const supabase = await requireClient();
  return listRecoverableServerJobs(supabase, options);
}

// Reprend le suivi d'un job déjà en file (aucune nouvelle demande au serveur de recherche).
async function resumeServerJob(job, options = {}) {
  if (!currentUser || !job || typeof job.id !== "string") return { ok: false, outcome: "session_requise" };
  const supabase = await requireClient();
  const done = await awaitServerJob(pollJobStatus(supabase), job, { sleep: options.sleep });
  return finishServerJob(supabase, done);
}

async function initialize() {
  const hasAuthCode = new URLSearchParams(window.location.search).has("code");
  captureCallback();
  if (!client) return state();
  if (!initialized) {
    initialized = true;
    client.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") passwordRecovery = true;
      if (event === "SIGNED_OUT") {
        currentUser = null;
        currentProfile = null;
        currentAdmin = false;
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
  const initialization = await client.auth.initialize();
  // The SDK silently ignores a code when this tab has no PKCE verifier.
  // Successful SDK exchange removes code from the URL; never exchange it twice.
  const unprocessedCode = hasAuthCode && new URLSearchParams(window.location.search).has("code");
  if ((initialization.error || unprocessedCode) && hasAuthCode && !callbackError) {
    callbackError = unprocessedCode && !initialization.error || initialization.error?.code === "pkce_code_verifier_not_found"
      ? "Ce lien doit être ouvert dans l’onglet et le navigateur où vous avez demandé la récupération. Revenez à cet onglet ou demandez un nouveau lien."
      : "Ce lien n’a pas pu être validé. Demandez un nouveau lien ou revenez à la connexion.";
    const url = new URL(window.location.href);
    url.searchParams.delete("code");
    url.searchParams.delete("flow_id");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
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
  recoveryRequestMessage,
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
  startStripeTestCheckout,
  confirmStripeTestCheckout,
  searchJob,
  syncServerJobs,
  resumeServerJob,
  completeCallback,
  dismissCallback
};

window.KlirAuth.diagnoseServerConnection = createServerDiagnostic({
  config: () => config,
  session: () => ({ user: currentUser }),
  isAdmin: async () => {
    const supabase = await requireClient();
    currentAdmin = await readAdminFlag(supabase);
    return currentAdmin;
  },
  invoke: async () => {
    const supabase = await requireClient();
    const result = await supabase.functions.invoke("search-job-runner", { body: { action: "diagnose" } });
    const status = result.error && result.error.context && typeof result.error.context.status === "number"
      ? result.error.context.status
      : 0;
    let data = publicDiagnosticBody(result.data);
    if (!data && result.error && result.error.context && typeof result.error.context.clone === "function") {
      try {
        data = publicDiagnosticBody(await result.error.context.clone().json());
      } catch {
        data = null;
      }
    }
    return { data, error: Boolean(result.error), status };
  }
});

window.KlirAuth.runServerCycle = createServerCycle({
  config: () => config,
  session: () => ({ user: currentUser }),
  isAdmin: async () => {
    const supabase = await requireClient();
    currentAdmin = await readAdminFlag(supabase);
    return currentAdmin;
  },
  invoke: async (body) => {
    const supabase = await requireClient();
    const result = await supabase.functions.invoke("search-job-runner", { body });
    const status = result.error && result.error.context && typeof result.error.context.status === "number"
      ? result.error.context.status
      : (result.error ? 0 : 200);
    let data = publicCycleBody(result.data);
    if (!data && result.error && result.error.context && typeof result.error.context.clone === "function") {
      try {
        data = publicCycleBody(await result.error.context.clone().json());
      } catch {
        data = null;
      }
    }
    return { data, error: Boolean(result.error), status };
  }
});
