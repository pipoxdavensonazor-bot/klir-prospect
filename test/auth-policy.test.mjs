import assert from "node:assert/strict";
import test from "node:test";
import {
  accountSessionPlan,
  appRedirectUrl,
  displayName,
  parseAuthCallback,
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

test("borne le nom affiché", () => {
  assert.equal(displayName("  <Ada> \u0000"), "Ada");
  assert.equal(displayName("a".repeat(200)).length, 120);
});
