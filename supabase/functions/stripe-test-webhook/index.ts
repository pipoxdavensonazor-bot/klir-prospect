import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import Stripe from "npm:stripe@18.5.0";
import { readStripeTestRuntime } from "../_shared/stripe-test-offer.mjs";
import { createStripeTestSdkAdapter } from "../_shared/stripe-test-sdk-adapter.mjs";
import { createStripeTestWebhook } from "../_shared/stripe-test-candidate.mjs";
import { stripeJson, stripeRuntimeEnv } from "../_shared/stripe-test-http.mjs";

Deno.serve(async (request) => {
  const runtime = readStripeTestRuntime(stripeRuntimeEnv((key) => Deno.env.get(key)));
  if (!runtime.ok) return stripeJson(403, { outcome: runtime.reason });
  if (request.method !== "POST") return stripeJson(405, { outcome: "method_not_allowed" });
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature") ?? "";
  const admin = createClient(runtime.supabaseUrl, runtime.serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
  const stripe = createStripeTestSdkAdapter({
    Stripe, testSecretKey: runtime.secret, webhookSecret: runtime.webhook, priceId: runtime.priceId
  });
  const handle = createStripeTestWebhook({
    verifySignature: (body, header) => stripe.verifySignature(body, header),
    retrieveSession: (sessionId) => stripe.retrieveSession(sessionId),
    findOrder: async (sessionId) => {
      const found = await admin.rpc("stripe_test_find_order", { p_session: sessionId });
      if (found.error) throw new Error("order");
      if (!found.data) return null;
      return {
        id: found.data.id, userId: found.data.user_id, sessionId: found.data.session_id, offerId: found.data.offer_id,
        amountMinor: found.data.amount_minor, currency: found.data.currency
      };
    },
    applyPaidAtomically: async ({ eventId, sessionId, orderId, paymentIntent }) => {
      const applied = await admin.rpc("stripe_test_apply_paid", {
        p_order: orderId, p_session: sessionId, p_event: eventId, p_payment_intent: paymentIntent || null
      });
      if (applied.error) throw new Error("apply");
      return { outcome: applied.data };
    },
    findRefundOrder: async (paymentIntent) => {
      const found = await admin.rpc("stripe_test_find_refund", { p_payment_intent: paymentIntent });
      if (found.error) throw new Error("refund");
      if (!found.data) return null;
      return { id: found.data.id, paymentIntent: found.data.payment_intent, amountMinor: found.data.amount_minor };
    },
    applyRefundAtomically: async ({ eventId, orderId, amountMinor }) => {
      const refunded = await admin.rpc("stripe_test_refund_full", { p_order: orderId, p_event: eventId, p_refunded_minor: amountMinor });
      if (refunded.error) {
        const message = refunded.error.message || "";
        if (/refund_needs_review/.test(message)) return { outcome: "review" };
        throw new Error("refund");
      }
      return { outcome: refunded.data };
    }
  });
  const result = await handle({ rawBody, signature });
  return stripeJson(result.status, { outcome: result.outcome });
});
