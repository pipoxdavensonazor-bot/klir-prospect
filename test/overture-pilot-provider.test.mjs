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

test("un cycle local enregistre le nombre de la sonde une seule fois", async () => {
  const provider = createOverturePilotProvider(snapshot);
  const calls = [];
  const jobId = "44444444-4444-4444-8444-444444444444";
  let claimed = false;
  const query = async (sql, params) => {
    calls.push(sql);
    if (sql.includes("expire_due_search_jobs")) return { rows: [{ row: { expired: 0 } }] };
    if (sql.includes("claim_search_jobs")) {
      if (claimed) return { rows: [{ row: [] }] };
      claimed = true;
      return { rows: [{ row: [{ id: jobId, attempt: 1, payload: { place_status: "supported", cityKey: "laval", quantity: 10 } }] }] };
    }
    if (sql.includes("record_search_collection")) {
      assert.equal(params[1], "complete");
      assert.equal(params[2], 8);
      return { rows: [{ row: { id: jobId, collection_outcome: "complete", result_count: 8, recorded: true } }] };
    }
    if (sql.includes("reconcile_search_job")) {
      return { rows: [{ row: { status: "succeeded", ledger_status: "settled" } }] };
    }
    throw new Error(sql);
  };
  const first = await runWorkerCycle(query, provider);
  const second = await runWorkerCycle(query, provider);
  assert.equal(first.results[0].status, "succeeded");
  assert.equal(calls.filter((sql) => sql.includes("record_search_collection")).length, 1);
  assert.equal(second.results.length, 0);
  assert.equal(calls.some((sql) => /reserve_usage|settle_usage/.test(sql)), false);
});
