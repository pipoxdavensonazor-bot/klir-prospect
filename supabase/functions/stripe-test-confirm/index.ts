import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import Stripe from "npm:stripe@18.5.0";
import { readStripeTestRuntime } from "../_shared/stripe-test-offer.mjs";
import { createStripeTestSdkAdapter } from "../_shared/stripe-test-sdk-adapter.mjs";
import { createStripeTestConfirm } from "../_shared/stripe-test-confirm.mjs";
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
  let body: { sessionId?: string } = {};
  try { body = await request.json(); } catch { return stripeJson(400, { outcome: "invalid_request" }, origin); }
  const admin = createClient(runtime.supabaseUrl, runtime.serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
  const userResult = await admin.auth.getUser(token);
  const user = userResult.data.user;
  if (userResult.error || !user) return stripeJson(401, { outcome: "authentication_required" }, origin);
  const stripe = createStripeTestSdkAdapter({
    Stripe, testSecretKey: runtime.secret, webhookSecret: runtime.webhook, priceId: runtime.priceId
  });
  const confirm = createStripeTestConfirm({
    retrieveSession: (sessionId) => stripe.retrieveSession(sessionId),
    findOrder: async (sessionId) => {
      const found = await admin.rpc("stripe_test_find_order", { p_session: sessionId });
      if (found.error) throw new Error("order");
      if (!found.data) return null;
      return {
        id: found.data.id, userId: found.data.user_id, sessionId: found.data.session_id,
        amountMinor: found.data.amount_minor, currency: found.data.currency
      };
    },
    applyPaidAtomically: async ({ eventId, sessionId, orderId, paymentIntent }) => {
      const applied = await admin.rpc("stripe_test_apply_paid", {
        p_order: orderId, p_session: sessionId, p_event: eventId, p_payment_intent: paymentIntent
      });
      if (applied.error) throw new Error("apply");
      return { outcome: applied.data };
    },
    readAccess: async (userId) => {
      const access = await admin.rpc("stripe_test_read_access", { p_user: userId });
      if (access.error) throw new Error("access");
      return { active: Boolean(access.data?.active), balance: access.data?.balance ?? null };
    }
  });
  const result = await confirm({ user: { id: user.id }, sessionId: body.sessionId || "" });
  return stripeJson(result.status, { outcome: result.outcome, active: result.active, balance: result.balance }, origin);
});
