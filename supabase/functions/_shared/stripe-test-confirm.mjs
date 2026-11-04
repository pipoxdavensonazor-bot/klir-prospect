import { STRIPE_TEST_OFFER } from "./stripe-test-offer.mjs";

export function createStripeTestConfirm({retrieveSession, findOrder, applyPaidAtomically, readAccess}) {
  for (const dependency of [retrieveSession, findOrder, applyPaidAtomically, readAccess]) {
    if (typeof dependency !== "function") throw new TypeError("Missing server dependency");
  }
  return async function confirm({user, sessionId}) {
    if (!user || typeof user.id !== "string" || !user.id) return { status: 401, outcome: "authentication_required" };
    if (sessionId != null && sessionId !== "" && !/^cs_test_[A-Za-z0-9_]+$/.test(sessionId)) {
      return { status: 400, outcome: "invalid_session" };
    }
    try {
      const access = async (outcome) => {
        const state = await readAccess(user.id);
        return {
          status: 200,
          outcome,
          active: Boolean(state && state.active),
          balance: state && Number.isSafeInteger(state.balance) ? state.balance : null
        };
      };
      if (!sessionId) return access("not_paid");
      const order = await findOrder(sessionId);
      if (!order || order.userId !== user.id || order.sessionId !== sessionId || order.amountMinor !== STRIPE_TEST_OFFER.amountMinor || order.currency !== STRIPE_TEST_OFFER.currency) {
        return { status: 409, outcome: "order_mismatch", active: false, balance: null };
      }
      const session = await retrieveSession(sessionId);
      if (!session || session.id !== sessionId || session.livemode !== false || session.mode !== "payment" ||
          session.amount_total !== order.amountMinor || session.currency !== order.currency ||
          session.status !== "complete" || session.payment_status !== "paid" ||
          typeof session.payment_intent !== "string" || !/^pi_test_[A-Za-z0-9_]+$/.test(session.payment_intent)) {
        return access("not_paid");
      }
      const applied = await applyPaidAtomically({
        eventId: "evt_confirm_" + sessionId.replace(/[^A-Za-z0-9_]/g, ""),
        sessionId,
        orderId: order.id,
        paymentIntent: session.payment_intent
      });
      if (!applied || !["applied", "duplicate"].includes(applied.outcome)) throw new Error("Uncertain transaction");
      return access(applied.outcome);
    } catch {
      return { status: 503, outcome: "retry_required", active: false, balance: null };
    }
  };
}
