import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { runWorkerCycle } from "../supabase/functions/_shared/search-job-worker.mjs";

const sql = await readFile(new URL("../supabase/migrations/20261108190000_search_authorized_test_claim.sql", import.meta.url), "utf8");
const ada = "11111111-1111-4111-8111-111111111111";
const bea = "22222222-2222-4222-8222-222222222222";
const jobAda = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const jobBea = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

test("la migration ne donne la cible qu'au runner et ne lit pas un corps HTTP", () => {
  assert.match(sql, /grant execute on function private\.claim_authorized_test_job\(uuid\) to klir_job_runner/);
  assert.match(sql, /revoke all on function private\.claim_authorized_test_job\(uuid\) from public, anon, authenticated, klir_job_api/);
  assert.match(sql, /raise exception 'job_non_autorise'/);
  assert.match(sql, /where job\.id = p_job_id/);
  assert.doesNotMatch(sql, /jobs_enabled\s*=\s*true/);
  assert.doesNotMatch(sql, /request\.|body\.|jobId/);
  assert.doesNotMatch(sql, /order by job\.created_at/);
});

test("un job hors liste n'est pas réclamé, et le worker ciblé ne retombe pas sur la file", async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create schema if not exists private;
      create role anon nologin;
      create role authenticated nologin;
      create role klir_job_api nologin;
      create role klir_job_runner nologin;
      create table public.search_jobs (
        id uuid primary key,
        user_id uuid not null,
        status text not null,
        attempt integer not null default 0,
        payload jsonb not null,
        ledger_status text not null,
        collection_outcome text,
        result_count integer,
        reserved_until timestamptz,
        claim_until timestamptz,
        updated_at timestamptz not null default now()
      );
    `);
    await db.exec(sql);
    await db.exec(`
      insert into private.search_test_subjects (user_id) values ('${ada}');
      insert into public.search_jobs (id, user_id, status, payload, ledger_status, reserved_until)
      values
        ('${jobAda}', '${ada}', 'queued', '{"place_status":"supported"}', 'open', now() + interval '15 minutes'),
        ('${jobBea}', '${bea}', 'queued', '{"place_status":"supported"}', 'open', now() + interval '15 minutes');
    `);
    const claimed = await db.query("select private.claim_authorized_test_job($1::uuid) as row", [jobAda]);
    assert.equal(claimed.rows[0].row[0].id, jobAda);
    assert.equal(claimed.rows[0].row[0].attempt, 1);
    await assert.rejects(
      db.query("select private.claim_authorized_test_job($1::uuid) as row", [jobBea]),
      /job_non_autorise/
    );
    const untouched = await db.query("select status, attempt from public.search_jobs where id = $1", [jobBea]);
    assert.equal(untouched.rows[0].status, "queued");
    assert.equal(untouched.rows[0].attempt, 0);
    await assert.rejects(db.exec("set role authenticated; select private.claim_authorized_test_job('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')"), /permission denied/);

    const calls = [];
    const query = async (text, params) => {
      calls.push(text);
      if (text.includes("expire_due_search_jobs")) return { rows: [{ row: { expired: 0 } }] };
      if (text.includes("claim_authorized_test_job")) {
        assert.equal(params[0], jobBea);
        const error = new Error("job_non_autorise");
        error.code = "42501";
        throw error;
      }
      if (text.includes("claim_search_jobs")) throw new Error("file_globale");
      throw new Error(text);
    };
    await assert.rejects(
      runWorkerCycle(query, { async run() { return { count: 1 }; } }, { targetJobId: jobBea }),
      /job_non_autorise/
    );
    assert.equal(calls.some((text) => text.includes("claim_search_jobs")), false);
  } finally {
    await db.close();
  }
});
