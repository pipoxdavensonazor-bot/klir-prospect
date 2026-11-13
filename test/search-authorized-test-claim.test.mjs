import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { runWorkerCycle } from "../supabase/functions/_shared/search-job-worker.mjs";

const root = new URL("../supabase/migrations/", import.meta.url);
const claimFile = "20261108190000_search_authorized_test_claim.sql";
const beforeEnqueue = [
  "20261006004359_create_profiles_and_rls.sql",
  "20261011221500_credit_ledger.sql",
  "20261022130000_enforce_reserved_search_quota.sql",
  "20261105014500_admin_role.sql",
  "20261107190000_search_jobs.sql",
  "20261107201000_search_job_ledger.sql"
];
const afterEnqueue = [
  "20261107220000_search_job_runner_role.sql",
  "20261107233000_search_job_connect_test.sql",
  "20261108170000_search_job_places.sql",
  claimFile
];
const sql = {};
for (const file of [...beforeEnqueue, ...afterEnqueue]) sql[file] = await readFile(new URL(file, root), "utf8");
const claimSql = sql[claimFile];

const ada = "11111111-1111-4111-8111-111111111111";
const bea = "22222222-2222-4222-8222-222222222222";
const ced = "33333333-3333-4333-8333-333333333333";

const stub = `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text, raw_user_meta_data jsonb);
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
end
$$;
grant usage on schema public to anon, authenticated;
grant usage on schema auth to anon, authenticated;
`;

function payload(quantity = 10) {
  return JSON.stringify({ place_status: "supported", cityKey: "laval", quantity });
}

async function enqueue(db, user, key) {
  await db.exec("reset role");
  await db.exec(`select set_config('request.jwt.claim.sub', '${user}', false)`);
  await db.exec("set role authenticated");
  const row = await db.query("select public.enqueue_search_job($1, $2::jsonb) as row", [key, payload()]);
  await db.exec("reset role");
  return row.rows[0].row.id;
}

// Base réaliste : vraies migrations, vrais jobs réservés par enqueue_search_job.
async function database() {
  const db = new PGlite();
  await db.exec(stub);
  for (const file of beforeEnqueue) await db.exec(sql[file]);
  await db.exec(`
    insert into auth.users (id, email) values
      ('${ada}', 'ada@example.invalid'),
      ('${bea}', 'bea@example.invalid'),
      ('${ced}', 'ced@example.invalid')
  `);
  await db.exec("update private.search_job_settings set jobs_enabled = true");
  const jobs = {
    approved: await enqueue(db, ada, "exercice-approuve-1"),
    adaOther: await enqueue(db, ada, "ada-non-approuve-1"),
    foreign: await enqueue(db, ced, "ced-etranger-0001"),
    foreignExpired: await enqueue(db, ced, "ced-expire-00001"),
    beaExpired: await enqueue(db, bea, "bea-expire-00001")
  };
  for (const file of afterEnqueue) await db.exec(sql[file]);
  // Deux jobs étrangers dont la réservation est échue (comme les jobs Test du 8 nov.).
  await db.exec(`
    update public.search_jobs
    set reserved_until = now() - interval '1 hour'
    where id in ('${jobs.foreignExpired}', '${jobs.beaExpired}')
  `);
  await db.exec(`
    insert into private.search_test_job_approvals (job_id, user_id, exercise, approved_until)
    values ('${jobs.approved}', '${ada}', 'exercice runner cible', now() + interval '2 hours')
  `);
  return { db, jobs };
}

// Session du runner Test : connexion klir_job_connect_test, puis SET ROLE klir_job_runner.
async function asRunner(db) {
  await db.exec("reset role");
  await db.exec("set session authorization postgres");
  await db.exec("set session authorization klir_job_connect_test");
  await db.exec("set role klir_job_runner");
}

async function asOwner(db) {
  await db.exec("reset role");
  await db.exec("set session authorization postgres");
}

async function snapshot(db) {
  await asOwner(db);
  const jobs = await db.query(`
    select id, status, attempt, ledger_status, collection_outcome, reserved_until, claim_until, updated_at
    from public.search_jobs order by id
  `);
  const accounts = await db.query("select user_id, balance, searches_used from public.credit_accounts order by user_id");
  return JSON.stringify({ jobs: jobs.rows, accounts: accounts.rows });
}

async function claim(db, id) {
  return db.query("select private.claim_authorized_test_job($1::uuid) as row", [id]);
}

// Exécute dans une transaction, comme le runner Edge, et annule si erreur.
async function inTransaction(db, fn) {
  return db.transaction(async (tx) => fn((text, params) => tx.query(text, params || [])));
}

test("la migration reste ciblée : pas de parcours de file, pas d'expiration, pas de corps HTTP", () => {
  assert.match(claimSql, /grant execute on function private\.claim_authorized_test_job\(uuid\) to klir_job_runner/);
  assert.match(claimSql, /revoke all on function private\.claim_authorized_test_job\(uuid\)\s+from PUBLIC, public, anon, authenticated, klir_job_api/);
  assert.match(claimSql, /session_user::text <> 'klir_job_connect_test'/);
  assert.match(claimSql, /force row level security/);
  assert.match(claimSql, /approved_until <= approved_at \+ interval '24 hours'/);
  assert.match(claimSql, /where job\.id = p_job_id/);
  assert.doesNotMatch(claimSql, /jobs_enabled\s*=\s*true/);
  assert.doesNotMatch(claimSql, /request\.|body\.|jobId/);
  assert.doesNotMatch(claimSql, /order by job\.created_at/);
  assert.doesNotMatch(claimSql, /skip locked/i);
  assert.doesNotMatch(claimSql, /expire_due_search_jobs|reconcile_search_job|apply_usage_outcome|settle_usage|reserve_usage/);
  assert.doesNotMatch(claimSql, /search_test_subjects/);
});

test("seul le job approuvé est réclamé ; les jobs étrangers et non approuvés restent intacts", async () => {
  const { db, jobs } = await database();
  try {
    const before = JSON.parse(await snapshot(db));
    await asRunner(db);
    const claimed = await claim(db, jobs.approved);
    assert.equal(claimed.rows[0].row.length, 1);
    assert.equal(claimed.rows[0].row[0].id, jobs.approved);
    assert.equal(claimed.rows[0].row[0].attempt, 1);

    for (const [id, code] of [
      [jobs.foreign, /job_non_autorise/],
      [jobs.adaOther, /job_non_autorise/],
      [jobs.foreignExpired, /job_non_autorise/],
      ["99999999-9999-4999-8999-999999999999", /job_non_autorise/]
    ]) {
      await asRunner(db);
      await assert.rejects(claim(db, id), code);
    }
    await asRunner(db);
    await assert.rejects(claim(db, null), /cible_invalide/);

    const after = JSON.parse(await snapshot(db));
    for (const row of after.jobs) {
      if (row.id === jobs.approved) continue;
      assert.deepEqual(row, before.jobs.find((item) => item.id === row.id), `job ${row.id} modifié`);
    }
    assert.deepEqual(after.accounts, before.accounts);
  } finally {
    await db.close();
  }
});

test("une approbation pour un autre propriétaire, échue ou trop longue est refusée", async () => {
  const { db, jobs } = await database();
  try {
    await asOwner(db);
    // Approbation enregistrée au nom d'un autre compte que le propriétaire du job.
    await db.exec(`
      insert into private.search_test_job_approvals (job_id, user_id, exercise, approved_until)
      values ('${jobs.foreign}', '${ada}', 'mauvais proprietaire', now() + interval '1 hour')
    `);
    // Approbation échue.
    await db.exec(`
      insert into private.search_test_job_approvals (job_id, user_id, exercise, approved_at, approved_until)
      values ('${jobs.adaOther}', '${ada}', 'approbation echue', now() - interval '3 hours', now() - interval '1 hour')
    `);
    await assert.rejects(db.exec(`
      insert into private.search_test_job_approvals (job_id, user_id, exercise, approved_until)
      values ('${jobs.beaExpired}', '${bea}', 'trop longue', now() + interval '3 days')
    `), /search_test_job_approvals_window_check/);
    await assert.rejects(db.exec(`
      insert into private.search_test_job_approvals (job_id, user_id, exercise, approved_until)
      values ('99999999-9999-4999-8999-999999999999', '${bea}', 'job inexistant', now() + interval '1 hour')
    `), /foreign key/);

    const before = await snapshot(db);
    await asRunner(db);
    await assert.rejects(claim(db, jobs.foreign), /job_non_autorise/);
    await asRunner(db);
    await assert.rejects(claim(db, jobs.adaOther), /autorisation_expiree/);
    assert.equal(await snapshot(db), before);
  } finally {
    await db.close();
  }
});

test("un job ciblé dont la réservation est échue est refusé sans écriture", async () => {
  const { db, jobs } = await database();
  try {
    await asOwner(db);
    await db.exec(`
      insert into private.search_test_job_approvals (job_id, user_id, exercise, approved_until)
      values ('${jobs.beaExpired}', '${bea}', 'job expire', now() + interval '1 hour')
    `);
    const before = await snapshot(db);
    await asRunner(db);
    await assert.rejects(claim(db, jobs.beaExpired), /job_expire/);
    assert.equal(await snapshot(db), before);
  } finally {
    await db.close();
  }
});

test("rôles non autorisés : navigateur, API, propriétaire hors session runner", async () => {
  const { db, jobs } = await database();
  try {
    for (const role of ["anon", "authenticated", "klir_job_api"]) {
      await asOwner(db);
      await db.exec(`set role ${role}`);
      await assert.rejects(claim(db, jobs.approved), /permission denied/, role);
      await asOwner(db);
      await db.exec(`set role ${role}`);
      await assert.rejects(db.query("select * from private.search_test_job_approvals"), /permission denied/, role);
    }
    // Le propriétaire des migrations (session postgres) n'est pas la connexion Test.
    await asOwner(db);
    await assert.rejects(claim(db, jobs.approved), /role_non_autorise/);
    // klir_job_runner sans la session de connexion Test non plus.
    await asOwner(db);
    await db.exec("set role klir_job_runner");
    await assert.rejects(claim(db, jobs.approved), /role_non_autorise/);
    // La connexion Test ne peut ni lire ni écrire les approbations.
    await asRunner(db);
    await assert.rejects(db.query("select * from private.search_test_job_approvals"), /permission denied/);
    await asRunner(db);
    await assert.rejects(db.exec(`
      insert into private.search_test_job_approvals (job_id, user_id, exercise, approved_until)
      values ('${jobs.foreign}', '${ced}', 'auto approbation', now() + interval '1 hour')
    `), /permission denied/);
    const status = await snapshot(db);
    assert.equal(JSON.parse(status).jobs.every((row) => row.attempt === 0), true);
  } finally {
    await db.close();
  }
});

test("cycle ciblé de bout en bout : n'expire rien, ne règle que le job approuvé", async () => {
  const { db, jobs } = await database();
  try {
    const before = JSON.parse(await snapshot(db));
    await asRunner(db);
    const calls = [];
    const cycle = await inTransaction(db, async (raw) => {
      const query = async (text, params) => {
        calls.push(text);
        return raw(text, params);
      };
      return runWorkerCycle(query, { async run() { return { count: 0 }; } }, { targetJobId: jobs.approved });
    });
    assert.equal(cycle.expired, 0);
    assert.equal(cycle.targeted, true);
    assert.equal(cycle.results.length, 1);
    assert.equal(cycle.results[0].id, jobs.approved);
    assert.equal(calls.some((text) => text.includes("expire_due_search_jobs")), false);
    assert.equal(calls.some((text) => text.includes("claim_search_jobs")), false);

    const after = JSON.parse(await snapshot(db));
    const approved = after.jobs.find((row) => row.id === jobs.approved);
    assert.notEqual(approved.status, "queued");
    for (const row of after.jobs) {
      if (row.id === jobs.approved) continue;
      assert.deepEqual(row, before.jobs.find((item) => item.id === row.id), `job étranger ${row.id} modifié`);
    }
    // Les jobs étrangers échus gardent leur réservation : aucune libération par le cycle ciblé.
    for (const id of [jobs.foreignExpired, jobs.beaExpired]) {
      const row = after.jobs.find((item) => item.id === id);
      assert.equal(row.status, "queued");
      assert.equal(row.ledger_status, "open");
    }
    const others = (list) => list.filter((row) => row.user_id !== ada);
    assert.deepEqual(others(after.accounts), others(before.accounts));
  } finally {
    await db.close();
  }
});

test("cycle ciblé refusé : la transaction est annulée et aucun job n'est touché", async () => {
  const { db, jobs } = await database();
  try {
    const before = await snapshot(db);
    for (const id of [jobs.foreign, jobs.foreignExpired, jobs.beaExpired]) {
      await asRunner(db);
      await assert.rejects(
        inTransaction(db, (query) => runWorkerCycle(query, { async run() { return { count: 1 }; } }, { targetJobId: id })),
        /job_non_autorise/
      );
    }
    await asRunner(db);
    await assert.rejects(
      inTransaction(db, (query) => runWorkerCycle(query, { async run() { return { count: 1 }; } }, { targetJobId: "pas-un-uuid" })),
      /cible_invalide/
    );
    assert.equal(await snapshot(db), before);
  } finally {
    await db.close();
  }
});

test("non-régression : le cycle normal expire toujours la file puis réclame globalement", async () => {
  const { db } = await database();
  try {
    await asOwner(db);
    await db.exec("set role klir_job_runner");
    const calls = [];
    const cycle = await inTransaction(db, async (raw) => {
      const query = async (text, params) => {
        calls.push(text);
        return raw(text, params);
      };
      return runWorkerCycle(query, { async run() { return { count: 0 }; } });
    });
    assert.equal(calls[0], "select private.expire_due_search_jobs() as row");
    assert.equal(calls[1], "select private.claim_search_jobs(1) as row");
    assert.equal(calls.some((text) => text.includes("claim_authorized_test_job")), false);
    assert.equal(cycle.expired, 2);
    assert.equal(cycle.targeted, undefined);
    assert.equal(cycle.results.length, 1);
  } finally {
    await db.close();
  }
});

test("le worker ciblé refuse une réponse qui ne correspond pas à la cible", async () => {
  const target = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const calls = [];
  const query = async (text) => {
    calls.push(text);
    if (text.includes("claim_authorized_test_job")) {
      return { rows: [{ row: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", payload: {}, attempt: 1 }] }] };
    }
    throw new Error(`inattendu: ${text}`);
  };
  await assert.rejects(
    runWorkerCycle(query, { async run() { throw new Error("ne_pas_executer"); } }, { targetJobId: target }),
    (error) => error.code === "cible_divergente"
  );
  assert.deepEqual(calls, ["select private.claim_authorized_test_job($1::uuid) as row"]);
});

// postgres.js (runner Edge) sérialise en JSON tout paramètre dont le type
// déduit est json/jsonb : une chaîne déjà JSON devient un scalaire jsonb.
function postgresJsLike(raw) {
  return async (text, params = []) => {
    const encoded = params.map((value, index) => {
      const n = index + 1;
      const directJsonb = new RegExp(`\\$${n}::jsonb`).test(text) && !new RegExp(`\\$${n}::text::jsonb`).test(text);
      return directJsonb && typeof value === "string" ? JSON.stringify(value) : value;
    });
    return raw(text, encoded);
  };
}

test("cycle ciblé avec fiches : les fiches sont enregistrées malgré la sérialisation postgres.js", async () => {
  const { db, jobs } = await database();
  try {
    await asRunner(db);
    const provider = { async run() { return { count: 2, records: [{ name: "Café A", basicCategory: "cafe", release: "2026-10-21.0" }, { name: "Resto B", basicCategory: "restaurant", release: "2026-10-21.0" }] }; } };
    const cycle = await inTransaction(db, (raw) => runWorkerCycle(postgresJsLike(raw), provider, { targetJobId: jobs.approved }));
    assert.equal(cycle.results[0].id, jobs.approved);
    await asOwner(db);
    const places = await db.query("select name from public.search_job_places where job_id = $1 order by name", [jobs.approved]);
    assert.deepEqual(places.rows.map((row) => row.name), ["Café A", "Resto B"]);
    const job = await db.query("select status, ledger_status, collection_outcome from public.search_jobs where id = $1", [jobs.approved]);
    assert.equal(job.rows[0].collection_outcome, "complete");
    assert.equal(job.rows[0].ledger_status, "complete");
    const others = await db.query("select count(*)::int as n from public.search_job_places where job_id <> $1", [jobs.approved]);
    assert.equal(others.rows[0].n, 0);
  } finally {
    await db.close();
  }
});

test("régression : un paramètre $2::jsonb direct échouerait avec places_invalides sous postgres.js", async () => {
  const { db, jobs } = await database();
  try {
    await asOwner(db);
    const query = postgresJsLike((text, params) => db.query(text, params));
    await assert.rejects(query("select private.record_search_places($1::uuid, $2::jsonb) as row", [jobs.approved, JSON.stringify([{ name: "x" }])]), /places_invalides/);
    const ok = await query("select private.record_search_places($1::uuid, $2::text::jsonb) as row", [jobs.approved, JSON.stringify([{ name: "x" }])]);
    assert.equal(ok.rows[0].row.recorded, 1);
  } finally {
    await db.close();
  }
});
