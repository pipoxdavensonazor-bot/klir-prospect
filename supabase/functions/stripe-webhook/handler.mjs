// Webhook Stripe de facturation KlirProspect. La fonction Edge ne détient aucun
// secret : elle transmet le corps brut et l'en-tête Stripe-Signature à
// public.stripe_webhook_ingest, qui vérifie la signature HMAC-SHA256 avec le
// secret rangé dans Supabase Vault, puis attribue les crédits une seule fois.

const MAX_BODY = 1_000_000;

export function billingJson(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

export function plausibleSignature(header) {
  const value = String(header || "");
  return /(?:^|,)\s*t=\d{9,11}(?:,|$)/.test(value) && /(?:^|,)\s*v1=[0-9a-f]{64}(?:,|$)/.test(value);
}

export function publicKeyFrom(env) {
  const dictionary = String(env.SUPABASE_PUBLISHABLE_KEYS || "").trim();
  if (dictionary) {
    try {
      const parsed = JSON.parse(dictionary);
      if (parsed && typeof parsed.default === "string" && parsed.default.trim()) return parsed.default.trim();
    } catch {
      // repli sur les autres noms
    }
  }
  return String(env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "").trim();
}

export async function handleStripeBillingWebhook(request, { ingest }) {
  if (request.method !== "POST") return billingJson(405, { outcome: "method_not_allowed" });
  const signature = request.headers.get("stripe-signature") || "";
  if (!plausibleSignature(signature)) return billingJson(400, { outcome: "signature_invalide" });
  const raw = await request.text();
  if (!raw || raw.length > MAX_BODY) return billingJson(400, { outcome: "charge_invalide" });
  let result;
  try {
    result = await ingest(raw, signature);
  } catch {
    return billingJson(500, { outcome: "erreur_temporaire" });
  }
  if (result && result.error) {
    const message = String(result.error.message || "");
    if (/signature_invalide|evenement_invalide|charge_invalide/.test(message)) {
      return billingJson(400, { outcome: "signature_invalide" });
    }
    return billingJson(500, { outcome: "erreur_temporaire" });
  }
  const outcome = result && result.data && typeof result.data.outcome === "string" ? result.data.outcome : "ok";
  return billingJson(200, { received: true, outcome });
}
