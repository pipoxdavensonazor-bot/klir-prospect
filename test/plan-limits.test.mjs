import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const dir = new URL("../supabase/migrations/", import.meta.url);
const all = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
const SECRET = "whsec_" + "b".repeat(32);
const ADA = "11111111-1111-4111-8111-111111111111";
const BEA = "22222222-2222-4222-8222-222222222222";
const CY = "33333333-3333-4333-8333-333333333333";

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
  await db.exec(`insert into auth.users(id) values ('${ADA}'), ('${BEA}'), ('${CY}');
    insert into private.billing_settings(project, mode, checkout_enabled) values ('test','test',true);
    insert into private.billing_offers values
     ('starter_month','test','starter','subscription','month',1900,600,'price_sm','plink_sm','https://buy.stripe.com/test_sm'),
     ('pro_month','test','pro','subscription','month',3900,2000,'price_pm','plink_pm','https://buy.stripe.com/test_pm'),
     ('pack_500','test',null,'pack',null,1000,500,'price_p5','plink_p5','https://buy.stripe.com/test_p5');`);
  return db;
}
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const as = (db, u) => db.exec(`select set_config('request.jwt.claim.sub','${u}',false)`);
const crm = (n) => JSON.stringify({ crm: Array.from({ length: n }, (_, i) => ({ id: "c" + i })) });
async function save(db, u, n) {
  await as(db, u);
  const rev = (await one(db, "select coalesce((select revision from public.workspace_states where user_id=$1),0) r", [u])).r;
  return one(db, "select public.workspace_save($1,$2::jsonb) r", [rev, crm(n)]);
}
const setTier = (db, u, t) => db.exec(`select private.billing_ensure_account('${u}'); update private.billing_accounts set tier='${t}' where user_id='${u}';`);
let n = 0;
const sign = (raw) => { const t = Math.floor(Date.now() / 1000); return `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${raw}`).digest("hex")}`; };
async function buyPack(db, u) {
  const raw = JSON.stringify({ id: `evt_p${++n}`, type: "checkout.session.completed", livemode: false,
    data: { object: { id: `cs_p${n}`, payment_status: "paid", payment_link: "plink_p5", client_reference_id: u, customer: "cus_x" } } });
  return (await one(db, "select public.stripe_webhook_ingest($1,$2) r", [raw, sign(raw)])).r.outcome;
}
const balance = async (db, u) => (await one(db, "select balance from public.credit_accounts where user_id=$1", [u])).balance;
const lots = async (db, u) => (await db.query("select credits, remaining, expired_credits, expires_at from private.credit_lots where user_id=$1 order by id", [u])).rows;

test("grille des limites conforme à #/tarifs", async () => {
  const db = await boot();
  const g = async (t) => (await one(db, "select private.plan_limits($1) l", [t])).l;
  assert.deepEqual(await g("gratuit"), { seats: 1, crm_max: 100, ai_month: 0 });
  assert.deepEqual(await g("starter"), { seats: 1, crm_max: null, ai_month: 50 });
  assert.deepEqual(await g("pro"), { seats: 2, crm_max: null, ai_month: 50 });
  assert.deepEqual(await g("equipe"), { seats: 5, crm_max: null, ai_month: 50 });
  assert.deepEqual(await g(null), await g("gratuit"));
});

test("CRM Gratuit : 100 fiches, au-delà seules les additions sont refusées", async () => {
  const db = await boot();
  await setTier(db, ADA, "gratuit");
  await save(db, ADA, 100);
  await assert.rejects(save(db, ADA, 101), /crm_limit/);
  // Passage à Starter : illimité ; retour à Gratuit avec 150 fiches : conservées.
  await setTier(db, ADA, "starter");
  await save(db, ADA, 150);
  await setTier(db, ADA, "gratuit");
  await save(db, ADA, 150);           // même nombre : accepté (notes, statuts)
  await save(db, ADA, 120);           // suppression : acceptée
  await assert.rejects(save(db, ADA, 121), /crm_limit/);
  const kept = await one(db, "select jsonb_array_length(payload->'crm') n from public.workspace_states where user_id=$1", [ADA]);
  assert.equal(kept.n, 120);
  // Premier enregistrement direct au-dessus du plafond : refusé.
  await setTier(db, BEA, "gratuit");
  await assert.rejects(save(db, BEA, 101), /crm_limit/);
});

test("utilisateurs par espace : Gratuit/Starter 1, Pro 2, Équipe 5", async () => {
  const db = await boot();
  await setTier(db, ADA, "starter");
  await assert.rejects(db.exec(`insert into private.workspace_members values ('${ADA}','${BEA}')`), /seat_limit/);
  await setTier(db, ADA, "pro");
  await db.exec(`insert into private.workspace_members values ('${ADA}','${BEA}')`);
  await assert.rejects(db.exec(`insert into private.workspace_members values ('${ADA}','${CY}')`), /seat_limit/);
  await setTier(db, ADA, "equipe");
  await db.exec(`insert into private.workspace_members values ('${ADA}','${CY}')`);
  // Retour à Starter : membres conservés, aucune nouvelle addition.
  await setTier(db, ADA, "starter");
  assert.equal((await one(db, "select count(*)::int c from private.workspace_members where owner_id=$1", [ADA])).c, 2);
});

test("messages IA : 0 en Gratuit, 50 par mois en Starter, compteur serveur", async () => {
  const db = await boot();
  await setTier(db, ADA, "gratuit");
  await as(db, ADA);
  assert.equal((await one(db, "select public.ai_quota_consume(1) r")).r.granted, 0);
  await setTier(db, ADA, "starter");
  await as(db, ADA);
  assert.equal((await one(db, "select public.ai_quota_consume(45) r")).r.granted, 45);
  const r = (await one(db, "select public.ai_quota_consume(10) r")).r;
  assert.equal(r.granted, 5); assert.equal(r.used, 50); assert.equal(r.max, 50);
  assert.equal((await one(db, "select public.ai_quota_consume(1) r")).r.granted, 0);
  await assert.rejects(db.query("select public.ai_quota_consume(0)"), /quantite_invalide/);
  const st = (await one(db, "select public.plan_status() r")).r;
  assert.equal(st.ai.used, 50); assert.equal(st.tier, "starter"); assert.equal(st.crm.max, null);
});

test("pack : lot de 12 mois, consommé en premier, reste retiré à l'échéance", async () => {
  const db = await boot();
  assert.equal(await buyPack(db, ADA), "pack_granted");
  assert.equal(await balance(db, ADA), 700);
  let l = await lots(db, ADA);
  assert.equal(l.length, 1); assert.equal(l[0].remaining, 500);
  const days = (new Date(l[0].expires_at) - Date.now()) / 86400000;
  assert.ok(days > 360 && days < 370);
  // Débit de 120 : puisé dans le lot.
  await db.exec(`update public.credit_accounts set balance = balance - 120 where user_id='${ADA}'`);
  l = await lots(db, ADA); assert.equal(l[0].remaining, 380);
  // Remboursement : le solde remonte, le lot ne se recrée pas (crédits rendus permanents).
  await db.exec(`update public.credit_accounts set balance = balance + 20 where user_id='${ADA}'`);
  assert.equal((await lots(db, ADA))[0].remaining, 380);
  // Échéance : seul le reste du lot (380) est retiré ; 200 offerts + 20 rendus restent.
  await db.exec(`update private.credit_lots set expires_at = now() - interval '1 second' where user_id='${ADA}'`);
  assert.equal((await one(db, "select private.expire_credit_lots() n")).n, 380);
  assert.equal(await balance(db, ADA), 220);
  l = await lots(db, ADA); assert.equal(l[0].remaining, 0); assert.equal(l[0].expired_credits, 380);
  assert.equal((await one(db, "select private.expire_credit_lots() n")).n, 0);
  assert.equal(await balance(db, ADA), 220);
});

test("expiration : jamais sous zéro, plus ancien lot consommé d'abord, lecture paresseuse", async () => {
  const db = await boot();
  await buyPack(db, BEA); await buyPack(db, BEA);
  assert.equal(await balance(db, BEA), 1200);
  await db.exec(`update private.credit_lots set expires_at = now() + interval '1 day' where id = (select min(id) from private.credit_lots where user_id='${BEA}')`);
  await db.exec(`update public.credit_accounts set balance = 100 where user_id='${BEA}'`);   // 1 100 débités
  let l = await lots(db, BEA);
  assert.deepEqual(l.map((x) => x.remaining), [0, 0]);
  await db.exec(`update public.credit_accounts set balance = 700 where user_id='${BEA}'`);
  await db.exec(`update private.credit_lots set expires_at = now() - interval '1 second', remaining = 500 where user_id='${BEA}' and id = (select max(id) from private.credit_lots where user_id='${BEA}')`);
  await db.exec(`update public.credit_accounts set balance = 30 where user_id='${BEA}'`);   // lot échu non consommé
  await as(db, BEA);
  const st = (await one(db, "select public.billing_status() r")).r;     // expiration paresseuse
  assert.equal(st.balance, 0);
  assert.equal(await balance(db, BEA), 0);
  // Aucun lot créé pour les comptes existants : aucun solde corrigé.
  assert.equal((await lots(db, CY)).length, 0);
});
