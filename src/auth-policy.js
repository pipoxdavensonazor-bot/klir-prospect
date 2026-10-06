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
