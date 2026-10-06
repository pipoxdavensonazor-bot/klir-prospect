const OTP_TYPES = ["signup", "email", "recovery", "invite", "magiclink", "email_change"];

export const DELETE_CONFIRMATION = "SUPPRIMER";

export function emailAddress(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length < 3 || email.length > 320) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

export function displayName(value) {
  return String(value || "").trim().replace(/[\u0000-\u001F\u007F]/g, "").slice(0, 120);
}

export function passwordIssue(password) {
  const value = String(password || "");
  if (value.length < 12 || value.length > 72) {
    return "Le mot de passe doit contenir de 12 à 72 caractères.";
  }
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value)) {
    return "Le mot de passe doit contenir une minuscule, une majuscule et un chiffre.";
  }
  return "";
}

export function confirmedDeletion(value) {
  return value === DELETE_CONFIRMATION;
}

export function emailLinkParams(href) {
  const url = new URL(href, "http://127.0.0.1:3000");
  const hash = url.hash || "";
  const hashQuery = hash.includes("?")
    ? new URLSearchParams(hash.slice(hash.indexOf("?") + 1))
    : new URLSearchParams();
  const tokenHash = url.searchParams.get("token_hash") || hashQuery.get("token_hash") || "";
  const type = url.searchParams.get("type") || hashQuery.get("type") || "";
  if (!tokenHash || tokenHash.length > 2048 || !OTP_TYPES.includes(type)) return null;
  const route = (hash.startsWith("#/") ? hash.slice(2) : "").split("?")[0];
  return { tokenHash, type, route };
}

export function deletionFailureMessage(code) {
  const messages = {
    authentication_required: "Mot de passe ou session invalide.",
    confirmation_required: "Écrivez SUPPRIMER pour confirmer.",
    origin_not_allowed: "Origine non autorisée pour la suppression.",
    session_revocation_failed: "Révocation des sessions impossible.",
    account_deletion_failed: "Suppression du compte impossible.",
    service_unavailable: "Suppression indisponible pour le moment."
  };
  return messages[code] || "Suppression impossible.";
}
