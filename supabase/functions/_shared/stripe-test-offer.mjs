export const STRIPE_TEST_PROJECT_URL = "https://pwakjxjjxswdjsapsbxn.supabase.co";
export const STRIPE_TEST_PRODUCTION_ORIGIN = "https://klirprospect.klirline.ca";
export const STRIPE_TEST_OFFER = Object.freeze({
  offerId: "klirprospect-pilot-demo",
  productName: "KlirProspect — pilote accompagné (DÉMO)",
  amountMinor: 4900,
  currency: "cad",
  durationDays: 30,
  // Lot technique aligné sur le plafond actuel du registre (10 recherches
  // complètes × 9 crédits). Ce n'est pas un quota commercial de 30 jours.
  credits: 90
});

const CLIENT_TERMS = new Set(["amount", "amountMinor", "credits", "currency", "price", "priceId", "paid", "payment_status", "livemode"]);

export function rejectClientTerms(body) {
  if (body == null || body === "") return false;
  if (typeof body !== "object" || Array.isArray(body)) return true;
  return Object.keys(body).some((key) => CLIENT_TERMS.has(key));
}

export function previewCheckoutFlag(environment, flag) {
  const enabled = flag === "1";
  if (enabled && environment !== "preview") {
    throw new Error("STRIPE_TEST_CHECKOUT_ENABLED n'est accepté qu'en prévisualisation.");
  }
  return enabled && environment === "preview";
}

export function readStripeTestRuntime(env = {}) {
  const secret = String(env.STRIPE_TEST_SECRET_KEY || "");
  const webhook = String(env.STRIPE_WEBHOOK_SECRET || "");
  const priceId = String(env.STRIPE_TEST_PRICE_ID || "");
  const origin = String(env.ALLOWED_ORIGIN || "").replace(/\/+$/, "");
  const supabaseUrl = String(env.SUPABASE_URL || "").replace(/\/+$/, "");
  const serviceRole = String(env.SUPABASE_SERVICE_ROLE_KEY || "");
  if (/_live_/.test(secret) || /_live_/.test(webhook) || /_live_/.test(priceId)) {
    return { ok: false, reason: "live_key_rejected" };
  }
  const ready = env.STRIPE_TEST_CHECKOUT_ENABLED === "1"
    && env.KLIR_ENV === "preview"
    && supabaseUrl === STRIPE_TEST_PROJECT_URL
    && /^(?:sk|rk)_test_[A-Za-z0-9]+$/.test(secret)
    && /^whsec_[A-Za-z0-9]+$/.test(webhook)
    && /^price_[A-Za-z0-9]+$/.test(priceId)
    && /^https:\/\/[^/]+$/.test(origin)
    && origin !== STRIPE_TEST_PRODUCTION_ORIGIN
    && serviceRole.length > 0;
  if (!ready) return { ok: false, reason: "purchases_closed" };
  return { ok: true, secret, webhook, priceId, origin, supabaseUrl, serviceRole };
}
