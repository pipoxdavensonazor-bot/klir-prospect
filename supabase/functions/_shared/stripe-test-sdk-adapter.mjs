// Candidate wiring for the official Stripe SDK. Not an endpoint and not deployed.
// Secrets must be supplied by the server's private environment, never the client.
export const STRIPE_TEST_API_VERSION = '2026-09-30.endive';

export function createStripeTestSdkAdapter({Stripe, testSecretKey, webhookSecret, priceId}) {
  if (typeof Stripe !== 'function' || typeof Stripe.createSubtleCryptoProvider !== 'function' ||
      typeof testSecretKey !== 'string' || !/^(?:sk|rk)_test_[A-Za-z0-9]+$/.test(testSecretKey) ||
      typeof webhookSecret !== 'string' || !/^whsec_[A-Za-z0-9]+$/.test(webhookSecret)) {
    throw new Error('Stripe test configuration unavailable');
  }
  const stripe = new Stripe(testSecretKey, {apiVersion: STRIPE_TEST_API_VERSION, telemetry: false});
  const cryptoProvider = Stripe.createSubtleCryptoProvider();
  return Object.freeze({
    verifySignature(rawBody, signature) {
      return stripe.webhooks.constructEventAsync(rawBody, signature, webhookSecret, undefined, cryptoProvider);
    },
    retrieveSession(sessionId) {
      if (!/^cs_test_[A-Za-z0-9_]+$/.test(sessionId || '')) throw new Error('Invalid test session');
      return stripe.checkout.sessions.retrieve(sessionId);
    },
    createSession({orderId, email, origin}) {
      if (typeof priceId !== 'string' || !/^price_[A-Za-z0-9]+$/.test(priceId)) throw new Error('Stripe test configuration unavailable');
      if (!/^https:\/\/[^/]+$/.test(origin || '')) throw new Error('Invalid return origin');
      return stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: email,
        client_reference_id: orderId,
        line_items: [{price: priceId, quantity: 1}],
        success_url: origin + '/#/offre/retour',
        cancel_url: origin + '/#/offre/annule',
        metadata: {order_id: orderId, offer_id: 'klirprospect-pilot-demo'}
      });
    }
  });
}
