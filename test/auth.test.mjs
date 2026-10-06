import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { webcrypto } from "node:crypto";
import {
  confirmedDeletion,
  deletionFailureMessage,
  displayName,
  emailAddress,
  emailLinkParams,
  passwordIssue
} from "../src/auth-policy.js";

const migration = await readFile(
  new URL("../supabase/migrations/20261006021000_harden_workspace_and_profile_privileges.sql", import.meta.url),
  "utf8"
);
const authClient = await readFile(new URL("../src/auth.js", import.meta.url), "utf8");
const confirmation = await readFile(new URL("../supabase/templates/confirmation.html", import.meta.url), "utf8");
const recovery = await readFile(new URL("../supabase/templates/recovery.html", import.meta.url), "utf8");
const storeSource = await readFile(new URL("../src/store.js", import.meta.url), "utf8");
const securitySource = await readFile(new URL("../src/security.js", import.meta.url), "utf8");

test("refuse un mot de passe faible et accepte une politique complète", () => {
  assert.match(passwordIssue("court"), /12 à 72/);
  assert.match(passwordIssue("seulementdeslettres"), /minuscule/);
  assert.equal(passwordIssue("PhraseSolide12"), "");
  assert.match(passwordIssue("A".repeat(73)), /12 à 72/);
});

test("normalise l’e-mail et le nom sans garder de contrôle", () => {
  assert.equal(emailAddress("  Ada@Example.COM "), "ada@example.com");
  assert.equal(emailAddress("pas-un-email"), "");
  assert.equal(displayName("  Ada\u0000 Lovelace  "), "Ada Lovelace");
  assert.equal(displayName("x".repeat(200)).length, 120);
});

test("lit le lien d’e-mail sans dépendre du vérificateur PKCE", () => {
  const parsed = emailLinkParams("http://127.0.0.1:3000/?token_hash=abc123&type=email#/auth/callback");
  assert.deepEqual(parsed, { tokenHash: "abc123", type: "email", route: "auth/callback" });
  const recoveryLink = emailLinkParams("http://127.0.0.1:3000/#/reset-password?token_hash=zzz&type=recovery");
  assert.equal(recoveryLink.type, "recovery");
  assert.equal(recoveryLink.route, "reset-password");
  assert.equal(emailLinkParams("http://127.0.0.1:3000/?token_hash=abc&type=script"), null);
});

test("la confirmation de suppression est exacte", () => {
  assert.equal(confirmedDeletion("SUPPRIMER"), true);
  assert.equal(confirmedDeletion("supprimer"), false);
  assert.match(deletionFailureMessage("authentication_required"), /Mot de passe/);
});

test("le client ne décide pas la sortie du mode démo et n’embarque pas de secret", () => {
  assert.match(authClient, /verifyOtp/);
  assert.match(authClient, /resendVerification/);
  assert.match(authClient, /sessionStorage/);
  assert.match(authClient, /flowType:\s*"pkce"/);
  assert.match(authClient, /delete cleanPayload\.user/);
  assert.doesNotMatch(authClient, /demo_migrated_at\s*:/);
  assert.doesNotMatch(authClient, /service[_-]role/i);
  assert.match(confirmation, /token_hash=\{\{ \.TokenHash \}\}/);
  assert.match(recovery, /type=recovery/);
  assert.match(migration, /grant update \(display_name\) on table public\.profiles to authenticated/i);
  assert.match(migration, /private\.strip_secrets/);
  assert.match(migration, /private\.mark_demo_migrated/);
  assert.doesNotMatch(migration, /create (or replace )?function public\./i);
});

test("le mode démo ne se désactive pas depuis les données locales", () => {
  const session = new Map();
  const context = {
    window: { root: {} },
    sessionStorage: {
      getItem(key) { return session.has(key) ? session.get(key) : null; },
      setItem(key, value) { session.set(key, String(value)); },
      removeItem(key) { session.delete(key); }
    },
    structuredClone,
    Blob,
    crypto: webcrypto,
    console,
    URL
  };
  vm.runInNewContext(`${securitySource}\n${storeSource}`, context);
  const store = context.window.KlirStore;
  store.S = { demo: false, password: "secret", apiKey: "secret" };
  assert.equal(store.S.demo, true);
  assert.equal("password" in store.S, false);
  assert.equal(store.S.apiKey, null);
  assert.equal(store.isLiveAccount(), false);
  store.setLiveAccount(true);
  store.S = { demo: true, org: { name: "Atelier" } };
  assert.equal(store.S.demo, false);
  assert.equal(store.S.org.name, "Atelier");
  let saved = 0;
  store.setAfterSave(() => { saved += 1; });
  store.save();
  assert.equal(saved, 1);
  store.logoutUser();
  assert.equal(store.isLiveAccount(), false);
  assert.equal(store.S.demo, true);
  assert.equal(session.has(store.LS), false);
});

test("le build client refuse une clé secrète et publie seulement la clé publique", async () => {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const secretPayload = Buffer.from(JSON.stringify({ role: "service_role" })).toString("base64url");
  const rejected = spawnSync(process.execPath, ["tools/build.mjs"], {
    env: { ...process.env, SUPABASE_URL: "https://klirprospect.supabase.co", SUPABASE_PUBLISHABLE_KEY: `${header}.${secretPayload}.sig` },
    encoding: "utf8"
  });
  assert.notEqual(rejected.status, 0);
  assert.match(`${rejected.stderr}${rejected.stdout}`, /clé secrète/);

  const blockedEnv = spawnSync(process.execPath, ["tools/build.mjs"], {
    env: { ...process.env, SUPABASE_SERVICE_ROLE_KEY: "present", SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "" },
    encoding: "utf8"
  });
  assert.notEqual(blockedEnv.status, 0);

  const built = spawnSync(process.execPath, ["tools/build.mjs"], {
    env: {
      ...process.env,
      SUPABASE_URL: "https://klirprospect.supabase.co",
      SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test_value"
    },
    encoding: "utf8"
  });
  assert.equal(built.status, 0, built.stderr);
  const config = await readFile(new URL("../dist/config.js", import.meta.url), "utf8");
  const bundle = await readFile(new URL("../dist/auth.js", import.meta.url), "utf8");
  assert.match(config, /https:\/\/klirprospect\.supabase\.co/);
  assert.match(config, /sb_publishable_test_value/);
  assert.doesNotMatch(config, /service_role|sb_secret_/);
  assert.doesNotMatch(bundle, /sb_publishable_test_value|SUPABASE_SERVICE_ROLE_KEY/);
});
