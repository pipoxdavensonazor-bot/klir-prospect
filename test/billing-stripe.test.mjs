import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { handleStripeBillingWebhook, plausibleSignature, publicKeyFrom } from "../supabase/functions/stripe-webhook/handler.mjs";

const dir = new URL("../supabase/migrations/", import.meta.url);
const all = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
const SECRET = "whsec_" + "a".repeat(32);
const ADA = "11111111-1111-4111-8111-111111111111";
const BEA = "22222222-2222-4222-8222-222222222222";

async function boot() {
  const db = new PGlite();
  await db.exec(`create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create role anon; create role authenticated; create role service_role;
    grant usage on schema public,auth to authenticated,anon;
    create schema vault; create table vault.decrypted_secrets(name text, decrypted_secret text);`);
  for (const f of all) {
    try { await db.exec(await readFile(new URL(f, dir), "utf8")); }
    catch (error) { throw new Error(`${f}: ${error.message}`); }
  }
  await db.query("insert into vault.decrypted_secrets values ('klirprospect_stripe_webhook_test', $1)", [SECRET]);
  await db.exec(`insert into auth.users(id) values ('${ADA}'), ('${BEA}');
    insert into private.billing_settings(project, mode, checkout_enabled, portal_url) values ('test','test',true,'https://billing.stripe.com/p/login/test_abc');
    insert into private.billing_offers values
     ('starter_month','test','starter','subscription','month',1900,600,'price_sm','plink_sm','https://buy.stripe.com/test_sm'),
     ('starter_year','test','starter','subscription','year',18000,600,'price_sy','plink_sy','https://buy.stripe.com/test_sy'),
     ('pro_month','test','pro','subscription','month',3900,2000,'price_pm','plink_pm','https://buy.stripe.com/test_pm'),
     ('pack_500','test',null,'pack',null,1000,500,'price_p5','plink_p5','https://buy.stripe.com/test_p5');`);
  return db;
}
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const sign = (raw, t = Math.floor(Date.now() / 1000), secret = SECRET) =>
  `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex")}`;
let n = 0;
const evt = (type, object, extra = {}) => JSON.stringify({ id: `evt_t${++n}`, object: "event", type, livemode: false, data: { object }, ...extra });
async function ingest(db, raw, header = sign(raw)) {
  return (await one(db, "select public.stripe_webhook_ingest($1,$2) r", [raw, header])).r.outcome;
}
const balance = async (db, u) => (await one(db, "select balance from public.credit_accounts where user_id=$1", [u])).balance;
const tier = async (db, u) => (await one(db, "select tier from private.billing_accounts where user_id=$1", [u])).tier;

test("HMAC-SHA256 SQL identique à Node et signature Stripe vérifiée", async () => {
  const db = await boot();
  for (const msg of ["", "abc", "é".repeat(300)]) {
    const r = await one(db, "select encode(private.hmac_sha256(convert_to($1,'UTF8'), convert_to($2,'UTF8')),'hex') h", [SECRET, msg]);
    assert.equal(r.h, createHmac("sha256", SECRET).update(msg).digest("hex"));
  }
  const raw = evt("ping.test", {});
  const ok = await one(db, "select private.stripe_signature_ok($1,$2,$3) ok", [raw, sign(raw), SECRET]);
  assert.equal(ok.ok, true);
  const tampered = await one(db, "select private.stripe_signature_ok($1,$2,$3) ok", [raw + " ", sign(raw), SECRET]);
  assert.equal(tampered.ok, false);
  const old = await one(db, "select private.stripe_signature_ok($1,$2,$3) ok", [raw, sign(raw, Math.floor(Date.now() / 1000) - 600), SECRET]);
  assert.equal(old.ok, false);
  const wrongKey = await one(db, "select private.stripe_signature_ok($1,$2,$3) ok", [raw, sign(raw, undefined, "whsec_other"), SECRET]);
  assert.equal(wrongKey.ok, false);
  await assert.rejects(ingest(db, raw, sign(raw, undefined, "whsec_other")), /signature_invalide/);
});

test("pack : crédité une seule fois, lien étranger, compte inconnu et mode live ignorés", async () => {
  const db = await boot();
  const session = { id: "cs_test_1", object: "checkout.session", payment_status: "paid", payment_link: "plink_p5", client_reference_id: ADA, customer: "cus_1", mode: "payment" };
  const raw = evt("checkout.session.completed", session);
  assert.equal(await ingest(db, raw), "pack_granted");
  assert.equal(await balance(db, ADA), 700);
  assert.equal(await ingest(db, raw), "duplicate_event");
  assert.equal(await ingest(db, evt("checkout.session.completed", session)), "duplicate");
  assert.equal(await balance(db, ADA), 700);
  assert.equal(await ingest(db, evt("checkout.session.completed", { ...session, id: "cs_test_2", payment_link: "plink_autre" })), "ignored_foreign_link");
  assert.equal(await ingest(db, evt("checkout.session.completed", { ...session, id: "cs_test_3", client_reference_id: "33333333-3333-4333-8333-333333333333" })), "ignored_unknown_user");
  assert.equal(await ingest(db, evt("checkout.session.completed", { ...session, id: "cs_test_4", payment_status: "unpaid" })), "ignored_unpaid");
  // Un événement live exige le secret live (absent ici) : refusé, jamais crédité.
  await assert.rejects(ingest(db, evt("checkout.session.completed", { ...session, id: "cs_test_5" }, { livemode: true })), /signature_invalide/);
  assert.equal(await balance(db, ADA), 700);
  assert.equal(await balance(db, BEA), 200);
});

test("abonnement : démarrage, renouvellement plafonné, mise à niveau, annulation", async () => {
  const db = await boot();
  const now = Math.floor(Date.now() / 1000);
  const start = { id: "cs_test_s", payment_status: "paid", payment_link: "plink_sm", client_reference_id: ADA, customer: "cus_a", subscription: "sub_a", invoice: "in_1", mode: "subscription" };
  // invoice.paid avant la session : ignoré, la session crédite la même facture.
  const inv1 = { id: "in_1", billing_reason: "subscription_create", amount_paid: 1900, parent: { subscription_details: { subscription: "sub_a" } },
    lines: { data: [{ amount: 1900, pricing: { price_details: { price: "price_sm" } }, period: { start: now, end: now + 2592000 } }] } };
  assert.equal(await ingest(db, evt("invoice.paid", inv1)), "ignored_unknown_subscription");
  // Même facture marquée pour ce projet, reçue avant la session : relivraison demandée.
  const inv1p = { ...inv1, parent: { subscription_details: { subscription: "sub_a", metadata: { project: "test" } } } };
  await assert.rejects(ingest(db, evt("invoice.paid", inv1p, { created: Math.floor(Date.now() / 1000) })), /reessayer_plus_tard/);
  assert.equal(await ingest(db, evt("invoice.paid", inv1p, { created: Math.floor(Date.now() / 1000) - 7200 })), "ignored_unknown_subscription");
  assert.equal(await ingest(db, evt("checkout.session.completed", start)), "subscription_started");
  assert.equal(await tier(db, ADA), "starter");
  assert.equal(await balance(db, ADA), 800);
  assert.equal(await ingest(db, evt("invoice.paid", inv1p)), "duplicate");
  assert.ok((await one(db, "select current_period_end from private.stripe_subscriptions where subscription_id='sub_a'")).current_period_end);
  assert.equal(await balance(db, ADA), 800);
  // Renouvellement : 800 + 600 plafonné à 2 × 600.
  const inv2 = { ...inv1, id: "in_2", billing_reason: "subscription_cycle" };
  assert.equal(await ingest(db, evt("invoice.paid", inv2)), "plan_granted");
  assert.equal(await balance(db, ADA), 1200);
  // Mise à niveau vers Pro : différence 2000 - 600 versée, plafond 4000.
  const inv3 = { id: "in_3", billing_reason: "subscription_update", amount_paid: 1500, subscription: "sub_a",
    lines: { data: [{ amount: -1200, price: { id: "price_sm" } }, { amount: 2700, price: { id: "price_pm" }, period: { start: now, end: now + 2592000 } }] } };
  assert.equal(await ingest(db, evt("invoice.paid", inv3)), "upgrade_granted");
  assert.equal(await balance(db, ADA), 2600);
  assert.equal(await tier(db, ADA), "pro");
  // Annulation en fin de période puis suppression : retour au Gratuit, crédits conservés.
  assert.equal(await ingest(db, evt("customer.subscription.updated", { id: "sub_a", status: "active", cancel_at_period_end: true, items: { data: [{ price: { id: "price_pm" }, current_period_end: now + 2592000 }] } })), "tier_pro");
  assert.equal((await one(db, "select cancel_at_period_end c from private.billing_accounts where user_id=$1", [ADA])).c, true);
  assert.equal(await ingest(db, evt("customer.subscription.deleted", { id: "sub_a", status: "canceled", items: { data: [{ price: { id: "price_pm" } }] } })), "tier_gratuit");
  assert.equal(await tier(db, ADA), "gratuit");
  assert.equal(await balance(db, ADA), 2600);
  const grants = await one(db, "select count(*)::int n, sum(credits)::int s from private.credit_grants where user_id=$1", [ADA]);
  assert.deepEqual(grants, { n: 3, s: 2400 });
});

test("Gratuit : remonté à 50 une fois par mois ; annuel : allocation mensuelle", async () => {
  const db = await boot();
  await db.exec(`select set_config('request.jwt.claim.sub', '${BEA}', false)`);
  await db.exec("set role authenticated");
  let s = (await one(db, "select public.billing_status() s")).s;
  assert.equal(s.tier, "gratuit");
  assert.equal(s.balance, 200);
  assert.equal(s.monthly_credits, 50);
  assert.equal(s.offers.length, 4);
  assert.match(s.portal_url, /^https:\/\/billing\.stripe\.com/);
  await assert.rejects(db.query("select * from private.credit_grants"), /permission denied/);
  await assert.rejects(db.query("select public.stripe_webhook_ingest('{}','')"), /permission denied/);
  await db.exec("reset role");
  await db.query("update public.credit_accounts set balance=10 where user_id=$1", [BEA]);
  await db.query("update private.billing_accounts set next_refill_at=now()-interval '1 minute' where user_id=$1", [BEA]);
  await db.exec("set role authenticated");
  s = (await one(db, "select public.billing_status() s")).s;
  assert.equal(s.balance, 50);
  s = (await one(db, "select public.billing_status() s")).s;
  assert.equal(s.balance, 50);
  await db.exec("reset role");
  // Abonnement annuel : deux mois écoulés = deux allocations (plafond 1200).
  const now = Math.floor(Date.now() / 1000);
  await ingest(db, evt("checkout.session.completed", { id: "cs_test_y", payment_status: "paid", payment_link: "plink_sy", client_reference_id: BEA, customer: "cus_b", subscription: "sub_b", invoice: "in_y", mode: "subscription" }));
  assert.equal(await balance(db, BEA), 650);
  await db.query("update private.billing_accounts set next_refill_at=now()-interval '35 days', current_period_end=now()+interval '300 days' where user_id=$1", [BEA]);
  await db.exec("set role authenticated");
  s = (await one(db, "select public.billing_status() s")).s;
  assert.equal(s.tier, "starter");
  assert.equal(s.balance, 1200);
  await db.exec("reset role");
  assert.ok(now > 0);
});

test("paiement fermé : aucun lien de paiement envoyé au navigateur", async () => {
  const db = await boot();
  await db.exec("update private.billing_settings set checkout_enabled=false");
  await db.exec(`select set_config('request.jwt.claim.sub', '${ADA}', false)`);
  await db.exec("set role authenticated");
  const s = (await one(db, "select public.billing_status() s")).s;
  assert.deepEqual(s.offers, []);
  assert.equal(s.portal_url, null);
});

test("fonction Edge : rejette sans signature, relaie le corps brut, 400 si refus", async () => {
  assert.equal(plausibleSignature("t=1794623529,v1=" + "0".repeat(64)), true);
  assert.equal(plausibleSignature("v1=abc"), false);
  assert.equal(publicKeyFrom({ SUPABASE_PUBLISHABLE_KEYS: '{"default":"sb_publishable_x"}' }), "sb_publishable_x");
  assert.equal(publicKeyFrom({ SUPABASE_ANON_KEY: "anon" }), "anon");
  const req = (body, sig) => new Request("https://x/functions/v1/stripe-webhook", { method: "POST", body, headers: sig ? { "stripe-signature": sig } : {} });
  const sig = "t=1794623529,v1=" + "a".repeat(64);
  let seen;
  let res = await handleStripeBillingWebhook(req('{"a":1}', sig), { ingest: async (raw, s) => { seen = [raw, s]; return { data: { outcome: "pack_granted" } }; } });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ['{"a":1}', sig]);
  res = await handleStripeBillingWebhook(req("{}", ""), { ingest: async () => assert.fail() });
  assert.equal(res.status, 400);
  res = await handleStripeBillingWebhook(req("{}", sig), { ingest: async () => ({ error: { message: "signature_invalide" } }) });
  assert.equal(res.status, 400);
  res = await handleStripeBillingWebhook(req("{}", sig), { ingest: async () => ({ error: { message: "boom" } }) });
  assert.equal(res.status, 500);
  res = await handleStripeBillingWebhook(new Request("https://x", { method: "GET" }), { ingest: async () => assert.fail() });
  assert.equal(res.status, 405);
});
