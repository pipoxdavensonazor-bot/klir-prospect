import assert from "node:assert/strict";
import test from "node:test";
import {
  accountSessionPlan,
  appRedirectUrl,
  describeSearch,
  displayName,
  combineWorkspace,
  mergeWorkspace,
  parseAuthCallback,
  resyncWorkspace,
  passwordIssues,
  workspaceForMigration
} from "../src/auth-policy.js";

test("refuse un mot de passe trop faible et accepte la politique Supabase", () => {
  assert.deepEqual(passwordIssues("court"), ["length", "upper", "digit"]);
  assert.deepEqual(passwordIssues("SansChiffreLong"), ["digit"]);
  assert.deepEqual(passwordIssues("KlirProspect1"), []);
});

test("retire le fragment et index.html de l’URL de redirection", () => {
  assert.equal(appRedirectUrl("http://127.0.0.1:3000/", "/index.html"), "http://127.0.0.1:3000/");
  assert.equal(appRedirectUrl("https://klirprospect.klirline.ca", "/"), "https://klirprospect.klirline.ca/");
});

test("n’accepte qu’un token_hash de type connu", () => {
  assert.equal(parseAuthCallback("?token_hash=abc&type=signup").type, "signup");
  assert.equal(parseAuthCallback("?token_hash=abc&type=recovery").type, "recovery");
  assert.equal(parseAuthCallback("?code=pkce&type=signup"), null);
  assert.equal(parseAuthCallback("?token_hash=abc&type=admin"), null);
});

test("retire identifiants, secrets et le compte démo avant migration", () => {
  const clean = workspaceForMigration({
    user: { email: "demo@local.invalid" },
    apiKey: "secret",
    password: "KlirProspect1",
    prospects: [{ company_name: "Nord", token: "x" }],
    notes: { authorization: "Bearer x", city: "Montréal" }
  });
  assert.equal(clean.user, undefined);
  assert.equal(clean.apiKey, undefined);
  assert.equal(clean.password, undefined);
  assert.equal(clean.prospects[0].token, undefined);
  assert.equal(clean.prospects[0].company_name, "Nord");
  assert.equal(clean.notes.authorization, undefined);
  assert.equal(clean.notes.city, "Montréal");
});

test("une recherche de compte survit au nettoyage avant enregistrement", () => {
  const clean = workspaceForMigration({
    user: { email: "ada@example.com" },
    searches: [{ id: "s1", label: "Rénovation Montréal", total: 10 }],
    prospects: [{ id: "p1", company_name: "Nord Rénovation", city: "Montréal" }],
    crm: [{ id: "l1", company_name: "Nord Rénovation" }]
  });
  assert.equal(clean.user, undefined);
  assert.equal(clean.searches[0].label, "Rénovation Montréal");
  assert.equal(clean.prospects[0].company_name, "Nord Rénovation");
  assert.equal(clean.crm[0].company_name, "Nord Rénovation");
});

test("le même compte recharge les recherches distantes et laisse la démo de côté", () => {
  const remote = accountSessionPlan(
    { demo: true, user: { email: "demo@local.invalid" }, searches: [{ id: "local" }], prospects: [{ id: "p" }], _savedAt: Date.now() },
    { payload: { searches: [{ id: "cloud", label: "Montréal" }], prospects: [] }, updated_at: "2026-10-09T00:00:00.000Z" }
  );
  assert.equal(remote.source, "cloud");
  assert.equal(remote.state.searches[0].id, "cloud");

  const fresh = accountSessionPlan(
    { demo: true, user: { email: "demo@local.invalid" }, searches: [{ id: "local" }], prospects: [] },
    null
  );
  assert.equal(fresh.source, "empty");
  assert.equal(fresh.stashDemo, true);

  const unsynced = accountSessionPlan(
    { demo: false, user: { email: "ada@example.com" }, searches: [{ id: "local", label: "Québec" }], _savedAt: Date.parse("2026-10-09T12:00:00.000Z") },
    { payload: { searches: [{ id: "cloud" }] }, updated_at: "2026-10-09T00:00:00.000Z" },
    "ada@example.com"
  );
  assert.equal(unsynced.source, "local");
  assert.equal(unsynced.state.searches[0].label, "Québec");
  assert.ok(unsynced.state.searches.some((item) => item.id === "cloud"));

  const foreign = accountSessionPlan(
    { demo: false, user: { email: "ada@example.com" }, searches: [{ id: "local", label: "Québec" }], prospects: [{ id: "p" }], _savedAt: Date.now() },
    null,
    "bea@example.com"
  );
  assert.equal(foreign.source, "empty");
  assert.equal(foreign.stashDemo, false);

  const foreignCloud = accountSessionPlan(
    { demo: false, user: { email: "ada@example.com" }, searches: [{ id: "local" }], _savedAt: Date.now() },
    { payload: { searches: [{ id: "cloud", label: "Bea" }] }, updated_at: "2026-10-09T00:00:00.000Z" },
    "bea@example.com"
  );
  assert.equal(foreignCloud.source, "cloud");
  assert.equal(foreignCloud.state.searches[0].label, "Bea");
});

test("une session locale vide ne remplace pas l'historique du compte", () => {
  const kept = accountSessionPlan(
    { demo: false, user: { email: "ada@example.com" }, searches: [], _savedAt: Date.parse("2026-10-09T12:00:00.000Z") },
    { payload: { searches: [{ id: "cloud", label: "Montréal" }], prospects: [{ id: "p", searchId: "cloud" }] }, updated_at: "2026-10-09T00:00:00.000Z" },
    "ada@example.com"
  );
  assert.equal(kept.source, "cloud");
  assert.equal(kept.state.searches[0].id, "cloud");
  const explicit = accountSessionPlan(
    { demo: false, user: { email: "ada@example.com" }, searches: [], removedSearchIds: ["cloud"], _savedAt: Date.parse("2026-10-09T12:00:00.000Z") },
    { payload: { searches: [{ id: "cloud", label: "Montréal" }, { id: "keep", label: "Québec" }] }, updated_at: "2026-10-09T00:00:00.000Z" },
    "ada@example.com"
  );
  assert.equal(explicit.source, "local");
  assert.deepEqual(explicit.state.searches.map((item) => item.id), ["keep"]);
});

test("une liste vide n'efface pas les recherches déjà enregistrées", () => {
  const kept = combineWorkspace(
    { searches: [{ id: "s1", label: "Serveur" }], prospects: [{ id: "p1", searchId: "s1" }] },
    { searches: [], prospects: [], org: { name: "Klirline" } }
  );
  assert.equal(kept.searches[0].id, "s1");
  assert.equal(kept.prospects[0].searchId, "s1");
  assert.equal(kept.org.name, "Klirline");
  const dropped = combineWorkspace(
    { searches: [{ id: "s1" }, { id: "s2" }], prospects: [{ id: "p1", searchId: "s1" }, { id: "p2", searchId: "s2" }] },
    { searches: [{ id: "s1", label: "Ici" }], removedSearchIds: ["s2"] }
  );
  assert.deepEqual(dropped.searches.map((item) => item.id), ["s1"]);
  assert.equal(dropped.searches[0].label, "Ici");
  assert.equal(dropped.prospects.length, 1);
  assert.equal(dropped.prospects[0].searchId, "s1");
});

test("la migration ajoute les recherches manquantes et garde celles du compte", () => {
  const merged = mergeWorkspace(
    { searches: [{ id: "s1", label: "Déjà sur le compte", query: "rénovation Montréal" }], prospects: [{ id: "p1", searchId: "s1" }], crm: [] },
    { searches: [{ id: "s1", label: "Doublon démo" }, { id: "s2", label: "Nouvelle démo" }], prospects: [{ id: "p1" }, { id: "p2", searchId: "s2" }], crm: [{ id: "c2" }] }
  );
  assert.equal(merged.searches.length, 2);
  assert.equal(merged.searches[0].label, "Déjà sur le compte");
  assert.equal(merged.searches[1].id, "s2");
  assert.equal(merged.prospects.length, 2);
  assert.equal(merged.crm.length, 1);
});

test("la resynchronisation garde les recherches de l'appareil et celles du compte", () => {
  const merged = resyncWorkspace(
    { org: { name: "Klirline" }, searches: [{ id: "s1", label: "Ici" }], prospects: [{ id: "p1", searchId: "s1" }], crm: [] },
    { payload: { searches: [{ id: "s1", label: "Ancienne" }, { id: "s2", label: "Autre ordinateur" }], prospects: [{ id: "p2", searchId: "s2" }], crm: [{ id: "c9" }] }, updated_at: "2026-10-09T00:00:00.000Z" }
  );
  assert.equal(merged.org.name, "Klirline");
  assert.deepEqual(merged.searches.map((item) => item.id), ["s1", "s2"]);
  assert.equal(merged.searches[0].label, "Ici");
  assert.equal(merged.prospects.length, 2);
  assert.equal(merged.crm[0].id, "c9");
  const localOnly = resyncWorkspace({ searches: [{ id: "s1" }] }, null);
  assert.equal(localOnly.searches[0].id, "s1");
});

test("une recherche décrit ses mots-clés, filtres et son statut", () => {
  const info = describeSearch({
    query: "10 entreprises de rénovation à Montréal",
    date: "09/10/2026",
    status: "terminée",
    total: 10,
    params: { industry: "construction", city: { city: "Montréal" }, size: "11–50", quantity: 10, raw: "10 entreprises de rénovation à Montréal" }
  });
  assert.equal(info.keywords, "10 entreprises de rénovation à Montréal");
  assert.equal(info.date, "09/10/2026");
  assert.equal(info.status, "terminée");
  assert.equal(info.city, "Montréal");
  assert.equal(info.quantity, "10");
});

test("borne le nom affiché", () => {
  assert.equal(displayName("  <Ada> \u0000"), "Ada");
  assert.equal(displayName("a".repeat(200)).length, 120);
});
