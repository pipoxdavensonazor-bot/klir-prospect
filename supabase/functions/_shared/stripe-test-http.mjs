export function stripeJson(status, body, origin = "") {
  const headers = { "content-type": "application/json; charset=utf-8" };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "origin";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function stripeOptions(origin) {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization, apikey, content-type, stripe-signature",
      "access-control-allow-methods": "POST",
      vary: "origin"
    }
  });
}

const RUNTIME_KEYS = [
  "STRIPE_TEST_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "STRIPE_TEST_PRICE_ID", "ALLOWED_ORIGIN",
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "STRIPE_TEST_CHECKOUT_ENABLED", "KLIR_ENV"
];

export function stripeRuntimeEnv(get) {
  const env = {};
  for (const key of RUNTIME_KEYS) env[key] = get(key) || "";
  return env;
}

export function bearer(request) {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}
