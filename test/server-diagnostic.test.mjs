import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  PROD_SUPABASE_URL,
  TEST_SUPABASE_URL,
  createServerDiagnostic,
  publicDiagnosticBody,
  serverDiagnosticAllowed
} from "../src/server-diagnostic.js";

const success = {
  connected: true,
  role: "klir_job_runner",
  jobsEnabled: false,
  billing: "refuse",
  provider: "absent",
  executed: false,
  scheduler: "off"
};

function harness(overrides = {}) {
  const calls = { admin: 0, invoke: 0 };
  const diagnose = createServerDiagnostic({
    config: () => ({ environment: "preview", supabaseUrl: TEST_SUPABASE_URL, ...overrides.config }),
    session: () => (Object.hasOwn(overrides, "session") ? overrides.session : { user: { id: "user" } }),
    isAdmin: async () => {
      calls.admin += 1;
      return overrides.admin === undefined ? true : overrides.admin;
    },
    invoke: async () => {
      calls.invoke += 1;
      if (overrides.fail) throw new Error("réseau");
      return overrides.response || { data: success, error: false, status: 200 };
    }
  });
  return { diagnose, calls };
}

test("le bouton n'existe que pour la prévisualisation du projet Test", () => {
  assert.equal(serverDiagnosticAllowed({ environment: "preview", supabaseUrl: TEST_SUPABASE_URL }), true);
  assert.equal(serverDiagnosticAllowed({ environment: "production", supabaseUrl: TEST_SUPABASE_URL }), false);
  assert.equal(serverDiagnosticAllowed({ environment: "preview", supabaseUrl: PROD_SUPABASE_URL }), false);
  assert.equal(serverDiagnosticAllowed({ environment: "preview", supabaseUrl: "https://autre.supabase.co" }), false);
  assert.equal(serverDiagnosticAllowed({ environment: "preview" }), false);
});

test("un compte absent ou non admin n'appelle pas le runner", async () => {
  const absent = harness({ session: null });
  assert.equal((await absent.diagnose()).outcome, "session_requise");
  assert.equal(absent.calls.invoke, 0);
  const standard = harness({ admin: false });
  assert.equal((await standard.diagnose()).outcome, "compte_non_admin");
  assert.equal(standard.calls.invoke, 0);
});

test("la production et un autre projet n'ouvrent aucun appel", async () => {
  const prod = harness({ config: { environment: "preview", supabaseUrl: PROD_SUPABASE_URL } });
  assert.equal((await prod.diagnose()).outcome, "environnement_refuse");
  const other = harness({ config: { environment: "production", supabaseUrl: TEST_SUPABASE_URL } });
  assert.equal((await other.diagnose()).outcome, "environnement_refuse");
  assert.equal(prod.calls.invoke + other.calls.invoke, 0);
});

test("une réponse admin simulée confirme l'état réel attendu du runner", async () => {
  const { diagnose, calls } = harness();
  const result = await diagnose();
  assert.equal(result.ok, true);
  assert.equal(result.summary.role, "klir_job_runner");
  assert.equal(result.summary.jobsEnabled, false);
  assert.equal(result.summary.billing, "refuse");
  assert.equal(result.summary.provider, "absent");
  assert.equal(result.summary.executed, false);
  assert.equal(calls.invoke, 1);
  assert.equal(JSON.stringify(result).includes("eyJ"), false);
});

test("un moteur allumé ou une réponse incomplète n'est pas présenté comme prêt", async () => {
  const running = harness({ response: { data: { ...success, jobsEnabled: true }, error: false, status: 200 } });
  assert.equal((await running.diagnose()).outcome, "reponse_inattendue");
  const missing = harness({ response: { data: { connected: true }, error: false, status: 200 } });
  assert.equal((await missing.diagnose()).outcome, "reponse_inattendue");
});

test("session expirée, refus admin du serveur et panne restent distincts", async () => {
  const expired = harness({ response: { data: { error: "authentication_required" }, error: true, status: 401 } });
  assert.equal((await expired.diagnose()).outcome, "session_expiree");
  const refused = harness({ response: { data: { error: "autorisation_refusee" }, error: true, status: 403 } });
  assert.equal((await refused.diagnose()).outcome, "compte_non_admin");
  const down = harness({ fail: true });
  assert.equal((await down.diagnose()).outcome, "panne");
  const gateway = harness({ response: { data: null, error: true, status: 503 } });
  assert.equal((await gateway.diagnose()).outcome, "panne");
  const broad = harness({ response: { data: { error: "role_trop_large", password: "secret" }, error: true, status: 503 } });
  const broadResult = await broad.diagnose();
  assert.equal(broadResult.outcome, "role_trop_large");
  assert.deepEqual(publicDiagnosticBody({ error: "role_trop_large", password: "secret", access_token: "jeton" }), { error: "role_trop_large" });
  assert.equal(JSON.stringify(broadResult).includes("secret"), false);
});

test("un second clic pendant la vérification n'envoie pas un second appel", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const diagnose = createServerDiagnostic({
    config: () => ({ environment: "preview", supabaseUrl: TEST_SUPABASE_URL }),
    session: () => ({ user: { id: "user" } }),
    isAdmin: async () => true,
    invoke: async () => {
      calls += 1;
      await pending;
      return { data: success, error: false, status: 200 };
    }
  });
  const first = diagnose();
  const second = await diagnose();
  assert.equal(second.outcome, "deja_en_cours");
  assert.equal(calls, 1);
  release();
  assert.equal((await first).outcome, "connecte");
  assert.equal((await diagnose()).outcome, "connecte");
  assert.equal(calls, 2);
});

test("le client passe par functions.invoke et le bouton reste hors des réglages hors essai", async () => {
  const auth = await readFile(new URL("../src/auth.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(auth, /functions\.invoke\("search-job-runner", \{ body: \{ action: "diagnose" \} \}\)/);
  assert.equal(auth.includes("access_token"), false);
  assert.equal(auth.includes("localStorage"), false);
  const card = app.slice(app.indexOf("function serverDiagnosticCard"), app.indexOf("function vTrialSettings"));
  const trial = app.slice(app.indexOf("function vTrialSettings"), app.indexOf("function exportCrmCsvText"));
  const settings = app.slice(app.indexOf("function vSettings()"), app.indexOf("function vAdmin"));
  assert.match(card, /id="serverDiagnosticBtn"/);
  assert.match(card, /Vérifier la connexion serveur/);
  assert.match(trial, /serverDiagnosticCard\(\)/);
  assert.equal(settings.includes("serverDiagnosticBtn"), false);
  assert.equal(settings.includes("serverDiagnosticCard"), false);
  assert.equal(app.includes("enqueue_search_job"), false);
});
