export const CONFIRM_PHRASE = "SUPPRIMER";

const OTP_TYPES = new Set(["signup", "email", "recovery", "invite", "magiclink", "email_change"]);
const SECRET_KEYS = new Set([
  "password", "pass", "token", "apikey", "api_key", "key", "secret",
  "service_role", "user", "authorization"
]);

export function passwordIssues(password) {
  const value = String(password || "");
  const issues = [];
  if (value.length < 12) issues.push("length");
  if (!/[a-z]/.test(value)) issues.push("lower");
  if (!/[A-Z]/.test(value)) issues.push("upper");
  if (!/[0-9]/.test(value)) issues.push("digit");
  return issues;
}

export function passwordMessage() {
  return "Le mot de passe doit contenir au moins 12 caractères, une minuscule, une majuscule et un chiffre.";
}

export function displayName(value) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F<>]/g, "")
    .trim()
    .slice(0, 120);
}

export function appRedirectUrl(origin, pathname) {
  const base = String(origin || "").replace(/\/$/, "");
  let path = String(pathname || "/");
  if (path === "/index.html") path = "/";
  if (!path.startsWith("/")) path = `/${path}`;
  return `${base}${path}`;
}

export function parseAuthCallback(search) {
  const params = new URLSearchParams(String(search || "").replace(/^\?/, ""));
  const tokenHash = params.get("token_hash") || "";
  const type = params.get("type") || "";
  if (!tokenHash || tokenHash.length > 2048 || !OTP_TYPES.has(type)) return null;
  return { tokenHash, type };
}

function stripSecrets(value, depth) {
  if (depth > 12 || value == null) return null;
  if (Array.isArray(value)) return value.slice(0, 10000).map((item) => stripSecrets(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).slice(0, 500)) {
      if (SECRET_KEYS.has(String(key).toLowerCase())) continue;
      out[key] = stripSecrets(value[key], depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return value.replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 5000);
  if (typeof value === "number" || typeof value === "boolean") return value;
  return null;
}

export function workspaceForMigration(payload) {
  const clean = stripSecrets(payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {}, 0);
  return clean && typeof clean === "object" ? clean : {};
}

export function isLiveProfile(profile) {
  return Boolean(profile && profile.demo_migrated_at);
}

function localEmail(local) {
  const email = local && local.user && local.user.email;
  return email ? String(email) : "";
}

function isAccountState(local, accountEmail) {
  const email = localEmail(local);
  if (!email || email === "demo@local.invalid") return false;
  if (accountEmail && email !== accountEmail) return false;
  return true;
}

export function accountSessionPlan(localState, cloudRow, accountEmail) {
  const local = localState && typeof localState === "object" && !Array.isArray(localState) ? localState : {};
  const sessionEmail = accountEmail ? String(accountEmail) : "";
  const payload = cloudRow && cloudRow.payload && typeof cloudRow.payload === "object" && !Array.isArray(cloudRow.payload)
    ? cloudRow.payload
    : null;
  if (payload && isAccountState(local, sessionEmail)) {
    const localSaved = Number(local._savedAt) || 0;
    const cloudSaved = cloudRow.updated_at ? Date.parse(cloudRow.updated_at) : 0;
    if (localSaved > cloudSaved) return { source: "local", state: local, stashDemo: false };
  }
  if (payload) return { source: "cloud", state: payload, stashDemo: false };
  if (isAccountState(local, sessionEmail)) return { source: "local", state: local, stashDemo: false };
  const foreign = Boolean(sessionEmail && localEmail(local) && localEmail(local) !== "demo@local.invalid" && localEmail(local) !== sessionEmail);
  const searches = Array.isArray(local.searches) ? local.searches.length : 0;
  const prospects = Array.isArray(local.prospects) ? local.prospects.length : 0;
  return { source: "empty", state: null, stashDemo: !foreign && searches + prospects > 0 };
}

function rowsById(list) {
  const ids = new Set();
  const rows = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || !item.id || ids.has(String(item.id))) continue;
    ids.add(String(item.id));
    rows.push(item);
  }
  return rows;
}

export function mergeWorkspace(base, incoming) {
  const account = base && typeof base === "object" && !Array.isArray(base) ? { ...base } : {};
  const extra = incoming && typeof incoming === "object" && !Array.isArray(incoming) ? incoming : {};
  for (const key of ["searches", "prospects", "crm"]) {
    account[key] = rowsById([...(Array.isArray(account[key]) ? account[key] : []), ...(Array.isArray(extra[key]) ? extra[key] : [])]);
  }
  return account;
}

export function describeSearch(search) {
  const item = search && typeof search === "object" ? search : {};
  const params = item.params && typeof item.params === "object" ? item.params : {};
  const city = params.city && typeof params.city === "object" && params.city.city ? params.city.city : "";
  return {
    keywords: String(item.query || params.raw || ""),
    date: item.date ? String(item.date) : "",
    status: String(item.status || (Number(item.total) > 0 ? "terminée" : "enregistrée")),
    industry: params.industry ? String(params.industry) : "",
    city: city || (params.cityKey ? String(params.cityKey) : ""),
    size: params.size ? String(params.size) : "",
    quantity: params.quantity ? String(params.quantity) : "",
    web: params.webFilter && typeof params.webFilter === "object"
      ? Object.keys(params.webFilter).filter((key) => params.webFilter[key])
      : []
  };
}
