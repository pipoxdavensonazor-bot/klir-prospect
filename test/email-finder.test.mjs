import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  extractEmails, pickEmail, robotsAllows, contactLinks, cleanEmail, safeSiteUrl,
  findEmailForSite, handleEmailFinder, settleItems, cleanRefs, EMAIL_FINDER_UA, MAX_PAGES
} from "../supabase/functions/_shared/email-finder.mjs";

test("extraction : mailto et texte visible, sans images, scripts ni adresses masquées", () => {
  const html = `<a href="mailto:Info@Resto-Exemple.ca?subject=Bonjour">Écrire</a>
    <p>Réservations : reservations@resto-exemple.ca</p>
    <img src="logo@2x.png"> <span>info [at] resto-exemple.ca</span>
    <script>var x="tracker@sentry.io"; var y="hidden@resto-exemple.ca";</script>
    <p>noreply@resto-exemple.ca 1a2b3c4d5e6f7a8b9c0d@sentry.wixpress.com</p>`;
  const got = extractEmails(html, "https://resto-exemple.ca/contact").map((c) => c.email);
  assert.deepEqual(got, ["info@resto-exemple.ca", "reservations@resto-exemple.ca"]);
  assert.equal(cleanEmail("photo@2x.png"), "");
  assert.equal(cleanEmail("mailto:contact%40site.ca"), "contact@site.ca");
});

test("choix : domaine du site et adresse de rôle d'abord, domaine étranger écarté", () => {
  const c = [
    { email: "jean.tremblay@resto.ca", via: "text", source: "u" },
    { email: "webdesign@agence-web.com", via: "mailto", source: "u" },
    { email: "info@resto.ca", via: "text", source: "u" }
  ];
  assert.equal(pickEmail(c, "www.resto.ca").email, "info@resto.ca");
  assert.equal(pickEmail([{ email: "x@agence.com", via: "mailto", source: "u" }], "resto.ca"), null);
  assert.equal(pickEmail([{ email: "Contato@mexigrillmexicanfood.com".toLowerCase(), via: "text", source: "u" }], "mexigrill.express").email, "contato@mexigrillmexicanfood.com");
  assert.equal(pickEmail([{ email: "restolaval@gmail.com", via: "mailto", source: "u" }], "resto.ca").email, "restolaval@gmail.com");
});

test("robots.txt : groupe du robot, sinon *, règle la plus longue", () => {
  const txt = "User-agent: *\nDisallow: /private\nAllow: /private/contact\n\nUser-agent: OtherBot\nDisallow: /";
  assert.equal(robotsAllows(txt, "/"), true);
  assert.equal(robotsAllows(txt, "/private/x"), false);
  assert.equal(robotsAllows(txt, "/private/contact"), true);
  assert.equal(robotsAllows("User-agent: KlirProspectBot\nDisallow: /", "/contact"), false);
  assert.equal(robotsAllows("", "/contact"), true);
});

test("liens contact du même site seulement, contact avant à propos", () => {
  const html = `<a href="/a-propos">À propos</a><a href="https://autre.com/contact">x</a><a href="/nous-joindre">Nous joindre</a><a href="/menu.pdf">contact pdf</a>`;
  assert.deepEqual(contactLinks(html, "https://www.resto.ca/"), ["https://www.resto.ca/nous-joindre", "https://www.resto.ca/a-propos"]);
});

test("sites refusés : réseaux sociaux, IP, ports, localhost", () => {
  assert.equal(safeSiteUrl("https://www.facebook.com/resto"), null);
  assert.equal(safeSiteUrl("http://127.0.0.1/"), null);
  assert.equal(safeSiteUrl("https://resto.ca:8443/"), null);
  assert.equal(safeSiteUrl("ftp://resto.ca"), null);
  assert.ok(safeSiteUrl("http://www.resto.ca/"));
});

function fakeFetch(pages) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, ua: init.headers["user-agent"] });
    const page = pages[url];
    if (!page) return new Response("", { status: 404 });
    return new Response(page.body, { status: page.status || 200, headers: { "content-type": page.type || "text/html; charset=utf-8" } });
  };
  return { impl, calls };
}

test("un site : accueil puis page contact, 4 pages au plus, User-Agent identifiable", async () => {
  const { impl, calls } = fakeFetch({
    "https://resto.ca/robots.txt": { body: "User-agent: *\nDisallow: /admin", type: "text/plain" },
    "https://resto.ca/": { body: `<a href="/contact">Contact</a><a href="/a-propos">À propos</a><a href="/equipe">Équipe</a><a href="/joindre-2">Nous joindre</a><a href="/coordonnees">Coordonnées</a>` },
    "https://resto.ca/contact": { body: "<p>Écrivez-nous : bonjour@resto.ca</p>" }
  });
  const r = await findEmailForSite("https://resto.ca/", { fetch: impl, gapMs: 0 });
  assert.equal(r.status, "found");
  assert.equal(r.email, "bonjour@resto.ca");
  assert.equal(r.source, "https://resto.ca/contact");
  assert.ok(calls.every((c) => c.ua === EMAIL_FINDER_UA));
  assert.ok(r.pages <= MAX_PAGES);
});

test("page d'entrée introuvable : l'accueil du site est lu à la place", async () => {
  const { impl } = fakeFetch({ "https://chaine.com/": { body: "<p>info@chaine.com</p>" } });
  const r = await findEmailForSite("https://chaine.com/fr/succursale-12", { fetch: impl, gapMs: 0 });
  assert.deepEqual([r.status, r.email, r.source], ["found", "info@chaine.com", "https://chaine.com/"]);
});

test("robots.txt qui interdit tout : aucune page lue", async () => {
  const { impl, calls } = fakeFetch({ "https://resto.ca/robots.txt": { body: "User-agent: *\nDisallow: /", type: "text/plain" } });
  const r = await findEmailForSite("https://resto.ca/", { fetch: impl, gapMs: 0 });
  assert.equal(r.status, "robots");
  assert.equal(calls.length, 1);
});

test("aucune adresse : statut none, plafond de pages respecté", async () => {
  const links = Array.from({ length: 8 }, (_, i) => `<a href="/contact-${i}">Contact ${i}</a>`).join("");
  const pages = { "https://resto.ca/": { body: links } };
  for (let i = 0; i < 8; i++) pages[`https://resto.ca/contact-${i}`] = { body: "<p>Téléphone seulement</p>" };
  const { impl, calls } = fakeFetch(pages);
  const r = await findEmailForSite("https://resto.ca/", { fetch: impl, gapMs: 0 });
  assert.equal(r.status, "none");
  assert.equal(calls.filter((c) => !c.url.endsWith("robots.txt")).length, MAX_PAGES);
});

test("sélection : 1 à 25 références valides", () => {
  assert.equal(cleanRefs({ refs: [] }), null);
  assert.equal(cleanRefs({ refs: Array.from({ length: 26 }, () => ({ id: "11111111-1111-4111-8111-111111111111" })) }), null);
  assert.equal(cleanRefs({ refs: [{ id: "x" }] }), null);
  assert.deepEqual(cleanRefs({ refs: [{ job_id: "11111111-1111-4111-8111-111111111111", name: "Resto" }] }), [{ job_id: "11111111-1111-4111-8111-111111111111", name: "Resto" }]);
});

test("orchestration : réserve, extrait, règle ; injoignable non marqué", async () => {
  const seen = {};
  const out = await handleEmailFinder({
    userId: "u",
    body: { refs: [{ id: "11111111-1111-4111-8111-111111111111" }, { id: "22222222-2222-4222-8222-222222222222" }, { id: "33333333-3333-4333-8333-333333333333" }] },
    randomBytes: (n) => new Uint8Array(n).fill(171),
    begin: async (u, receipt, refs) => { seen.receipt = receipt; seen.refs = refs; return { status: "reserved", amount: 3, targets: refs.map((r) => ({ ...r, website: "https://a.ca" })), done: [] }; },
    extract: async (targets) => [
      { id: targets[0].id, status: "found", email: "info@a.ca", source: "https://a.ca/contact" },
      { id: targets[1].id, status: "none" },
      { id: targets[2].id, status: "unreachable" }
    ],
    finish: async (u, receipt, items) => { seen.items = items; return { charged: 1, refunded: 2, balance: 97 }; }
  });
  assert.equal(seen.receipt, "email_" + "ab".repeat(12));
  assert.deepEqual(seen.items, [
    { id: "11111111-1111-4111-8111-111111111111", email: "info@a.ca", source: "https://a.ca/contact" },
    { id: "22222222-2222-4222-8222-222222222222", email: null, source: null }
  ]);
  assert.equal(out.status, 200);
  assert.equal(out.body.charged, 1);
  assert.equal(out.body.refunded, 2);
  const denied = await handleEmailFinder({ userId: "u", body: { refs: [{ id: "11111111-1111-4111-8111-111111111111" }] }, randomBytes: (n) => new Uint8Array(n), begin: async () => { throw new Error("credits_insuffisants"); }, extract: async () => [], finish: async () => ({}) });
  assert.deepEqual([denied.status, denied.body.error], [409, "credits_insuffisants"]);
  assert.deepEqual(settleItems([{ id: "a", status: "not_checked" }, { id: "b", status: "robots" }]), [{ id: "b", email: null, source: null }]);
});

// --- Grand livre : migrations complètes sur PGlite ---
const dir = new URL("../supabase/migrations/", import.meta.url);
const SKIP = new Set(["20261103010000_stripe_test_preview.sql", "20261107233000_search_job_connect_test.sql"]);
const files = (await readdir(dir)).filter((f) => f.endsWith(".sql") && !SKIP.has(f)).sort();
async function boot() {
  const db = new PGlite();
  await db.exec(`create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create role anon; create role authenticated; create role service_role;
    grant usage on schema public,auth to authenticated,anon;`);
  for (const f of files) {
    try { await db.exec(await readFile(new URL(f, dir), "utf8")); }
    catch (error) { throw new Error(`${f}: ${error.message}`); }
  }
  return db;
}
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const ada = "11111111-1111-1111-1111-111111111111";
const bea = "22222222-2222-2222-2222-222222222222";
const rc = (i) => "email_" + i.toString(16).padStart(24, "0");

test("courriels : 1 crédit par courriel trouvé, remboursement sinon, fiche du propriétaire seulement", async () => {
  const db = await boot();
  try {
    await db.query("insert into auth.users(id,raw_user_meta_data) values ($1,'{}'),($2,'{}')", [ada, bea]);
    await db.query("insert into public.credit_accounts(user_id,balance,usage_period,searches_used) values ($1,10,private.toronto_period(),0),($2,10,private.toronto_period(),0) on conflict (user_id) do update set balance=10, usage_period=private.toronto_period(), searches_used=0", [ada, bea]);
    await db.query("alter table public.search_job_places drop constraint search_job_places_job_id_fkey");
    const job = "99999999-9999-4999-8999-999999999999";
    const ins = "insert into public.search_job_places(job_id,user_id,name,website) values ($1,$2,$3,$4) returning id";
    const p1 = (await one(db, ins, [job, ada, "Resto Un", "https://un.ca/"])).id;
    const p2 = (await one(db, ins, [job, ada, "Resto Deux", "https://deux.ca/"])).id;
    const p3 = (await one(db, ins, [job, ada, "Sans Site", null])).id;
    const pb = (await one(db, ins, [job, bea, "Chez Bea", "https://bea.ca/"])).id;

    for (const fn of ["public.email_finder_begin(uuid,text,jsonb)", "public.email_finder_finish(uuid,text,jsonb)"]) {
      assert.equal((await one(db, "select has_function_privilege('authenticated', $1::regprocedure, 'execute') ok", [fn])).ok, false);
      assert.equal((await one(db, "select has_function_privilege('anon', $1::regprocedure, 'execute') ok", [fn])).ok, false);
      assert.equal((await one(db, "select has_function_privilege('service_role', $1::regprocedure, 'execute') ok", [fn])).ok, true);
    }

    const refs = JSON.stringify([{ id: p1 }, { id: p2 }, { id: p3 }, { id: pb }]);
    const b = (await one(db, "select public.email_finder_begin($1,$2,$3::jsonb) v", [ada, rc(1), refs])).v;
    assert.equal(b.status, "reserved");
    assert.equal(b.amount, 2);
    assert.deepEqual(b.targets.map((t) => t.id).sort(), [p1, p2].sort());
    assert.deepEqual(b.done.map((t) => t.id), [p3]);
    assert.equal((await one(db, "select balance from public.credit_accounts where user_id=$1", [ada])).balance, 8);

    const res = JSON.stringify([{ id: p1, email: "Info@Un.ca", source: "https://un.ca/contact" }, { id: p2, email: null }, { id: pb, email: "x@bea.ca", source: "https://bea.ca/" }]);
    await assert.rejects(db.query("select public.email_finder_finish($1,$2,$3::jsonb)", [ada, rc(1), res]), /resultats_invalides/);
    const res2 = JSON.stringify([{ id: p1, email: "Info@Un.ca", source: "https://un.ca/contact" }, { id: pb, email: "x@bea.ca", source: "https://bea.ca/" }]);
    const f = (await one(db, "select public.email_finder_finish($1,$2,$3::jsonb) v", [ada, rc(1), res2])).v;
    assert.deepEqual([f.status, f.charged, f.refunded, f.balance], ["complete", 1, 1, 9]);
    const row1 = await one(db, "select email, email_source, email_found_at is not null found, email_checked_at is not null checked from public.search_job_places where id=$1", [p1]);
    assert.deepEqual(row1, { email: "info@un.ca", email_source: "https://un.ca/contact", found: true, checked: true });
    assert.equal((await one(db, "select email from public.search_job_places where id=$1", [pb])).email, null);
    const acc = await one(db, "select balance, searches_used from public.credit_accounts where user_id=$1", [ada]);
    assert.deepEqual(acc, { balance: 9, searches_used: 0 });
    assert.deepEqual(await one(db, "select amount, label from public.credit_receipts where user_id=$1 and receipt=$2", [ada, rc(1)]), { amount: 1, label: "Courriel" });
    await assert.rejects(db.query("select public.email_finder_finish($1,$2,'[]'::jsonb)", [ada, rc(1)]), /recu_invalide/);

    // Fiche déjà vérifiée : gratuite, renvoyée dans done. Aucun courriel : remboursement complet.
    const again = (await one(db, "select public.email_finder_begin($1,$2,$3::jsonb) v", [ada, rc(2), JSON.stringify([{ id: p1 }])])).v;
    assert.deepEqual([again.status, again.amount, again.done[0].email], ["nothing", 0, "info@un.ca"]);
    const b3 = (await one(db, "select public.email_finder_begin($1,$2,$3::jsonb) v", [ada, rc(3), JSON.stringify([{ job_id: job, name: "Resto Deux" }])])).v;
    assert.equal(b3.amount, 1);
    const f3 = (await one(db, "select public.email_finder_finish($1,$2,$3::jsonb) v", [ada, rc(3), JSON.stringify([{ id: p2, email: null }])])).v;
    assert.deepEqual([f3.status, f3.charged, f3.refunded, f3.balance], ["released", 0, 1, 9]);
    assert.equal((await one(db, "select email_checked_at is not null c from public.search_job_places where id=$1", [p2])).c, true);

    // Domaine retiré (opt-out) : jamais enregistré ni facturé.
    const p4 = (await one(db, ins, [job, ada, "Retiré", "https://www.retire.ca/"])).id;
    await db.query("insert into private.email_optouts(domain) values ('retire.ca')");
    await one(db, "select public.email_finder_begin($1,$2,$3::jsonb) v", [ada, rc(4), JSON.stringify([{ id: p4 }])]);
    const f4 = (await one(db, "select public.email_finder_finish($1,$2,$3::jsonb) v", [ada, rc(4), JSON.stringify([{ id: p4, email: "info@retire.ca", source: "https://www.retire.ca/" }])])).v;
    assert.deepEqual([f4.charged, f4.balance], [0, 9]);

    // Solde insuffisant, receipt mal formé.
    await db.query("update public.credit_accounts set balance=0 where user_id=$1", [bea]);
    await assert.rejects(db.query("select public.email_finder_begin($1,$2,$3::jsonb)", [bea, rc(5), JSON.stringify([{ id: pb }])]), /credits_insuffisants/);
    await assert.rejects(db.query("select public.email_finder_begin($1,'debit_000000000000000000000001',$2::jsonb)", [ada, JSON.stringify([{ id: p2 }])]), /recu_invalide/);

    // Réservation ouverte depuis plus de 5 minutes : remboursée au prochain début.
    const p5 = (await one(db, ins, [job, ada, "Cinq", "https://cinq.ca/"])).id;
    await one(db, "select public.email_finder_begin($1,$2,$3::jsonb) v", [ada, rc(6), JSON.stringify([{ id: p5 }])]);
    assert.equal((await one(db, "select balance from public.credit_accounts where user_id=$1", [ada])).balance, 8);
    await db.query("update public.usage_holds set created_at=now()-interval '10 minutes' where receipt=$1", [rc(6)]);
    await one(db, "select public.email_finder_begin($1,$2,$3::jsonb) v", [ada, rc(7), JSON.stringify([{ id: p1 }])]);
    assert.equal((await one(db, "select status from public.usage_holds where receipt=$1", [rc(6)])).status, "released");
    assert.equal((await one(db, "select balance from public.credit_accounts where user_id=$1", [ada])).balance, 9);

    // Les recherches comptent toujours dans searches_used.
    await db.query("select set_config('request.jwt.claim.sub',$1,false)", [ada]);
    await db.query("update public.credit_accounts set balance=50 where user_id=$1", [ada]);
    await db.query("select public.reserve_usage('debit_000000000000000000000009',6,'Recherche')");
    await db.query("select private.apply_usage_outcome($1,'debit_000000000000000000000009','complete')", [ada]);
    assert.equal((await one(db, "select searches_used from public.credit_accounts where user_id=$1", [ada])).searches_used, 1);
  } finally { await db.close(); }
});

test("interface : bouton par fiche, lot de 25 au plus, note de conformité, lecture des courriels du propriétaire", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const auth = await readFile(new URL("../src/auth.js", import.meta.url), "utf8");
  const jobs = await readFile(new URL("../src/server-jobs.js", import.meta.url), "utf8");
  assert.match(app, /data-findmail=/);
  assert.match(app, /Trouver le courriel</);
  assert.match(app, /id="findMailSel"/);
  assert.match(app, /\.slice\(0,25\)/);
  assert.match(app, /LCAP, à la Loi 25 et au RGPD/);
  assert.match(app, /contact@klirline\.ca/);
  assert.match(auth, /functions\.invoke\("email-finder"/);
  assert.doesNotMatch(auth, /rpc\("email_finder/);
  assert.match(jobs, /email, email_source, email_found_at, email_checked_at/);
});
