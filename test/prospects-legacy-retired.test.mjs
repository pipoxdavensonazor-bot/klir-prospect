import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const root = new URL("../", import.meta.url);
const dir = new URL("supabase/migrations/", root);
const file = "20261115020000_retrait_lecteur_prospects_herite.sql";
const sql = await readFile(new URL(file, dir), "utf8");

async function db() {
  const pg = new PGlite();
  await pg.exec(`create role anon; create role authenticated; create role service_role;`);
  return pg;
}
const exists = async (pg) => (await pg.query("select to_regclass('public.centre_prospect_reader') is not null as ok")).rows[0].ok;

test("état Prod reproduit : la table du jeton centre est supprimée et ses droits retirés", async () => {
  const pg = await db();
  // Même forme qu'en Prod (lue le 14 nov. 2026) : id boolean, token_sha256 text, created_at.
  await pg.exec(`create table public.centre_prospect_reader (id boolean primary key default true check (id), token_sha256 text not null, created_at timestamptz not null default now());
    alter table public.centre_prospect_reader enable row level security;
    grant all on public.centre_prospect_reader to service_role;
    insert into public.centre_prospect_reader (token_sha256) values (repeat('a', 64));`);
  assert.equal(await exists(pg), true);
  await pg.exec(sql);
  assert.equal(await exists(pg), false);
});

test("idempotente : sans la table (Test, base neuve) la migration ne fait rien", async () => {
  const pg = await db();
  await pg.exec(sql);
  await pg.exec(sql);
  assert.equal(await exists(pg), false);
});

test("aucun code de l'application n'appelle la fonction prospects ni la table du jeton", async () => {
  const offenders = [];
  async function walk(url, rel) {
    for (const entry of await readdir(url, { withFileTypes: true })) {
      const name = entry.name;
      if (["node_modules", ".git", "dist", "docs", "migrations"].includes(name)) continue;
      const next = new URL(name + (entry.isDirectory() ? "/" : ""), url);
      if (entry.isDirectory()) await walk(next, rel + name + "/");
      else if (/\.(m?js|ts|json|html|toml|ya?ml)$/.test(name) && !name.startsWith("prospects-legacy-retired")) {
        const text = await readFile(next, "utf8");
        if (/functions\/v1\/prospects\b|centre_prospect_reader|invoke\(\s*["']prospects["']/.test(text)) offenders.push(rel + name);
      }
    }
  }
  await walk(root, "");
  assert.deepEqual(offenders, []);
});
