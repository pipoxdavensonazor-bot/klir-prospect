// Undeployed test-mode candidate. Callers MUST supply Stripe's official SDK
// signature verifier and an atomic server-side order repository. This module
// neither exposes an HTTP endpoint nor creates, verifies, or grants real orders.
export function createStripeTestWebhook({verifySignature, retrieveSession, findOrder, applyPaidAtomically}) {
  for (const dependency of [verifySignature, retrieveSession, findOrder, applyPaidAtomically]) {
    if (typeof dependency !== 'function') throw new TypeError('Missing server dependency');
  }
  return async function handle({rawBody, signature}) {
    if (typeof rawBody !== 'string' || rawBody.length > 1024 * 1024 || typeof signature !== 'string' || !signature) {
      return {status: 400, outcome: 'invalid_request'};
    }
    let event;
    try { event = await verifySignature(rawBody, signature); }
    catch { return {status: 400, outcome: 'invalid_signature'}; }
    if (!event || event.livemode !== false || !/^evt_[A-Za-z0-9_]+$/.test(event.id || '') || event.account) {
      return {status: 400, outcome: 'invalid_event'};
    }
    if (typeof event.type === 'string' && /^(?:charge\.refunded$|charge\.refund\.|charge\.dispute\.|refund\.)/.test(event.type)) {
      // Do not acknowledge financial reversals until reconciliation exists.
      return {status: 503, outcome: 'reconciliation_required'};
    }
    if (!['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)) {
      return {status: 200, outcome: 'not_fulfilled'};
    }
    const sessionId = event.data?.object?.id;
    if (!/^cs_test_[A-Za-z0-9_]+$/.test(sessionId || '')) return {status: 400, outcome: 'invalid_session'};
    try {
      // A signed event is not sufficient proof of a settled payment: retrieve
      // the session independently and compare to the server-owned order.
      const session = await retrieveSession(sessionId);
      const order = await findOrder(sessionId);
      if (!session || session.id !== sessionId || session.livemode !== false || session.mode !== 'payment' ||
          session.status !== 'complete' || session.payment_status !== 'paid') {
        return {status: 200, outcome: 'not_paid'};
      }
      if (!order || typeof order.id !== 'string' || !order.id || order.sessionId !== sessionId || !order.userId || !order.offerId ||
          !Number.isSafeInteger(order.amountMinor) || order.amountMinor <= 0 ||
          !/^[a-z]{3}$/.test(order.currency || '') || session.amount_total !== order.amountMinor ||
          session.currency !== order.currency) {
        return {status: 409, outcome: 'order_mismatch'};
      }
      // The real repository must transactionally deduplicate BOTH event and
      // order, grant at most once, and return the persisted outcome on retries.
      const result = await applyPaidAtomically({eventId: event.id, sessionId, orderId: order.id});
      if (!result || !['applied', 'duplicate'].includes(result.outcome)) throw new Error('Uncertain transaction');
      return {status: 200, outcome: result.outcome};
    } catch {
      // No exception body or credentials in responses/logs. Retrying the same
      // event is safe ONLY when the repository satisfies the contract above.
      return {status: 503, outcome: 'retry_required'};
    }
  };
}
