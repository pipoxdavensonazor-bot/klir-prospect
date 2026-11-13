import test from "node:test";
import assert from "node:assert/strict";
import { ALLOWED_PROJECTS, resolveProject, assertProjectRunnerIdentity } from "../supabase/functions/_shared/search-job-projects.mjs";

const base = (ref, role, envName) => ({
  SUPABASE_URL: `https://${ref}.supabase.co`, KLIR_ENV: envName,
  KLIR_JOB_DB_HOST: "aws-1-ca-central-1.pooler.supabase.com", KLIR_JOB_DB_PORT: "6543",
  KLIR_JOB_DB_NAME: "postgres", KLIR_JOB_DB_USER: `${role}.${ref}`
});

test("liste blanche : exactement Test et Prod, chacun avec son rôle de connexion", () => {
  assert.deepEqual(Object.keys(ALLOWED_PROJECTS).sort(), ["cbklwmjudobqwbkbxqgy", "pwakjxjjxswdjsapsbxn"]);
  assert.equal(ALLOWED_PROJECTS.pwakjxjjxswdjsapsbxn.connectRole, "klir_job_connect_test");
  assert.equal(ALLOWED_PROJECTS.cbklwmjudobqwbkbxqgy.connectRole, "klir_job_runner_prod");
  assert.equal(ALLOWED_PROJECTS.cbklwmjudobqwbkbxqgy.env, "production");
  assert.equal(Object.isFrozen(ALLOWED_PROJECTS), true);
});

test("tout autre projet, ou une URL déguisée, est refusé", () => {
  for (const url of ["", "https://abcdefghijklmnopqrst.supabase.co", "https://cbklwmjudobqwbkbxqgy.supabase.co.evil.com",
    "http://pwakjxjjxswdjsapsbxn.supabase.co", "https://evil.com/?cbklwmjudobqwbkbxqgy"]) {
    assert.throws(() => resolveProject({ SUPABASE_URL: url }), /projet_refuse|configuration_absente/, url);
  }
  assert.equal(resolveProject({ SUPABASE_URL: "https://cbklwmjudobqwbkbxqgy.supabase.co/" }).target, "production");
});

test("identité runner : rôle, environnement et projet doivent concorder", () => {
  assert.equal(assertProjectRunnerIdentity(base("pwakjxjjxswdjsapsbxn", "klir_job_connect_test", "preview")).target, "test");
  assert.equal(assertProjectRunnerIdentity(base("cbklwmjudobqwbkbxqgy", "klir_job_runner_prod", "production")).target, "production");
  assert.throws(() => assertProjectRunnerIdentity(base("cbklwmjudobqwbkbxqgy", "klir_job_connect_test", "production")), /role_connexion_refuse/);
  assert.throws(() => assertProjectRunnerIdentity(base("pwakjxjjxswdjsapsbxn", "klir_job_runner_prod", "preview")), /role_connexion_refuse/);
  assert.throws(() => assertProjectRunnerIdentity(base("cbklwmjudobqwbkbxqgy", "klir_job_runner_prod", "preview")), /environnement_refuse/);
  assert.throws(() => assertProjectRunnerIdentity({ ...base("cbklwmjudobqwbkbxqgy", "klir_job_runner_prod", "production"), KLIR_JOB_DB_HOST: "db.cbklwmjudobqwbkbxqgy.supabase.co" }), /hote_pooler_refuse/);
});
