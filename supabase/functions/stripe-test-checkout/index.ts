import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import Stripe from "npm:stripe@18.5.0";
import { readStripeTestRuntime } from "../_shared/stripe-test-offer.mjs";
import { createStripeTestSdkAdapter } from "../_shared/stripe-test-sdk-adapter.mjs";
import { createStripeTestCheckout } from "../_shared/stripe-test-checkout.mjs";
import { bearer, stripeJson, stripeOptions, stripeRuntimeEnv } from "../_shared/stripe-test-http.mjs";

Deno.serve(async (request) => {
  const runtime = readStripeTestRuntime(stripeRuntimeEnv((key) => Deno.env.get(key)));
  const origin = request.headers.get("origin") ?? "";
  if (request.method === "OPTIONS") return stripeOptions(runtime.ok ? runtime.origin : origin);
  if (origin && runtime.ok && origin !== runtime.origin) return stripeJson(403, { outcome: "origin_not_allowed" }, origin);
  if (!runtime.ok) return stripeJson(403, { outcome: runtime.reason }, origin);
  if (request.method !== "POST") return stripeJson(405, { outcome: "method_not_allowed" }, origin);
  const token = bearer(request);
  if (!token) return stripeJson(401, { outcome: "authentication_required" }, origin);
  let body: Record<string, unknown> = {};
  if (request.headers.get("content-length") !== "0") {
    try { body = await request.json(); } catch { return stripeJson(400, { outcome: "invalid_request" }, origin); }
  }
  const admin = createClient(runtime.supabaseUrl, runtime.serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
  const userResult = await admin.auth.getUser(token);
  const user = userResult.data.user;
  if (userResult.error || !user?.email) return stripeJson(401, { outcome: "authentication_required" }, origin);
  const stripe = createStripeTestSdkAdapter({
    Stripe, testSecretKey: runtime.secret, webhookSecret: runtime.webhook, priceId: runtime.priceId
  });
  const begin = createStripeTestCheckout({
    beginOrder: async ({ userId }) => {
      const created = await admin.rpc("stripe_test_begin_order", { p_user: userId, p_order: crypto.randomUUID() });
      if (created.error || !created.data) throw new Error("order");
      return { orderId: created.data.order_id, sessionId: created.data.session_id, url: created.data.url };
    },
    attachSession: async ({ orderId, userId, sessionId, url }) => {
      const saved = await admin.rpc("stripe_test_attach_session", {
        p_order: orderId, p_user: userId, p_session: sessionId, p_url: url
      });
      if (saved.error) throw new Error("attach");
      return { outcome: saved.data };
    },
    createSession: (order) => stripe.createSession({ ...order, origin: runtime.origin })
  });
  const result = await begin({ user: { id: user.id, email: user.email }, body, origin: runtime.origin });
  const payload: Record<string, unknown> = { outcome: result.outcome };
  if (result.url && result.sessionId) {
    payload.url = result.url;
    payload.sessionId = result.sessionId;
  }
  return stripeJson(result.status, payload, origin);
});
