var LS = "klir_demo_session_v3";
var LIMITS = { Free: { searches: 10, prospects: 500, ai: 100, exports: 20 } };
var DEF = {
  user: null, org: null, searches: [], prospects: [], crm: [], campaigns: [],
  activities: [], aiLog: [], notifications: [], audit: [], optout: [], approvals: [],
  creditLog: [], opps: [], watch: [], customLists: [], deals: [], manualContacts: [],
  usage: { searches: 0, prospects: 0, ai: 0, exports: 0 }, plan: "Free", demo: true,
  integrations: {
    directory: { name: "Annuaire public (démo)", on: true, noKey: true },
    sirene: { name: "Sirene — données ouvertes FR", on: false, noKey: true },
    osm: { name: "OpenStreetMap", on: false, noKey: true }
  },
  icp: null,
  radarCfg: { signals: ["Entreprise récente", "Recrutement", "Expansion"], freq: "daily" },
  radarStats: null, weights: { industry: 25, location: 15, signals: 15, size: 10 },
  credits: { balance: 200 }, apiKey: null, webai: null
};
function blankState(){ return structuredClone(DEF); }
function normalizeState(value){
  var cleaned = window.KlirSecurity ? window.KlirSecurity.cleanState(value || {}) : (value || {});
  var s = Object.assign(blankState(), cleaned);
  for (const key of ["notifications","audit","optout","approvals","creditLog","opps","watch","customLists","deals","manualContacts","searches","prospects","crm","campaigns","activities","aiLog"]) {
    if (!Array.isArray(s[key])) s[key] = [];
  }
  s.usage = Object.assign({ searches: 0, prospects: 0, ai: 0, exports: 0 }, s.usage || {});
  s.integrations = structuredClone(DEF.integrations);
  s.apiKey = null;
  s.plan = "Free";
  s.demo = true;
  delete s.team;
  delete s.grants;
  delete s.sharedFrom;
  return s;
}
function readSession(){
  try {
    var raw = sessionStorage.getItem(LS);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.warn("Session locale illisible", error);
    return null;
  }
}
var _S = normalizeState(readSession());
function save(){
  _S = normalizeState(_S);
  _S._savedAt = Date.now();
  try {
    var payload = JSON.stringify(_S);
    if (new Blob([payload]).size > 2 * 1024 * 1024) throw new Error("quota-session");
    sessionStorage.setItem(LS, payload);
  } catch (error) {
    console.error("Sauvegarde de session impossible", error);
    notify("Sauvegarde impossible : exportez ou réduisez les données.");
  }
}
function startDemo(){
  _S = blankState();
  _S.user = { email: "demo@local.invalid" };
  _S.org = { name: "Espace de démonstration", city: "Montréal" };
  save();
  return { ok: true };
}
function disabledAuth(){
  return { err: "Authentification désactivée : un backend avec sessions HttpOnly est requis." };
}
function logoutUser(){ _S = blankState(); sessionStorage.removeItem(LS); }
function deleteAccount(){
  logoutUser();
  return { ok: true };
}
function addActivity(text){ _S.activities.unshift({ t: String(text), at: new Date().toLocaleString() }); _S.activities = _S.activities.slice(0, 30); save(); }
function notify(text){ _S.notifications.unshift({ t: String(text), at: new Date().toLocaleString(), read: false }); _S.notifications = _S.notifications.slice(0, 30); }
function audit(action, entity){ _S.audit.unshift({ by: "demo", org: "demo", action: String(action), entity: String(entity || ""), at: new Date().toLocaleString() }); _S.audit = _S.audit.slice(0, 200); }
function uid(prefix){
  var bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return (prefix || "id") + "_" + Array.from(bytes, function (b){ return b.toString(16).padStart(2, "0"); }).join("");
}
async function aiText(prompt, fallback){
  try {
    if (window.root && typeof window.root.generateText === "function") {
      var result = await Promise.race([window.root.generateText(String(prompt)), new Promise(function (_, reject){ setTimeout(function (){ reject(new Error("ai-timeout")); }, 25000); })]);
      return typeof result === "string" ? result : String(result && result.text || result);
    }
  } catch (error) {
    console.warn("IA indisponible", error);
  }
  return fallback;
}
window.KlirStore = {
  get S(){ return _S; }, set S(value){ _S = normalizeState(value); },
  save: save, addActivity: addActivity, notify: notify, audit: audit, uid: uid,
  aiText: aiText, LS: LS, LIMITS: LIMITS, blankState: blankState,
  startDemo: startDemo, deleteAccount: deleteAccount, logoutUser: logoutUser,
  loginUser: disabledAuth, registerUser: disabledAuth,
  loginWithKvFallback: async function(){ return disabledAuth(); },
  restoreKv: async function(){ return null; }, getAccounts: function(){ return {}; },
  saveAccounts: function(){}, userKey: function(){ return ""; },
  mergeHistory: function(){ return { addedS: 0, addedP: 0 }; },
  allBucketStates: function(){ return []; }, recoverOldHistories: function(){ return { totalS: 0, totalP: 0 }; }
};
