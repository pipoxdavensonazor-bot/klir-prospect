import assert from "node:assert/strict";
import test from "node:test";
import {
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

test("borne le nom affiché", () => {
  assert.equal(displayName("  <Ada> \u0000"), "Ada");
  assert.equal(displayName("a".repeat(200)).length, 120);
});
