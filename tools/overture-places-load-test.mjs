#!/usr/bin/env node
// Charge le catalogue ligne par ligne uniquement sur KlirProspect Test.
// Aucun job, aucun crédit, pas d'écriture du document jsonb complet.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
import { importPlaces } from "./overture-places-import.mjs";
import { simulateFile } from "./overture-places-simulate.mjs";

export const TEST_PROJECT = "pwakjxjjxswdjsapsbxn";
export const PROD_PROJECT = "cbklwmjudobqwbkbxqgy";
export const CATALOG_BATCH_SIZE = 80;

export function assertTestDatabaseUrl(url) {
  if (typeof url !== "string" || !url.trim()) throw new Error("url_absente");
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("url_invalide");
  }
  if (!/^postgres(ql)?:$/i.test(parsed.protocol)) throw new Error("url_invalide");
  const haystack = `${parsed.hostname} ${parsed.username} ${parsed.href}`;
  if (haystack.includes(PROD_PROJECT)) throw new Error("projet_production_interdit");
  if (!haystack.includes(TEST_PROJECT)) throw new Error("projet_test_requis");
  const host = parsed.hostname.toLowerCase();
  const allowedHost =
    host === `db.${TEST_PROJECT}.supabase.co` ||
    (host.endsWith(".pooler.supabase.com") && parsed.username.includes(TEST_PROJECT));
  if (!allowedHost) throw new Error("hote_refuse");
  if (parsed.port === "6543") throw new Error("pool_transactionnel_refuse");
  if (parsed.searchParams.get("sslmode") === "disable") throw new Error("ssl_requis");
  return true;
}

export function snapshotGuard(snapshot, rawLength) {
  if (!snapshot || snapshot.release !== "2026-10-21.0") throw new Error("release_invalide");
  if (!Array.isArray(snapshot.cities) || snapshot.cities.length !== 6) throw new Error("villes_incompletes");
  const keys = snapshot.cities.map((city) => city.key).sort().join(",");
  if (keys !== "laval,lyon,montréal,paris,québec,toronto") throw new Error("villes_incompletes");
  if (rawLength > 80_000_000) throw new Error("instantane_trop_lourd");
  return true;
}

export function databaseUrlFromEnvOrFile(env, credentialsPath) {
  if (env.KLIR_TEST_DB_URL) return env.KLIR_TEST_DB_URL;
  if (!credentialsPath) throw new Error("url_absente");
  const config = JSON.parse(readFileSync(credentialsPath, "utf8"));
  const url = config.databaseUrl || config.KLIR_TEST_DB_URL || "";
  if (!url) throw new Error("url_absente");
  return url;
}

export function catalogRowsFromSnapshot(snapshot) {
  snapshotGuard(snapshot, JSON.stringify(snapshot).length);
  const cities = [];
  const rows = [];
  for (const city of snapshot.cities) {
    const imported = importPlaces({
      kind: city.kind,
      release: city.release || snapshot.release,
      bbox: city.bbox,
      features: city.features,
      bytes: city.bytes
    });
    cities.push({ key: city.key, features: imported.kept.length, rejected: imported.rejected.length });
    for (const record of imported.kept) {
      rows.push({
        city_key: city.key,
        id: record.gersId,
        name: record.name,
        basic_category: record.basicCategory || "",
        category_tokens: record.categoryTokens || [],
        locality: record.locality || "",
        country: record.country || "",
        latitude: record.latitude,
        longitude: record.longitude,
        sources: record.sources || [],
        licenses: record.licenses || [],
        release: record.release || snapshot.release
      });
    }
  }
  return { cities, rows };
}

function batchesOf(rows, size) {
  const batches = [];
  for (let index = 0; index < rows.length; index += size) {
    batches.push(rows.slice(index, index + size));
  }
  return batches;
}

function arg(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function loadPilotSnapshot(options) {
  const raw = readFileSync(options.snapshotPath);
  const snapshot = JSON.parse(raw);
  snapshotGuard(snapshot, raw.length);
  const prepared = catalogRowsFromSnapshot(snapshot);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      sha256,
      bytes: raw.length,
      project: TEST_PROJECT,
      target: "private.search_catalog_places",
      cities: prepared.cities,
      rows: prepared.rows.length
    };
  }
  const url = databaseUrlFromEnvOrFile(options.env || process.env, options.credentialsPath);
  assertTestDatabaseUrl(url);
  const client = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: true },
    application_name: "klir-overture-places-load-catalog"
  });
  try {
    await client.connect();
    const identity = await client.query(
      "select current_database() as db, inet_server_addr()::text as addr"
    );
    const addr = `${identity.rows[0].addr || ""}`;
    if (addr.includes(PROD_PROJECT)) throw new Error("projet_production_interdit");
    const present = await client.query("select to_regclass('private.search_catalog_places') is not null as ok");
    if (!present.rows[0] || present.rows[0].ok !== true) throw new Error("catalogue_absent");
    const backup = await client.query("select document from private.search_pilot_snapshot where singleton is true");
    if (!backup.rowCount) throw new Error("instantane_absent");
    writeFileSync(options.backupPath, JSON.stringify(backup.rows[0].document));
    const batchSize = options.batchSize || CATALOG_BATCH_SIZE;
    for (const batch of batchesOf(prepared.rows, batchSize)) {
      await client.query(
        `insert into private.search_catalog_places (
           city_key, id, name, basic_category, category_tokens, locality, country,
           latitude, longitude, sources, licenses, release
         )
         select
           rec.city_key, rec.id, rec.name, rec.basic_category, rec.category_tokens,
           rec.locality, rec.country, rec.latitude, rec.longitude, rec.sources,
           rec.licenses, rec.release
         from jsonb_to_recordset($1::jsonb) as rec(
           city_key text, id text, name text, basic_category text, category_tokens text[],
           locality text, country text, latitude double precision, longitude double precision,
           sources jsonb, licenses text[], release text
         )
         on conflict (city_key, id) do update set
           name = excluded.name,
           basic_category = excluded.basic_category,
           category_tokens = excluded.category_tokens,
           locality = excluded.locality,
           country = excluded.country,
           latitude = excluded.latitude,
           longitude = excluded.longitude,
           sources = excluded.sources,
           licenses = excluded.licenses,
           release = excluded.release`,
        [JSON.stringify(batch)]
      );
    }
    const verify = await client.query(`
      select
        city_key as key,
        count(*)::int as features
      from private.search_catalog_places
      group by city_key
      order by city_key
    `);
    const size = await client.query("select pg_database_size(current_database()) as database_bytes");
    return {
      ok: true,
      sha256,
      bytes: raw.length,
      project: TEST_PROJECT,
      target: "private.search_catalog_places",
      rows: prepared.rows.length,
      cities: verify.rows,
      databaseBytes: Number(size.rows[0].database_bytes),
      backup: options.backupPath
    };
  } catch (error) {
    const code = error && error.message && !/postgres(ql)?:\/\//i.test(error.message) ? error.message : "chargement_refuse";
    throw new Error(code);
  } finally {
    await client.end().catch(() => {});
  }
}

const isCli = import.meta.url === `file://${process.argv[1]}` && !process.env.NODE_TEST_CONTEXT;
if (isCli) {
  const args = process.argv.slice(2);
  const snapshotPath = arg(args, "--snapshot");
  const backupPath = arg(args, "--backup");
  if (!snapshotPath || !backupPath) {
    console.error("usage: node tools/overture-places-load-test.mjs --snapshot <json> --backup <json> [--credentials <json>] [--dry-run]");
    process.exit(1);
  }
  const dryRun = args.includes("--dry-run");
  loadPilotSnapshot({
    snapshotPath,
    backupPath,
    credentialsPath: arg(args, "--credentials"),
    dryRun,
    env: process.env
  })
    .then((result) => {
      if (!dryRun && !args.includes("--skip-simulate")) {
        result.simulation = simulateFile(snapshotPath);
      }
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
