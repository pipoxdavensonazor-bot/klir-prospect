import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { frenchAuthError } from "../src/auth-policy.js";

test("limite d'envoi Supabase affichée en français", () => {
  const out = frenchAuthError({ data: {}, error: { status: 429, message: "email rate limit exceeded" } });
  assert.equal(out.error.message, "Trop de demandes ont été envoyées. Patientez avant de réessayer.");
  assert.equal(out.error.status, 429);
});

test("les autres erreurs et les succès passent inchangés", () => {
  const ok = { data: { user: null }, error: null };
  assert.equal(frenchAuthError(ok), ok);
  const other = { data: {}, error: { status: 400, message: "Mot de passe trop court." } };
  assert.equal(frenchAuthError(other), other);
});

test("l'écran Mot de passe oublié ne demande plus le même onglet", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /Gardez cet onglet ouvert/);
  assert.match(app, /seul le plus récent fonctionne/);
});
