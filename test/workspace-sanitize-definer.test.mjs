import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const dir = new URL("../supabase/migrations/", import.meta.url);
const all = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
const ADA = "11111111-1111-4111-8111-111111111111";

test("session authentifiée : enregistrement direct de l'espace sans droit sur le schéma private", async () => {
  const db = new PGlite();
  await db.exec(`create schema auth; create table auth.users(id uuid primary key,raw_user_meta_data jsonb);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create role anon; create role authenticated; create role service_role;
    grant usage on schema public,auth to authenticated,anon; grant execute on function auth.uid() to authenticated;
    create schema vault; create table vault.decrypted_secrets(name text, decrypted_secret text);`);
  for (const f of all) await db.exec(await readFile(new URL(f, dir), "utf8"));
  await db.exec(`insert into auth.users(id) values ('${ADA}');
    grant insert, update, select on public.workspace_states to authenticated;`);
  const usage = (await db.query("select has_schema_privilege('authenticated','private','USAGE') u")).rows[0].u;
  assert.equal(usage, false);
  await db.exec(`select set_config('request.jwt.claim.sub','${ADA}',false); set role authenticated;`);
  await db.exec(`insert into public.workspace_states(user_id,payload) values ('${ADA}','{"crm":[{"id":"a"}],"token":"x"}')
    on conflict (user_id) do update set payload = excluded.payload;`);
  const row = (await db.query("select payload from public.workspace_states")).rows[0];
  assert.deepEqual(row.payload, { crm: [{ id: "a" }] });
  await db.exec("reset role");
  const def = (await db.query("select prosecdef from pg_proc where proname='sanitize_workspace'")).rows[0];
  assert.equal(def.prosecdef, true);
});
