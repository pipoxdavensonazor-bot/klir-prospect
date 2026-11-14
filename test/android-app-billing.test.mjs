import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const billingSrc = await readFile(new URL("../src/billing.js", import.meta.url), "utf8");
const authSrc = await readFile(new URL("../src/auth.js", import.meta.url), "utf8");
const appSrc = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

const OFFERS = [
  { offer: "starter_month", kind: "subscription", url: "https://buy.stripe.com/live_sm" },
  { offer: "pro_month", kind: "subscription", url: "https://buy.stripe.com/live_pm" },
  { offer: "equipe_month", kind: "subscription", url: "https://buy.stripe.com/live_em" },
  { offer: "pack_500", kind: "pack", url: "https://buy.stripe.com/live_p5" },
  { offer: "pack_2000", kind: "pack", url: "https://buy.stripe.com/live_p20" }
];

function storage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), _m: m };
}

function load({ tier = "starter", referrer = "", search = "", session = storage(), hash = "#/abonnement" } = {}) {
  const window = { KlirAuth: { state: () => ({ user: { id: "u1", email: "a@b.c" } }),
    billingStatus: async () => ({ ok: true, status: { tier, offer: tier === "gratuit" ? null : tier + "_month", balance: 785, monthly_credits: 600, mode: "live", checkout_enabled: true,
      portal_url: "https://billing.stripe.com/p/login/00wdR94vH3r1e385wn7Zu00", current_period_end: "2026-12-14T13:45:00Z", offers: OFFERS } }),
    planStatus: async () => ({ ok: true, plan: { tier, seats: { used: 1, max: 1 }, crm: { used: 5, max: null }, ai: { used: 0, max: 50 }, pack_lots: [] } }) } };
  vm.runInNewContext(billingSrc, { window, location: { hash, search }, document: { referrer, getElementById: () => null }, sessionStorage: session, console });
  return { B: window.KlirBilling, session };
}

const PAY = /buy\.stripe\.com|billing\.stripe\.com|Gérer mon abonnement<\/a>|Acheter|Choisir (Starter|Pro|Équipe)|Changer via/;

test("site Web : achats et portail inchangés", async () => {
  const { B } = load({ tier: "starter" });
  await B.refresh();
  assert.equal(B.inAndroidApp(), false);
  assert.match(B.accountBody(), /billing\.stripe\.com\/p\/login\//);
  assert.match(B.accountBody(), /buy\.stripe\.com\/live_p5/);
  const free = load({ tier: "gratuit", hash: "#/tarifs" }).B;
  await free.refresh();
  assert.match(free.pricingBody(), /buy\.stripe\.com\/live_sm/);
  assert.doesNotMatch(free.pricingBody(), /kpAndroidNote/);
});

test("app Android (référent android-app://) : aucun lien de paiement, texte neutre sans lien", async () => {
  const { B, session } = load({ tier: "starter", referrer: "android-app://ca.klirline.klirprospect/" });
  await B.refresh();
  assert.equal(B.inAndroidApp(), true);
  assert.equal(session.getItem("klir_android_app"), "1");
  assert.equal(B.checkoutUrl("pack_500"), "");
  assert.equal(B.portalUrl(), "");
  const account = B.accountBody();
  assert.doesNotMatch(account, PAY);
  assert.doesNotMatch(account, /Packs de crédits/);
  assert.match(account, /La gestion de l’abonnement se fait sur le site klirprospect\.klirline\.ca\./);
  assert.doesNotMatch(account, /href="https?:\/\/klirprospect/);
  // Forfait actuel, solde et limites restent affichés.
  assert.match(account, /Forfait<\/span><b>Starter \(mensuel\)/);
  assert.match(account, /Solde<\/span><b>785 crédits/);
  const pricing = B.pricingBody();
  assert.doesNotMatch(pricing, PAY);
  assert.match(pricing, /id="kpAndroidNote"/);
  assert.match(pricing, /Comment les crédits sont utilisés/);
  assert.doesNotMatch(B.CRM_LIMIT_MSG, /passez à Starter/);
});

test("app Android : ?source=twa et mémoire de session (rechargement sans référent)", async () => {
  const s = storage();
  const first = load({ tier: "gratuit", search: "?source=twa", session: s, hash: "#/tarifs" });
  assert.equal(first.B.inAndroidApp(), true);
  const again = load({ tier: "gratuit", session: s, hash: "#/tarifs" });
  await again.B.refresh();
  assert.equal(again.B.inAndroidApp(), true);
  assert.doesNotMatch(again.B.pricingBody(), PAY);
  // Un autre package ou une autre source ne déclenche pas le mode app.
  assert.equal(load({ referrer: "android-app://com.autre.app/" }).B.inAndroidApp(), false);
  assert.equal(load({ search: "?source=twax" }).B.inAndroidApp(), false);
});

test("mode app : sessionStorage seulement (jamais localStorage) ; achats de test et message CRM neutralisés", () => {
  assert.doesNotMatch(billingSrc, /localStorage\.setItem\(ANDROID_APP_KEY/);
  assert.match(authSrc, /function androidAppMode\(\)/);
  assert.match(authSrc, /if \(androidAppMode\(\) \|\| !overturePreview\(\)/);
  assert.match(authSrc, /androidAppMode\(\) \? "\." : " ; passez à Starter pour en ajouter\."/);
  assert.match(appSrc, /function stripeCheckoutEnabled\(\)\{const config=window\.__KLIR_CONFIG__\|\|\{\};if\(window\.KlirBilling&&window\.KlirBilling\.inAndroidApp&&window\.KlirBilling\.inAndroidApp\(\)\)return false;/);
});
