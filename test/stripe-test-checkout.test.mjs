import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createStripeTestCheckout } from "../supabase/functions/_shared/stripe-test-checkout.mjs";
import { createStripeTestConfirm } from "../supabase/functions/_shared/stripe-test-confirm.mjs";
import { previewCheckoutFlag, readStripeTestRuntime, STRIPE_TEST_PROJECT_URL } from "../supabase/functions/_shared/stripe-test-offer.mjs";

const user = { id: "user_fixture", email: "ada@example.com" };
const origin = "https://preview.example.test";

function checkoutFixture() {
  const calls = { begin: 0, attach: 0, create: 0 };
  const begin = createStripeTestCheckout({
    beginOrder: async () => {
      calls.begin += 1;
      if (calls.begin > 1) return { orderId: "order_fixture", sessionId: "cs_test_fixture", url: "https://checkout.stripe.com/c/pay/cs_test_fixture" };
      return { orderId: "order_fixture" };
    },
    attachSession: async () => { calls.attach += 1; return { outcome: "attached" }; },
    createSession: async (request) => {
      calls.create += 1;
      assert.equal(request.orderId, "order_fixture");
      assert.equal(request.email, user.email);
      assert.equal(request.amount, undefined);
      assert.equal(request.credits, undefined);
      return { id: "cs_test_fixture", url: "https://checkout.stripe.com/c/pay/cs_test_fixture", livemode: false, mode: "payment", amount_total: 4900, currency: "cad" };
    }
  });
  return { begin, calls };
}

test("le navigateur ne peut pas imposer le prix, et un second clic réutilise la session", async () => {
  const { begin, calls } = checkoutFixture();
  assert.equal((await begin({ user, body: { credits: 1000, amount: 1 }, origin })).outcome, "client_terms_rejected");
  assert.equal(calls.begin, 0);
  const created = await begin({ user, body: {}, origin });
  assert.equal(created.outcome, "created");
  assert.equal(created.url.startsWith("https://checkout.stripe.com/"), true);
  const again = await begin({ user, body: {}, origin });
  assert.equal(again.outcome, "existing");
  assert.equal(calls.create, 1);
  assert.equal(calls.attach, 1);
});

test("un montant Stripe différent du prix serveur n'attache pas la session", async () => {
  const { begin, calls } = checkoutFixture();
  begin.createSession = null;
  const rejected = createStripeTestCheckout({
    beginOrder: async () => ({ orderId: "order_fixture" }),
    attachSession: async () => { throw new Error("ne pas attacher"); },
    createSession: async () => ({ id: "cs_test_fixture", url: "https://checkout.stripe.com/c/pay/cs_test_fixture", livemode: false, mode: "payment", amount_total: 100, currency: "cad" })
  });
  assert.equal((await rejected({ user, body: {}, origin })).outcome, "price_mismatch");
  assert.equal(calls.attach, 0);
});

test("confirmation serveur : impayé, puis un seul accès", async () => {
  let applies = 0;
  const confirm = createStripeTestConfirm({
    retrieveSession: async () => ({ id: "cs_test_fixture", livemode: false, mode: "payment", amount_total: 4900, currency: "cad", status: "open", payment_status: "unpaid", payment_intent: "pi_test_fixture" }),
    findOrder: async () => ({ id: "order_fixture", userId: user.id, sessionId: "cs_test_fixture", amountMinor: 4900, currency: "cad" }),
    applyPaidAtomically: async () => { applies += 1; return { outcome: "applied" }; },
    readAccess: async () => ({ active: false, balance: 200 })
  });
  const unpaid = await confirm({ user, sessionId: "cs_test_fixture" });
  assert.equal(unpaid.outcome, "not_paid");
  assert.equal(unpaid.active, false);
  assert.equal(applies, 0);
});

test("les clés réelles et la production laissent l'achat fermé sans recopier le secret", () => {
  const secret = "sk_live_doNotPrint";
  const closed = readStripeTestRuntime({
    STRIPE_TEST_SECRET_KEY: secret,
    STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    STRIPE_TEST_PRICE_ID: "price_fixture",
    ALLOWED_ORIGIN: origin,
    SUPABASE_URL: STRIPE_TEST_PROJECT_URL,
    SUPABASE_SERVICE_ROLE_KEY: "service",
    STRIPE_TEST_CHECKOUT_ENABLED: "1",
    KLIR_ENV: "preview"
  });
  assert.equal(closed.reason, "live_key_rejected");
  assert.equal(JSON.stringify(closed).includes("doNotPrint"), false);
  assert.equal(previewCheckoutFlag("preview", undefined), false);
  assert.throws(() => previewCheckoutFlag("production", "1"), /prévisualisation/);
  const missing = readStripeTestRuntime({ KLIR_ENV: "preview", SUPABASE_URL: STRIPE_TEST_PROJECT_URL });
  assert.equal(missing.reason, "purchases_closed");
});

test("la page d'offre ne contient pas de clé et garde le bouton fermé par défaut", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const auth = await readFile(new URL("../src/auth.js", import.meta.url), "utf8");
  assert.equal(app.includes("sk_live_"), false);
  assert.equal(app.includes("sk_test_"), false);
  assert.match(app, /id="stripeTestCheckoutBtn"/);
  assert.match(app, /Paiement de démonstration indisponible/);
  assert.match(auth, /functions\.invoke\("stripe-test-checkout", \{ body: \{\} \}\)/);
  assert.match(auth, /functions\.invoke\("stripe-test-confirm", \{ body: \{ sessionId: sessionId \|\| "" \} \}\)/);
});
