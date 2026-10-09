var LS = "klir_demo_session_v3";
var DEMO_STASH = "klir_demo_stash_v1";
var OUTBOX = "klir_search_outbox_v1";
var cloudTimer = 0;
var cloudSeq = 0;
var cloudStatus = "idle";
var cloudError = "";
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
  s.demo = !trustedLive;
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
var trustedLive = false;
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
  scheduleCloudPersist();
}
function writeOutbox(snapshot) {
  var userId = snapshot && snapshot.user && snapshot.user.id;
  if (!userId) return;
  try {
    sessionStorage.setItem(OUTBOX, JSON.stringify({ userId: userId, payload: snapshot, at: Date.now() }));
  } catch (error) {
    console.warn("File d'attente locale impossible", error);
  }
}
function readOutbox() {
  try {
    var raw = sessionStorage.getItem(OUTBOX);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}
function clearOutbox() {
  try { sessionStorage.removeItem(OUTBOX); } catch (error) { /* déjà absente */ }
}
function noteCloudFailure(seq, snapshot, message) {
  if (seq !== cloudSeq) return;
  cloudStatus = "error";
  cloudError = message || "Enregistrement impossible.";
  writeOutbox(snapshot);
  notify("Enregistrement du compte impossible. La recherche reste sur cet appareil et sera réessayée.");
}
function noteCloudSuccess(seq) {
  if (seq !== cloudSeq) return;
  cloudStatus = "saved";
  cloudError = "";
  clearOutbox();
}
function sendCloud(seq, snapshot, attempt) {
  if (seq !== cloudSeq) return;
  Promise.resolve(window.KlirAuth.persistWorkspace(snapshot)).then(function (result) {
    if (seq !== cloudSeq) return;
    if (result && result.error) {
      if (attempt < 2) {
        cloudTimer = setTimeout(function () { sendCloud(seq, snapshot, attempt + 1); }, 700 * (attempt + 1));
        return;
      }
      noteCloudFailure(seq, snapshot, result.error.message);
      return;
    }
    noteCloudSuccess(seq);
  }).catch(function (error) {
    if (seq !== cloudSeq) return;
    if (attempt < 2) {
      cloudTimer = setTimeout(function () { sendCloud(seq, snapshot, attempt + 1); }, 700 * (attempt + 1));
      return;
    }
    noteCloudFailure(seq, snapshot, error && error.message);
  });
}
function scheduleCloudPersist() {
  if (!trustedLive || !window.KlirAuth || typeof window.KlirAuth.persistWorkspace !== "function") return;
  var seq = ++cloudSeq;
  var snapshot = structuredClone(_S);
  cloudStatus = "saving";
  cloudError = "";
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(function () { sendCloud(seq, snapshot, 0); }, 400);
}
function flushCloudPersist() {
  if (!trustedLive || !window.KlirAuth || typeof window.KlirAuth.persistWorkspace !== "function") {
    return Promise.resolve({ data: null, error: { message: "Session de compte requise." } });
  }
  var seq = ++cloudSeq;
  clearTimeout(cloudTimer);
  var snapshot = structuredClone(_S);
  cloudStatus = "saving";
  return Promise.resolve().then(function () {
    return window.KlirAuth.persistWorkspace(snapshot);
  }).then(function (result) {
    if (result && result.error) {
      noteCloudFailure(seq, snapshot, result.error.message);
      return result;
    }
    noteCloudSuccess(seq);
    return result || { data: {}, error: null };
  }).catch(function (error) {
    noteCloudFailure(seq, snapshot, error && error.message);
    return { data: null, error: { message: cloudError } };
  });
}
function pendingOutbox(userId) {
  var box = readOutbox();
  if (!box || !userId || box.userId !== userId || !box.payload) return null;
  return box.payload;
}
function cloudSyncState() {
  return { status: cloudStatus, error: cloudError };
}
function removeSearch(id) {
  _S.searches = (_S.searches || []).filter(function (item) { return item.id !== id; });
  _S.prospects = (_S.prospects || []).filter(function (item) { return item.searchId !== id; });
  save();
}
function stashDemoState() {
  try {
    sessionStorage.setItem(DEMO_STASH, JSON.stringify(_S));
  } catch (error) {
    console.warn("Démo locale non conservée", error);
  }
}
function peekDemoStash() {
  try {
    var raw = sessionStorage.getItem(DEMO_STASH);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    return null;
  }
}
function takeDemoStash() {
  var stashed = peekDemoStash();
  sessionStorage.removeItem(DEMO_STASH);
  return stashed;
}
function setTrustedLive(on){
  trustedLive = !!on;
  if (_S) _S.demo = !trustedLive;
}
function startDemo(){
  trustedLive = false;
  _S = blankState();
  _S.user = { email: "demo@local.invalid" };
  _S.org = { name: "Espace de démonstration", city: "Montréal" };
  save();
  return { ok: true };
}
function disabledAuth(){
  return { err: "Authentification désactivée : un backend avec sessions HttpOnly est requis." };
}
function logoutUser(){ trustedLive = false; _S = blankState(); sessionStorage.removeItem(LS); }
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
  startDemo: startDemo, setTrustedLive: setTrustedLive, deleteAccount: deleteAccount, logoutUser: logoutUser,
  stashDemoState: stashDemoState, peekDemoStash: peekDemoStash, takeDemoStash: takeDemoStash,
  flushCloudPersist: flushCloudPersist, pendingOutbox: pendingOutbox, cloudSyncState: cloudSyncState, removeSearch: removeSearch,
  loginUser: disabledAuth, registerUser: disabledAuth,
  loginWithKvFallback: async function(){ return disabledAuth(); },
  restoreKv: async function(){ return null; }, getAccounts: function(){ return {}; },
  saveAccounts: function(){}, userKey: function(){ return ""; },
  mergeHistory: function(){ return { addedS: 0, addedP: 0 }; },
  allBucketStates: function(){ return []; }, recoverOldHistories: function(){ return { totalS: 0, totalP: 0 }; }
};
