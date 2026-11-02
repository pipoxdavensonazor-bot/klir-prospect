// Candidate wiring for the official Stripe SDK. Not an endpoint and not deployed.
// Secrets must be supplied by the server's private environment, never the client.
export const STRIPE_TEST_API_VERSION = '2026-09-30.endive';

export function createStripeTestSdkAdapter({Stripe, testSecretKey, webhookSecret}) {
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
    }
  });
}
