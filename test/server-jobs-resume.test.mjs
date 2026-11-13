import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { listRecoverableServerJobs, awaitServerJob } from "../src/server-jobs.js";

const root = new URL("../src/", import.meta.url);
const app = await readFile(new URL("app.js", root), "utf8");
const authSource = await readFile(new URL("auth.js", root), "utf8");
const serverJobsSource = await readFile(new URL("server-jobs.js", root), "utf8");

const DONE = "596ea232-890b-4c00-9a30-2339782a7454";
const KNOWN = "11111111-1111-4111-8111-111111111111";
const REMOVED = "33333333-3333-4333-8333-333333333333";
const QUEUED = "44444444-4444-4444-8444-444444444444";
const FAILED = "55555555-5555-4555-8555-555555555555";
const payload = { place_status: "supported", cityKey: "montréal", industry: "restauration", quantity: 10, source: "overture-places-pilot", coverage: "rayon_2200m_six_centres" };

// Base simulée : seules les lectures de tables sont permises. Toute RPC ou fonction serveur échoue le test.
function fakeSupabase() {
  const calls = { tables: [], rpc: [], invoke: [] };
  const jobs = [
    { id: DONE, status: "succeeded", ledger_status: "complete", result_count: 10, idempotency_key: "job_tab_key", created_at: "2026-11-13T19:17:20Z", payload },
    { id: KNOWN, status: "succeeded", ledger_status: "complete", result_count: 10, idempotency_key: "k1", created_at: "2026-11-12T10:00:00Z", payload },
    { id: REMOVED, status: "succeeded", ledger_status: "complete", result_count: 10, idempotency_key: "k3", created_at: "2026-11-12T09:00:00Z", payload },
    { id: QUEUED, status: "queued", ledger_status: "open", result_count: null, idempotency_key: "k4", created_at: "2026-11-13T19:30:00Z", payload },
    { id: FAILED, status: "failed", ledger_status: "released", result_count: 0, idempotency_key: "k5", created_at: "2026-11-11T09:00:00Z", payload }
  ];
  const places = Array.from({ length: 10 }, (_, index) => ({
    job_id: DONE, name: ["Agua Farina", "Bloom Sushi", "En Cachette Speakeasy"][index] || `Restaurant ${index}`,
    basic_category: index === 2 ? "bar" : "restaurant", release: "2026-10-21.0", contacts_verified: false, created_at: "2026-11-13T19:18:01Z"
  }));
  const supabase = {
    from(table) {
      const query = { table, filters: [] };
      calls.tables.push(query);
      const chain = {
        select(columns) { query.columns = columns; return chain; },
        eq(column, value) { query.filters.push([column, value]); return chain; },
        order() { return chain; },
        limit(value) {
          query.limit = value;
          if (table === "search_jobs") return Promise.resolve({ data: jobs, error: null });
          if (table === "search_job_places") {
            const id = (query.filters.find(([column]) => column === "job_id") || [])[1];
            return Promise.resolve({ data: places.filter((row) => row.job_id === id), error: null });
          }
          return Promise.resolve({ data: null, error: { message: "table interdite" } });
        }
      };
      return chain;
    },
    rpc(name) { calls.rpc.push(name); throw new Error("aucune RPC pendant la reprise"); },
    functions: { invoke(name) { calls.invoke.push(name); throw new Error("aucune fonction pendant la reprise"); } }
  };
  return { supabase, calls };
}

test("la reprise lit seulement search_jobs et search_job_places, sans RPC ni fonction serveur", async () => {
  const { supabase, calls } = fakeSupabase();
  const found = await listRecoverableServerJobs(supabase, { knownSearchIds: ["job_" + KNOWN], removedSearchIds: ["job_" + REMOVED] });
  assert.equal(found.ok, true);
  assert.deepEqual(found.completed.map((item) => item.job.id), [DONE]);
  assert.equal(found.completed[0].places.length, 10);
  assert.deepEqual(found.active.map((job) => job.id), [QUEUED]);
  assert.deepEqual(calls.rpc, []);
  assert.deepEqual(calls.invoke, []);
  assert.deepEqual([...new Set(calls.tables.map((query) => query.table))].sort(), ["search_job_places", "search_jobs"]);
  assert.equal(calls.tables.filter((query) => query.table === "search_job_places").length, 1, "fiches lues pour le seul job à rattacher");
  assert.equal(/\.rpc\(|functions\.invoke|settle|reserve|enqueue/.test(serverJobsSource), false);
});

test("le suivi d'un job déjà en file ne remet rien en file", async () => {
  const seen = [];
  const steps = ["queued", "running", "succeeded"];
  const job = await awaitServerJob(async (id) => { seen.push(id); return { status: steps.shift() }; }, { id: QUEUED, status: "queued" }, { sleep: async () => {} });
  assert.equal(job.status, "succeeded");
  assert.deepEqual(seen, [QUEUED, QUEUED, QUEUED]);
});

async function appHarness({ searches = [], removed = [] } = {}) {
  const { supabase, calls } = fakeSupabase();
  const counters = { searchJob: 0, resume: [], spend: 0, notices: [], saves: 0, renders: 0 };
  const session = new Map([["klir-search-job-pending-user-1", JSON.stringify({ key: "job_tab_key", payload })]]);
  const sandbox = {
    console: { info() {}, warn() {}, error() {}, log() {} },
    URL, Date, Map, Set, structuredClone,
    setTimeout(fn) { fn(); return 0; }, clearTimeout() {},
    hx: (value) => String(value ?? ""), esc: (value) => String(value ?? ""),
    sessionStorage: { getItem: (key) => session.get(key) ?? null, setItem: (key, value) => session.set(key, value), removeItem: (key) => session.delete(key) },
    document: { getElementById: () => null, querySelectorAll: () => [] },
    authState: { user: { id: "user-1", email: "contact@example.invalid" } },
    syncSeq: 7, historyLoadFailed: false, appBootstrapped: true,
    searchRunning: false, radarRunning: false, sel: new Set(), selExplicit: false, selSearch: null, curSearch: null,
    alert() {}, nav() {}, render() { counters.renders += 1; },
    spendCredits() { counters.spend += 1; throw new Error("aucun débit local"); }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(await readFile(new URL("data.js", root), "utf8"), sandbox);
  vm.runInContext(await readFile(new URL("engine.js", root), "utf8"), sandbox);
  sandbox.E = sandbox.KlirEngine;
  sandbox.sectorLabel = (key) => sandbox.KlirEngine.industryLabel(key);
  vm.runInContext(app.slice(app.indexOf("async function runSearch"), app.indexOf("function toCrm")), sandbox);
  sandbox.KS = {
    S: { plan: "Free", demo: false, usage: { searches: 1, prospects: 0 }, credits: { balance: 176 }, searches: [...searches], prospects: [], removedSearchIds: [...removed], icp: null, weights: {}, opps: [] },
    uid: () => "uid", save() { counters.saves += 1; }, addActivity() {}, audit() {},
    notify: (message) => counters.notices.push(message)
  };
  sandbox.KlirAuth = {
    async searchJob() { counters.searchJob += 1; throw new Error("aucune nouvelle recherche"); },
    syncServerJobs: (options) => listRecoverableServerJobs(supabase, options),
    async resumeServerJob(job) {
      counters.resume.push(job.id);
      return { ok: true, outcome: "termine", job: { ...job, status: "succeeded" }, balance: 176, searches: 1,
        places: [{ name: "Restaurant repris", basic_category: "restaurant", release: "2026-10-21.0", contacts_verified: false }] };
    }
  };
  return { sandbox, calls, counters, session };
}

test("job terminé pendant un rechargement : historique restauré une seule fois, sans débit ni réservation", async () => {
  const { sandbox, calls, counters, session } = await appHarness({ searches: [{ id: "job_" + KNOWN, label: "ancienne" }], removed: ["job_" + REMOVED] });
  const added = await sandbox.restoreServerJobs(7);
  assert.equal(added, 1);
  // Laisse la reprise du job en file se terminer.
  await new Promise((resolve) => setImmediate(resolve));
  const ids = sandbox.KS.S.searches.map((s) => s.id);
  assert.equal(ids.includes("job_" + DONE), true);
  assert.equal(ids.includes("job_" + REMOVED), false, "une recherche supprimée n'est pas réinsérée");
  assert.equal(ids.includes("job_" + FAILED), false, "un job échoué n'ajoute rien");
  assert.equal(ids.filter((id) => id === "job_" + KNOWN).length, 1);
  const restored = sandbox.KS.S.searches.find((s) => s.id === "job_" + DONE);
  assert.equal(restored.jobId, DONE);
  assert.equal(restored.total, 10);
  assert.match(restored.label, /Montréal — 10 fiches \(file serveur\)/);
  const names = sandbox.KS.S.prospects.filter((p) => p.searchId === "job_" + DONE).map((p) => p.company_name);
  assert.equal(names.length, 10);
  assert.deepEqual([...names.slice(0, 3)], ["Agua Farina", "Bloom Sushi", "En Cachette Speakeasy"]);
  // Le job encore en file est suivi, sans nouvelle mise en file.
  assert.deepEqual(counters.resume, [QUEUED]);
  assert.equal(ids.includes("job_" + QUEUED), true);
  // Aucun débit, aucune réservation, aucune nouvelle recherche ; solde inchangé.
  assert.equal(counters.searchJob, 0);
  assert.equal(counters.spend, 0);
  assert.deepEqual(calls.rpc, []);
  assert.deepEqual(calls.invoke, []);
  assert.equal(sandbox.KS.S.credits.balance, 176);
  assert.equal(sandbox.KS.S.usage.searches, 1);
  assert.equal(counters.notices.some((message) => /Aucun nouveau débit/.test(message)), true);
  // La clé de reprise de l'onglet ne pointe plus vers le job terminé.
  assert.equal(session.has("klir-search-job-pending-user-1"), false);
  // Second chargement : aucun doublon.
  const again = await sandbox.restoreServerJobs(7);
  assert.equal(again, 0);
  assert.equal(sandbox.KS.S.searches.filter((s) => s.id === "job_" + DONE).length, 1);
  assert.equal(sandbox.KS.S.prospects.filter((p) => p.searchId === "job_" + DONE).length, 10);
});

test("aucune reprise en démo, sans session, si l'historique n'a pas chargé ou si la session a changé", async () => {
  for (const tweak of [
    (s) => { s.KS.S.demo = true; },
    (s) => { s.authState = { user: null }; },
    (s) => { s.historyLoadFailed = true; }
  ]) {
    const { sandbox, calls } = await appHarness();
    tweak(sandbox);
    assert.equal(await sandbox.restoreServerJobs(7), 0);
    assert.equal(sandbox.KS.S.searches.length, 0);
    assert.equal(calls.tables.length, 0);
  }
  const { sandbox } = await appHarness();
  assert.equal(await sandbox.restoreServerJobs(6), 0, "une hydratation dépassée n'écrit rien");
  assert.equal(sandbox.KS.S.searches.length, 0);
});

test("l'hydratation appelle la reprise et l'écran d'attente annonce qu'on peut recharger", () => {
  const sync = app.slice(app.indexOf("async function syncAuthState"), app.indexOf("async function leaveAccount"));
  assert.match(sync, /await applyServerLedger\(\);\s*if\(seq!==syncSeq\)return;\s*await restoreServerJobs\(seq\);/);
  assert.match(app, /Vous pouvez recharger la page : la recherche continue côté serveur/);
  const run = app.slice(app.indexOf("async function runSearch"), app.indexOf("// En-tête des résultats Overture"));
  assert.match(run, /recordServerJobResult\(job,places,params,q\)/);
  assert.match(authSource, /syncServerJobs,\n  resumeServerJob,/);
  const resume = authSource.slice(authSource.indexOf("async function syncServerJobs"), authSource.indexOf("async function initialize"));
  assert.equal(/\.rpc\(|action: "enqueue"/.test(resume), false);
});
