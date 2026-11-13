import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createSearchJobRunner } from "../supabase/functions/_shared/search-job-runner.mjs";
import { handleSearchJob } from "../supabase/functions/_shared/search-job-http.mjs";
import { createGetUserVerifier } from "../supabase/functions/_shared/search-job-auth.mjs";
import { consumeSearchJob } from "../supabase/functions/_shared/search-job-store.mjs";

const ada = "11111111-1111-4111-8111-111111111111";
const bea = "22222222-2222-4222-8222-222222222222";
const supported = { place_status: "supported", cityKey: "laval" };

function failure(code, retryable = true) {
  const error = new Error(code);
  error.code = code;
  error.retryable = retryable;
  return error;
}

test("la file simulée est idempotente, reprend, annule et ouvre le disjoncteur", async () => {
  let clock = 1_000;
  const calls = [];
  const runner = createSearchJobRunner({
    async run(payload, context) {
      calls.push({ attempt: context.attempt, city: payload.cityKey, cancelled: context.isCancelled() });
      if (context.attempt < 2) throw failure("provider_502");
      return { rows: 1 };
    }
  }, { now: () => clock, limits: { breakerThreshold: 3, breakerCooldownMs: 30_000, maxAttempts: 3 } });

  const first = runner.enqueue({ userId: ada, idempotencyKey: "receipt-job-1", payload: supported });
  const second = runner.enqueue({ userId: ada, idempotencyKey: "receipt-job-1", payload: supported });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.job, first.job);
  assert.equal(runner.cancel(bea, first.job.id), null);

  const done = await runner.run(first.job);
  assert.equal(done.status, "succeeded");
  assert.equal(done.attempt, 2);
  assert.equal(done.progress, 100);
  assert.deepEqual(calls.map((call) => call.attempt), [1, 2]);
  assert.equal(calls.every((call) => call.city === "laval"), true);
  const repeated = await runner.run(first.job);
  assert.equal(repeated.attempt, 2);

  const queued = runner.enqueue({ userId: ada, idempotencyKey: "receipt-job-2", payload: supported });
  assert.equal(runner.cancel(ada, queued.job.id).status, "cancelled");
  const adapterCalls = calls.length;
  await runner.run(queued.job);
  assert.equal(queued.job.status, "cancelled");
  assert.equal(calls.length, adapterCalls);

  let current = null;
  const cancelling = createSearchJobRunner({
    async run(_payload, context) {
      current.cancelRequested = true;
      assert.equal(context.isCancelled(), true);
      throw failure("provider_timeout");
    }
  });
  const running = cancelling.enqueue({ userId: ada, idempotencyKey: "receipt-job-3", payload: supported });
  current = running.job;
  const stopped = await cancelling.run(running.job);
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.progress <= 100, true);

  let brokenClock = 5_000;
  let attempts = 0;
  const broken = createSearchJobRunner({
    async run() {
      attempts += 1;
      throw failure("provider_429");
    }
  }, { now: () => brokenClock, limits: { breakerThreshold: 3, breakerCooldownMs: 30_000, maxAttempts: 3 } });
  const exploded = broken.enqueue({ userId: ada, idempotencyKey: "receipt-job-4", payload: supported });
  const failed = await broken.run(exploded.job);
  assert.equal(failed.status, "failed");
  assert.equal(failed.attempt, 3);
  assert.equal(broken.circuitState(), "open");
  assert.throws(() => broken.enqueue({ userId: ada, idempotencyKey: "receipt-job-5", payload: supported }), /circuit_open/);
  brokenClock += 30_000;
  assert.equal(broken.circuitState(), "half_open");
  const recovered = broken.enqueue({ userId: bea, idempotencyKey: "receipt-job-5", payload: supported });
  assert.equal(recovered.created, true);
  assert.equal(attempts, 3);
  assert.throws(() => broken.enqueue({ userId: ada, idempotencyKey: "receipt-bad-place", payload: { place_status: "unsupported" } }), /place_rejected/);
  assert.throws(() => broken.enqueue({ userId: "", idempotencyKey: "receipt-job-9", payload: supported }), /authentication_required/);
});

function request(method, token, body, url = "https://jobs.local/search-jobs") {
  return new Request(url, {
    method,
    headers: token ? { authorization: "Bearer " + token, "content-type": "application/json" } : { "content-type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body)
  });
}

function deps(overrides = {}) {
  const jobs = new Map();
  const calls = { enqueue: 0, adapter: 0 };
  const base = {
    jobsEnabled: async () => false,
    verifyJwt: async (token) => token === "ada-token" ? { id: ada } : token === "bea-token" ? { id: bea } : null,
    rateLimit: async () => false,
    async readJob(userId, id) {
      const job = jobs.get(id);
      return job && job.userId === userId ? job : null;
    },
    async cancelJob(userId, id) {
      const job = jobs.get(id);
      if (!job || job.userId !== userId) return null;
      job.status = "cancelled";
      return job;
    },
    async enqueue(input) {
      calls.enqueue += 1;
      const id = input.userId + ":" + input.idempotencyKey;
      if (jobs.has(id)) return { job: jobs.get(id), created: false };
      const job = { id, userId: input.userId, status: "queued", progress: 0, attempt: 0 };
      jobs.set(id, job);
      return { job, created: true };
    },
    calls
  };
  return { ...base, ...overrides, calls, jobs };
}

test("l'entrée HTTP exige un JWT, le drapeau, le plafond et le propriétaire", async () => {
  const closed = deps();
  const disabled = await handleSearchJob(request("POST", "ada-token", { action: "enqueue", idempotencyKey: "receipt-job-1", payload: supported }), closed);
  assert.equal(disabled.status, 403);
  assert.deepEqual(await disabled.json(), { error: "jobs_disabled" });
  assert.equal(closed.calls.enqueue, 0);

  const missing = await handleSearchJob(request("POST", "", { action: "enqueue" }), deps({ jobsEnabled: async () => true }));
  assert.equal(missing.status, 401);
  const stranger = await handleSearchJob(request("POST", "nope", { action: "enqueue", idempotencyKey: "receipt-job-1", payload: supported }), deps({ jobsEnabled: async () => true }));
  assert.equal(stranger.status, 401);

  const open = deps({ jobsEnabled: async () => true });
  const rejected = await handleSearchJob(request("POST", "ada-token", { action: "enqueue", idempotencyKey: "receipt-job-1", payload: { place_status: "unsupported" } }), open);
  assert.equal(rejected.status, 422);
  assert.equal(open.calls.enqueue, 0);

  const limited = deps({ jobsEnabled: async () => true, rateLimit: async () => true });
  const tooMany = await handleSearchJob(request("POST", "ada-token", { action: "enqueue", idempotencyKey: "receipt-job-1", payload: supported }), limited);
  assert.equal(tooMany.status, 429);
  assert.equal(limited.calls.enqueue, 0);

  const store = deps({ jobsEnabled: async () => true });
  const created = await handleSearchJob(request("POST", "ada-token", { action: "enqueue", idempotencyKey: "receipt-job-1", payload: supported }), store);
  assert.equal(created.status, 200);
  const body = await created.json();
  assert.equal(body.created, true);
  const again = await handleSearchJob(request("POST", "ada-token", { action: "enqueue", idempotencyKey: "receipt-job-1", payload: supported }), store);
  assert.equal((await again.json()).created, false);
  assert.equal(store.calls.enqueue, 2);

  const hidden = await handleSearchJob(request("GET", "bea-token", null, "https://jobs.local/search-jobs?id=" + body.job.id), store);
  assert.equal(hidden.status, 404);
  const seen = await handleSearchJob(request("GET", "ada-token", null, "https://jobs.local/search-jobs?id=" + body.job.id), store);
  assert.equal(seen.status, 200);
  const stolen = await handleSearchJob(request("POST", "bea-token", { action: "cancel", jobId: body.job.id }), store);
  assert.equal(stolen.status, 404);
  const cancelled = await handleSearchJob(request("POST", "ada-token", { action: "cancel", jobId: body.job.id }), store);
  assert.equal((await cancelled.json()).status, "cancelled");

  const entry = await readFile(new URL("../supabase/functions/search-jobs/index.ts", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(entry, /handleSearchJobRequest/);
  assert.equal(entry.includes("SUPABASE_SERVICE_ROLE_KEY"), false);
  assert.equal(entry.includes("SUPABASE_DB_URL"), false);
  assert.equal(entry.includes("local:"), false);
  assert.equal(app.includes("search-jobs"), false);
  assert.equal(app.includes("enqueue_search_job"), false);
});

test("le vérificateur JWT et le consommateur s'injectent sans clé ni débit", async () => {
  const verifier = createGetUserVerifier(async (token) => {
    if (token === "bon") return { data: { user: { id: ada } }, error: null };
    if (token === "panne") throw new Error("réseau");
    return { data: { user: null }, error: { message: "invalid" } };
  });
  assert.deepEqual(await verifier("bon"), { id: ada });
  assert.equal(await verifier("mauvais"), null);
  assert.equal(await verifier("panne"), null);
  assert.throws(() => createGetUserVerifier(null), /getUser_required/);

  const calls = [];
  const observed = await consumeSearchJob({
    job: { userId: ada, status: "queued", attempt: 0, payload: supported, cancelRequested: false },
    adapter: {
      async run(_payload, context) {
        calls.push(context.attempt);
        if (context.attempt === 1) {
          const error = new Error("provider_502");
          error.code = "provider_502";
          error.retryable = true;
          throw error;
        }
        return { count: 2 };
      }
    }
  });
  assert.equal(observed.status, "observed");
  assert.equal(observed.outcome, "complete");
  assert.deepEqual(calls, [1, 2]);
  assert.equal(observed.progress, 100);

  const empty = await consumeSearchJob({
    job: { userId: ada, status: "queued", attempt: 0, payload: supported },
    adapter: { async run() { return { count: 0 }; } }
  });
  assert.equal(empty.outcome, "empty");

  const live = { userId: ada, status: "queued", attempt: 0, payload: supported, cancelRequested: false };
  const stoppedMidway = await consumeSearchJob({
    job: live,
    adapter: {
      async run() {
        live.cancelRequested = true;
        const error = new Error("stop");
        error.code = "provider_timeout";
        error.retryable = true;
        throw error;
      }
    }
  });
  assert.equal(stoppedMidway.status, "cancelled");

  const stopped = await consumeSearchJob({
    job: { userId: ada, status: "cancelled", payload: supported },
    adapter: { async run() { throw new Error("ne doit pas partir"); } }
  });
  assert.equal(stopped.status, "cancelled");
  const source = await readFile(new URL("../supabase/functions/_shared/search-job-auth.mjs", import.meta.url), "utf8");
  assert.equal(source.includes("SERVICE_ROLE"), false);
  assert.equal(source.includes("createClient"), false);
});
