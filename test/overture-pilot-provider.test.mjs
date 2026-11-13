import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createOverturePilotProvider } from "../supabase/functions/_shared/search-job-overture-pilot.mjs";
import { runWorkerCycle } from "../supabase/functions/_shared/search-job-worker.mjs";

const snapshot = JSON.parse(await readFile(new URL("./fixtures/overture-places-six-centers.json", import.meta.url), "utf8"));

test("la sonde réelle des six centres alimente un fournisseur local non opérationnel", async () => {
  const provider = createOverturePilotProvider(snapshot);
  assert.equal(provider.operational, false);
  assert.equal(provider.network, false);
  const montreal = await provider.run({ place_status: "supported", cityKey: "montréal", quantity: 10 });
  assert.equal(montreal.count, 8);
  assert.equal(montreal.coverage, "sonde_centre");
  assert.equal(montreal.contactsVerified, false);
  assert.equal(montreal.release, "2026-10-21.0");
  assert.ok(montreal.records.some((row) => row.name !== row.name.normalize("NFD")));
  assert.ok(montreal.records.every((row) => row.contactsVerified === false && row.gersId && row.name));
  const again = await provider.run({ place_status: "supported", cityKey: "montréal", quantity: 10 });
  assert.equal(again.count, montreal.count);
  await assert.rejects(provider.run({ place_status: "supported", cityKey: "rome", quantity: 10 }), /place_rejected/);
  const source = await readFile(new URL("../supabase/functions/_shared/search-job-overture-pilot.mjs", import.meta.url), "utf8");
  assert.equal(/fetch\s*\(/.test(source), false);
});

function probeQuery(jobId, payload, handlers) {
  const calls = [];
  let claimed = false;
  const query = async (sql, params) => {
    calls.push(sql);
    if (sql.includes("expire_due_search_jobs")) return { rows: [{ row: { expired: 0 } }] };
    if (sql.includes("claim_search_jobs")) {
      if (claimed) return { rows: [{ row: [] }] };
      claimed = true;
      return { rows: [{ row: [{ id: jobId, attempt: 1, payload }] }] };
    }
    if (sql.includes("record_search_places")) return handlers.places(params);
    if (sql.includes("record_search_collection")) return handlers.collection(params);
    if (sql.includes("reconcile_search_job")) return handlers.reconcile();
    throw new Error(sql);
  };
  return { calls, query };
}

test("un cycle local enregistre le nombre de la sonde une seule fois", async () => {
  const provider = createOverturePilotProvider(snapshot);
  const jobId = "44444444-4444-4444-8444-444444444444";
  const probe = probeQuery(jobId, { place_status: "supported", cityKey: "laval", quantity: 10 }, {
    places(params) {
      const places = JSON.parse(params[1]);
      assert.equal(params[0], jobId);
      assert.equal(places.length, 8);
      assert.ok(places.every((row) => row.name && row.release));
      return { rows: [{ row: { recorded: places.length, replayed: false } }] };
    },
    collection(params) {
      assert.equal(params[1], "complete");
      assert.equal(params[2], 8);
      return { rows: [{ row: { id: jobId, collection_outcome: "complete", result_count: 8, recorded: true } }] };
    },
    reconcile() {
      return { rows: [{ row: { status: "succeeded", ledger_status: "settled" } }] };
    }
  });
  const first = await runWorkerCycle(probe.query, provider);
  const second = await runWorkerCycle(probe.query, provider);
  const placesAt = probe.calls.findIndex((sql) => sql.includes("record_search_places"));
  const collectionAt = probe.calls.findIndex((sql) => sql.includes("record_search_collection"));
  assert.equal(first.results[0].status, "succeeded");
  assert.equal(probe.calls.filter((sql) => sql.includes("record_search_places")).length, 1);
  assert.equal(probe.calls.filter((sql) => sql.includes("record_search_collection")).length, 1);
  assert.ok(placesAt >= 0 && placesAt < collectionAt);
  assert.equal(second.results.length, 0);
  assert.equal(probe.calls.some((sql) => /reserve_usage|settle_usage/.test(sql)), false);
});

test("une écriture de fiches refusée clôt la sonde en failed sans débit direct", async () => {
  const provider = createOverturePilotProvider(snapshot);
  const jobId = "55555555-5555-4555-8555-555555555555";
  const probe = probeQuery(jobId, { place_status: "supported", cityKey: "laval", quantity: 10 }, {
    places() {
      throw new Error("places_invalides");
    },
    collection(params) {
      assert.equal(params[1], "failed");
      assert.equal(params[2], 0);
      return { rows: [{ row: { id: jobId, collection_outcome: "failed", result_count: 0, recorded: true } }] };
    },
    reconcile() {
      return { rows: [{ row: { status: "failed", ledger_status: "released" } }] };
    }
  });
  const cycle = await runWorkerCycle(probe.query, provider);
  assert.equal(cycle.results[0].status, "failed");
  assert.equal(cycle.results[0].ledger_status, "released");
  assert.equal(probe.calls.filter((sql) => sql.includes("record_search_collection")).length, 1);
  assert.equal(probe.calls.some((sql) => /reserve_usage|settle_usage/.test(sql)), false);
});
