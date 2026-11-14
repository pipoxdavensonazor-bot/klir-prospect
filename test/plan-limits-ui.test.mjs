import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const billingSrc = await readFile(new URL("../src/billing.js", import.meta.url), "utf8");
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const store = await readFile(new URL("../src/store.js", import.meta.url), "utf8");
const auth = await readFile(new URL("../src/auth.js", import.meta.url), "utf8");

function load(plan) {
  const window = { KlirAuth: { state: () => ({ user: { id: "u1", email: "a@b.c" } }),
    billingStatus: async () => ({ ok: true, status: { tier: plan.tier, balance: 10, mode: "live", checkout_enabled: true, offers: [] } }),
    planStatus: async () => ({ ok: true, plan }) } };
  vm.runInNewContext(billingSrc, { window, location: { hash: "#/abonnement", search: "" }, document: { getElementById: () => null }, console });
  return window.KlirBilling;
}

test("abonnement : limites affichées depuis le serveur, lots de packs avec date d'expiration", async () => {
  const B = load({ tier: "gratuit", seats: { used: 1, max: 1 }, crm: { used: 40, max: 100 }, ai: { used: 0, max: 0 },
    pack_lots: [{ credits: 500, remaining: 320, expires_at: "2027-11-14T13:45:00Z" }] });
  await B.refresh();
  const html = B.accountBody();
  assert.match(html, /Limites du forfait/);
  assert.match(html, /Utilisateurs<\/span><b>1 \/ 1/);
  assert.match(html, /Fiches CRM<\/span><b>40 \/ 100 fiches/);
  assert.match(html, /Messages IA ce mois-ci<\/span><b>Non inclus/);
  assert.match(html, /320 crédits restants sur 500<\/span><b>Expire le 14 novembre 2027/);
  assert.equal(B.crmRoom(40), 60);
  assert.equal(B.crmRoom(150), 0);
});

test("forfait payant : CRM illimité, IA 50 par mois", async () => {
  const B = load({ tier: "pro", seats: { used: 1, max: 2 }, crm: { used: 300, max: null }, ai: { used: 3, max: 50 }, pack_lots: [] });
  await B.refresh();
  const html = B.accountBody();
  assert.match(html, /Fiches CRM<\/span><b>300 fiches \(illimité\)/);
  assert.match(html, /Messages IA ce mois-ci<\/span><b>3 \/ 50 messages/);
  assert.match(html, /Utilisateurs<\/span><b>1 \/ 2/);
  assert.equal(B.crmRoom(10000), Infinity);
});

test("ajouts CRM et IA passent par les limites du serveur", () => {
  assert.match(app, /function toCrm\(\)\{[^]*?crmRoom\(KS\.S\.crm\.length\)/);
  assert.match(app, /add_to_crm"\)\{const room=window\.KlirBilling\?window\.KlirBilling\.crmRoom/);
  assert.match(store, /KlirAuth\.aiQuota\(1\)/);
  assert.match(auth, /rpc\("ai_quota_consume"/);
  assert.match(auth, /rpc\("plan_status"\)/);
  assert.match(auth, /crm_limit[^]*CRM_LIMIT/);
});
