import { STRIPE_TEST_OFFER, rejectClientTerms } from "./stripe-test-offer.mjs";

function checkoutUrl(value) {
  return typeof value === "string" && /^https:\/\/checkout\.stripe\.com\/(?:c\/pay\/)?cs_test_[A-Za-z0-9_]+/.test(value);
}

export function createStripeTestCheckout({beginOrder, attachSession, createSession}) {
  for (const dependency of [beginOrder, attachSession, createSession]) {
    if (typeof dependency !== "function") throw new TypeError("Missing server dependency");
  }
  return async function begin({user, body, origin}) {
    if (!user || typeof user.id !== "string" || !user.id || typeof user.email !== "string" || !user.email.includes("@")) {
      return { status: 401, outcome: "authentication_required" };
    }
    if (rejectClientTerms(body)) return { status: 400, outcome: "client_terms_rejected" };
    try {
      const pending = await beginOrder({ userId: user.id });
      if (!pending || typeof pending.orderId !== "string" || !pending.orderId) throw new Error("Uncertain order");
      if (pending.sessionId && pending.url) {
        if (!/^cs_test_[A-Za-z0-9_]+$/.test(pending.sessionId) || !checkoutUrl(pending.url)) {
          return { status: 409, outcome: "order_mismatch" };
        }
        return { status: 200, outcome: "existing", url: pending.url, sessionId: pending.sessionId };
      }
      const session = await createSession({ orderId: pending.orderId, email: user.email, origin });
      if (!session || session.livemode !== false || session.mode !== "payment" || session.amount_total !== STRIPE_TEST_OFFER.amountMinor ||
          session.currency !== STRIPE_TEST_OFFER.currency || !/^cs_test_[A-Za-z0-9_]+$/.test(session.id || "") || !checkoutUrl(session.url)) {
        return { status: 409, outcome: "price_mismatch" };
      }
      const saved = await attachSession({ orderId: pending.orderId, userId: user.id, sessionId: session.id, url: session.url });
      if (!saved || (saved.outcome !== "attached" && saved.outcome !== "duplicate")) throw new Error("Uncertain session");
      return { status: 200, outcome: saved.outcome === "duplicate" ? "existing" : "created", url: session.url, sessionId: session.id };
    } catch {
      return { status: 503, outcome: "retry_required" };
    }
  };
}
