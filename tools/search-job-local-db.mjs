import { readFile } from "node:fs/promises";
import os from "node:os";
import { Client } from "pg";
import { pathToFileURL } from "node:url";

const stub = `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  email text,
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

const migrationFiles = [
  "20261006004359_create_profiles_and_rls.sql",
  "20261011221500_credit_ledger.sql",
  "20261022130000_enforce_reserved_search_quota.sql",
  "20261105014500_admin_role.sql",
  "20261107190000_search_jobs.sql",
  "20261107201000_search_job_ledger.sql",
  "20261107220000_search_job_runner_role.sql"
];

export function localAdminConfig(env = process.env) {
  if (env.SEARCH_JOBS_DB_PASSWORD || env.PGPASSWORD || env.DATABASE_URL || env.SUPABASE_SERVICE_ROLE_KEY) {
    const error = new Error("secret_refuse");
    error.code = "secret_refuse";
    throw error;
  }
  const host = env.SEARCH_JOBS_DB_HOST || "/var/run/postgresql";
  if (host !== "/var/run/postgresql") {
    const error = new Error("socket_local_requis");
    error.code = "socket_local_requis";
    throw error;
  }
  const database = env.SEARCH_JOBS_DB_NAME || "";
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(database)) {
    const error = new Error("base_invalide");
    error.code = "base_invalide";
    throw error;
  }
  return { host, database };
}

async function ensureConnectRole(client) {
  const existing = await client.query("select 1 from pg_roles where rolname = 'klir_job_connect'");
  if (existing.rowCount === 0) {
    await client.query("create role klir_job_connect login nosuperuser nocreatedb nocreaterole noinherit");
  } else {
    await client.query("alter role klir_job_connect login nosuperuser nocreatedb nocreaterole noinherit");
  }
}

export function splitSql(sql) {
  const parts = [];
  let current = "";
  let dollar = null;
  let i = 0;
  while (i < sql.length) {
    if (!dollar && sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }
    if (!dollar && sql[i] === "'") {
      current += sql[i];
      i += 1;
      while (i < sql.length) {
        current += sql[i];
        if (sql[i] === "'" && sql[i + 1] === "'") {
          current += sql[i + 1];
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (sql[i] === "$") {
      const match = /^\$[A-Za-z0-9_]*\$/.exec(sql.slice(i));
      if (match) {
        const tag = match[0];
        if (!dollar) dollar = tag;
        else if (dollar === tag) dollar = null;
        current += tag;
        i += tag.length;
        continue;
      }
    }
    if (!dollar && sql[i] === ";") {
      if (current.trim()) parts.push(current.trim());
      current = "";
      i += 1;
      continue;
    }
    current += sql[i];
    i += 1;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

async function execScript(client, sql) {
  for (const statement of splitSql(sql)) await client.query(statement);
}

export async function applyLocalSearchJobSchema(client) {
  await ensureConnectRole(client);
  await execScript(client, stub);
  const root = new URL("../supabase/migrations/", import.meta.url);
  for (const file of migrationFiles) {
    const sql = await readFile(new URL(file, root), "utf8");
    await execScript(client, sql);
  }
  const flag = await client.query("select jobs_enabled from private.search_job_settings");
  if (flag.rows[0] && flag.rows[0].jobs_enabled === true) {
    const error = new Error("drapeau_deja_allume");
    error.code = "drapeau_deja_allume";
    throw error;
  }
  const connect = await client.query(`
    select
      (select rolcanlogin from pg_roles where rolname = 'klir_job_connect') as connect_login,
      (select rolsuper from pg_roles where rolname = 'klir_job_runner') as runner_super,
      (select rolcanlogin from pg_roles where rolname = 'klir_job_runner') as runner_login
  `);
  return { jobsEnabled: false, connect: connect.rows[0] };
}

async function main() {
  const config = localAdminConfig(process.env);
  const client = new Client({
    host: config.host,
    database: config.database,
    user: os.userInfo().username
  });
  await client.connect();
  try {
    const who = await client.query("select current_user as role_name, rolsuper from pg_roles where rolname = current_user");
    if (who.rows[0].role_name === "klir_job_connect" || who.rows[0].rolsuper !== true) {
      console.error("schema_local_refuse role_proprietaire_local_requis");
      process.exitCode = 2;
      return;
    }
    await applyLocalSearchJobSchema(client);
    const probe = new Client({ host: config.host, database: config.database, user: "klir_job_connect" });
    try {
      await probe.connect();
      await probe.end();
    } catch {
      console.error("connexion_locale_refusee ajouter dans pg_hba.conf : local all klir_job_connect trust puis recharger PostgreSQL. Socket seulement, aucun secret.");
      process.exitCode = 2;
      return;
    }
    console.log("schema_local_applique jobs_enabled=false");
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`schema_local_echec ${error.code || "unknown"}`);
    process.exitCode = 1;
  });
}
