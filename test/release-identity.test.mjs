import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { decideSupabase, resolveEnvironment } from "../tools/release-identity.mjs";

const production = "https://cbklwmjudobqwbkbxqgy.supabase.co";
const previewBranch = "cursor/prospect-main-review-c23c";

test("l'environnement ne déduit pas la production de WORKERS_CI seul", () => {
  assert.equal(resolveEnvironment({ KLIR_ENV: "preview", WORKERS_CI: "1", WORKERS_CI_BRANCH: "main" }), "preview");
  assert.equal(resolveEnvironment({ KLIR_ENV: "production", WORKERS_CI: "1", WORKERS_CI_BRANCH: previewBranch }), "production");
  assert.equal(resolveEnvironment({ WORKERS_CI: "1", WORKERS_CI_BRANCH: previewBranch, CI: "true" }), "preview");
  assert.equal(resolveEnvironment({ WORKERS_CI: "1", WORKERS_CI_BRANCH: "refs/heads/main", CI: "true" }), "production");
  assert.equal(resolveEnvironment({ WORKERS_CI: "1", CI: "true" }), "inconnu");
  assert.equal(resolveEnvironment({ CI: "true" }), "ci");
  assert.equal(resolveEnvironment({}), "local");
  assert.equal(resolveEnvironment({ KLIR_ENV: "staging" }), "inconnu");
});

test("une prévisualisation n'emprunte pas la base publique ni celle de production", () => {
  const missing = decideSupabase({ WORKERS_CI: "1", WORKERS_CI_BRANCH: previewBranch }, "preview");
  assert.equal(missing.supabaseSource, "absent");
  assert.equal(missing.fetchPublic, false);
  assert.equal(missing.supabaseUrl, "");
  assert.equal(missing.supabasePublishableKey, "");

  const blocked = decideSupabase({
    SUPABASE_URL: production,
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_preview_check"
  }, "preview");
  assert.equal(blocked.supabaseSource, "production-blocked");
  assert.equal(blocked.fetchPublic, false);
  assert.equal(blocked.supabaseUrl, "");
  assert.equal(blocked.supabasePublishableKey, "");

  const separate = decideSupabase({
    SUPABASE_URL: "https://klir-preview-test.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_preview_check"
  }, "preview");
  assert.equal(separate.supabaseSource, "env");
  assert.equal(separate.fetchPublic, false);
  assert.equal(separate.supabaseHost, "klir-preview-test.supabase.co");

  const secret = decideSupabase({
    SUPABASE_URL: "https://klir-preview-test.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "service_role_secret"
  }, "preview");
  assert.equal(secret.supabaseSource, "absent");
  assert.equal(secret.supabasePublishableKey, "");

  const renamed = decideSupabase({
    SUPABASE_URL: "https://autre-projet.supabase.co",
    SUPABASE_PUBLISHABLE_KEY: "sb_publishable_preview_check",
    KLIR_PRODUCTION_SUPABASE_URL: "https://autre-projet.supabase.co"
  }, "preview");
  assert.equal(renamed.supabaseSource, "production-blocked");
  assert.equal(renamed.supabaseUrl, "");

  const unlabeled = decideSupabase({ WORKERS_CI: "1", CI: "true" }, "inconnu");
  assert.equal(unlabeled.fetchPublic, false);
  assert.equal(unlabeled.supabaseSource, "absent");
});

test("le build ne copie le site public que hors prévisualisation", async () => {
  const build = await readFile(new URL("../tools/build.mjs", import.meta.url), "utf8");
  assert.equal(build.includes("if (!decision.fetchPublic)"), true);
  assert.equal(build.includes("allowsPublicConfig"), true);
  assert.equal(build.includes("WORKERS_CI ? \"production\""), false);
  assert.equal(build.includes("pilotEmails"), false);
});
