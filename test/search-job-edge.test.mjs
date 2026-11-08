import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { handleSearchJobRequest, resolveTestAuth, searchJobExecutionPlan, TEST_SUPABASE_URL, PREVIEW_ORIGIN } from "../supabase/functions/_shared/search-job-edge.mjs";

const ada = "11111111-1111-4111-8111-111111111111";
const publishable = "sb_publishable_test_fixture";

function env(extra = {}) {
  return {
    SUPABASE_URL: TEST_SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: publishable,
    ...extra
  };
}

function request(method, token, body, path = "/search-jobs") {
  return new Request(`http://127.0.0.1${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
}

function fakeClient(behavior) {
  const calls = [];
  const client = {
    auth: {
      async getUser(jwt) {
        calls.push({ op: "getUser", jwt });
        if (behavior.user === null) return { data: { user: null }, error: { message: "invalid" } };
        return { data: { user: { id: behavior.user || ada } }, error: null };
      }
    },
    async rpc(name, args) {
      calls.push({ op: "rpc", name, args });
      return behavior.rpc ? behavior.rpc(name, args) : { data: null, error: { message: "jobs_disabled" } };
    },
    from(table) {
      return {
        select() {
          return {
            eq(_column, id) {
              return {
                async maybeSingle() {
                  calls.push({ op: "select", table, id });
                  return behavior.select || { data: null, error: null };
                }
              };
            }
          };
        }
      };
    }
  };
  return {
    calls,
    createClient() {
      calls.push({ op: "create" });
      return client;
    }
  };
}

test("sans URL Test, ou avec la production, rien n'est appelé", async () => {
  let called = false;
  const createClientSpy = () => {
    called = true;
    throw new Error("client_interdit");
  };
  const missing = await handleSearchJobRequest(request("POST", "jeton", { action: "enqueue" }), {
    env: {},
    createClient: createClientSpy
  });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).error, "configuration_absente");
  const prod = await handleSearchJobRequest(request("GET", "", null, "/healthz"), {
    env: { SUPABASE_URL: "https://cbklwmjudobqwbkbxqgy.supabase.co", SUPABASE_PUBLISHABLE_KEY: publishable },
    createClient: createClientSpy
  });
  assert.equal(prod.status, 503);
  assert.equal((await prod.json()).error, "production_refusee");
  assert.equal(called, false);
  assert.throws(() => resolveTestAuth({
    SUPABASE_URL: TEST_SUPABASE_URL,
    SUPABASE_PUBLISHABLE_KEY: "sb_secret_test_fixture"
  }), /cle_secrete_refusee/);
});

test("healthz décrit une API JWT et un runner non connecté, sans secret", async () => {
  const response = await handleSearchJobRequest(request("GET", "", null, "/healthz"), { env: env() });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.operational, false);
  assert.equal(body.runner, "non_connecte");
  assert.equal(body.provider, "absent");
  assert.equal(body.scheduler, "planificateur_non_choisi");
  assert.equal(body.auth, "getUser");
  assert.equal(body.keySource, "SUPABASE_PUBLISHABLE_KEY");
  assert.equal(JSON.stringify(body).includes(publishable), false);
  assert.deepEqual(searchJobExecutionPlan().runnable, false);
});

test("un jeton local est refusé et le moteur éteint ne réserve rien", async () => {
  const fake = fakeClient({});
  const local = await handleSearchJobRequest(request("POST", `local:${ada}`, {
    action: "enqueue",
    idempotencyKey: "edge-local-0001",
    payload: { place_status: "supported", cityKey: "laval", quantity: 10 }
  }), { env: env(), createClient: fake.createClient });
  assert.equal(local.status, 401);
  assert.equal((await local.json()).error, "jeton_local_refuse");
  assert.equal(fake.calls.some((call) => call.op === "create"), false);

  const disabled = fakeClient({});
  const queued = await handleSearchJobRequest(request("POST", "jeton-ada", {
    action: "enqueue",
    idempotencyKey: "edge-ada-0001",
    payload: { place_status: "supported", cityKey: "laval", quantity: 10 }
  }), { env: env(), createClient: disabled.createClient });
  assert.equal(queued.status, 403);
  assert.equal((await queued.json()).error, "jobs_disabled");
  assert.equal(disabled.calls.some((call) => call.op === "rpc" && call.name === "enqueue_search_job"), true);
  assert.equal(disabled.calls.some((call) => call.op === "getUser" && call.jwt === "jeton-ada"), true);
});

test("la lecture reste un SELECT sous le JWT et le client réel appelle getUser", async () => {
  const fake = fakeClient({
    select: { data: { id: "job-1", status: "queued", attempt: 0, progress: 0, ledger_status: "open" }, error: null }
  });
  const read = await handleSearchJobRequest(request("GET", "jeton-ada", null, "/search-jobs?id=job-1"), {
    env: env({ SUPABASE_PUBLISHABLE_KEYS: JSON.stringify({ default: publishable }), SUPABASE_PUBLISHABLE_KEY: "" }),
    createClient: fake.createClient
  });
  assert.equal(read.status, 200);
  assert.equal((await read.json()).id, "job-1");
  assert.equal(fake.calls.some((call) => call.op === "select" && call.table === "search_jobs" && call.id === "job-1"), true);

  const hidden = fakeClient({ select: { data: null, error: null } });
  const missing = await handleSearchJobRequest(request("GET", "jeton-ced", null, "/search-jobs?id=job-1"), {
    env: env(),
    createClient: hidden.createClient
  });
  assert.equal(missing.status, 404);

  const seen = [];
  const fetchImpl = async (url, init) => {
    const target = new URL(String(url));
    const headers = init && init.headers;
    const read = (name) => headers && typeof headers.get === "function" ? headers.get(name) || "" : "";
    seen.push({
      host: target.host,
      path: target.pathname,
      authorization: read("authorization"),
      apikey: read("apikey")
    });
    if (target.pathname !== "/auth/v1/user") return new Response("{}", { status: 404 });
    return new Response(JSON.stringify({ id: ada, aud: "authenticated", role: "authenticated" }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };
  const response = await handleSearchJobRequest(request("POST", "jeton-opaque", {
    action: "enqueue",
    idempotencyKey: "edge-ada-0002",
    payload: { place_status: "absent", quantity: 10 }
  }), {
    env: env(),
    createClient,
    fetch: fetchImpl
  });
  assert.equal(response.status, 422);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].host, "pwakjxjjxswdjsapsbxn.supabase.co");
  assert.equal(seen[0].path, "/auth/v1/user");
});

test("la prévisualisation Test peut appeler l'API jobs, le site public non", async () => {
  const preview = new Request("http://127.0.0.1/search-jobs", { method: "OPTIONS", headers: { origin: PREVIEW_ORIGIN } });
  const allowed = await handleSearchJobRequest(preview, { env: env() });
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers.get("access-control-allow-origin"), PREVIEW_ORIGIN);
  const foreign = new Request("http://127.0.0.1/search-jobs", { method: "OPTIONS", headers: { origin: "https://klirprospect.klirline.ca" } });
  const refused = await handleSearchJobRequest(foreign, { env: env() });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get("access-control-allow-origin"), null);
});

test("l'entrée déployable n'embarque ni secret ni runner", async () => {
  const entry = await readFile(new URL("../supabase/functions/search-jobs/index.ts", import.meta.url), "utf8");
  const edge = await readFile(new URL("../supabase/functions/_shared/search-job-edge.mjs", import.meta.url), "utf8");
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(entry, /handleSearchJobRequest/);
  for (const source of [entry, edge]) {
    assert.equal(source.includes("SUPABASE_SERVICE_ROLE_KEY"), false);
    assert.equal(source.includes("SUPABASE_SECRET_KEYS"), false);
    assert.equal(source.includes("SUPABASE_DB_URL"), false);
    assert.equal(source.includes("local:"), source === edge);
    assert.doesNotMatch(source, /atob\(|jwt\.decode/);
  }
  assert.match(edge, /startsWith\("local:"\)/);
  assert.doesNotMatch(edge, /search-job-worker|createLocalSimulatedProvider|simulateFailures/);
  assert.equal(app.includes("search-jobs"), false);
  const config = await readFile(new URL("../supabase/config.toml", import.meta.url), "utf8");
  assert.match(config, /\[functions\.search-jobs\]/);
  assert.match(config, /verify_jwt = true/);
});
