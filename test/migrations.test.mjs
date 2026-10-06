import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const root = new URL("../supabase/migrations/", import.meta.url);
const createSql = await readFile(new URL("20261006004359_create_profiles_and_rls.sql", root), "utf8");
const hardenSql = await readFile(new URL("20261006014637_harden_auth_rls.sql", root), "utf8");

const stub = `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  raw_user_meta_data jsonb
);
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;
grant usage on schema public to anon, authenticated;
grant usage on schema auth to anon, authenticated;
`;

async function database() {
  const db = new PGlite();
  await db.exec(stub);
  await db.exec(createSql);
  await db.exec(hardenSql);
  return db;
}

test("les migrations créent un profil isolé et ignorent un horodatage client", async () => {
  const db = await database();
  const ada = "11111111-1111-1111-1111-111111111111";
  const bea = "22222222-2222-2222-2222-222222222222";
  await db.exec(`insert into auth.users (id, raw_user_meta_data) values ('${ada}', '{"display_name":"<Ada>"}'), ('${bea}', '{"display_name":"Bea"}')`);
  await db.exec(`select set_config('request.jwt.claim.sub', '${ada}', false)`);
  await db.exec("set role authenticated");

  const own = await db.query("select display_name from public.profiles where id = $1", [ada]);
  assert.equal(own.rows[0].display_name, "Ada");
  const foreign = await db.query("select display_name from public.profiles where id = $1", [bea]);
  assert.equal(foreign.rows.length, 0);

  await assert.rejects(
    db.exec(`update public.profiles set demo_migrated_at = now() where id = '${ada}'`),
    /permission denied|demo_migrated_at/i
  );

  await db.exec(`
    insert into public.workspace_states (user_id, payload)
    values ('${bea}', '{"password":"KlirProspect1","user":{"email":"demo@local.invalid"},"notes":{"token":"x","city":"Montréal"}}')
  `);
  const workspace = await db.query("select user_id, payload from public.workspace_states");
  assert.equal(workspace.rows.length, 1);
  assert.equal(workspace.rows[0].user_id, ada);
  assert.equal(workspace.rows[0].payload.password, undefined);
  assert.equal(workspace.rows[0].payload.user, undefined);
  assert.equal(workspace.rows[0].payload.notes.token, undefined);
  assert.equal(workspace.rows[0].payload.notes.city, "Montréal");

  const profile = await db.query("select demo_migrated_at from public.profiles where id = $1", [ada]);
  assert.ok(profile.rows[0].demo_migrated_at);
  await db.close();
});
