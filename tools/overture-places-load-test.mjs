#!/usr/bin/env node
// Charge l'instantané uniquement sur KlirProspect Test. Aucun job, aucun crédit.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import pg from "pg";
import { simulateFile } from "./overture-places-simulate.mjs";

export const TEST_PROJECT = "pwakjxjjxswdjsapsbxn";
export const PROD_PROJECT = "cbklwmjudobqwbkbxqgy";

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

function arg(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export async function loadPilotSnapshot(options) {
  const raw = readFileSync(options.snapshotPath);
  const snapshot = JSON.parse(raw);
  snapshotGuard(snapshot, raw.length);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  if (options.dryRun) {
    return { ok: true, dryRun: true, sha256, bytes: raw.length, project: TEST_PROJECT };
  }
  const url = databaseUrlFromEnvOrFile(options.env || process.env, options.credentialsPath);
  assertTestDatabaseUrl(url);
  const client = new pg.Client({
    connectionString: url,
    ssl: { rejectUnauthorized: true },
    application_name: "klir-overture-places-load-test"
  });
  try {
    await client.connect();
    const identity = await client.query(
      "select current_database() as db, inet_server_addr()::text as addr, current_setting('request.jwt.claims', true) as claims"
    );
    const addr = `${identity.rows[0].addr || ""}`;
    if (addr.includes(PROD_PROJECT)) throw new Error("projet_production_interdit");
    const backup = await client.query("select document from private.search_pilot_snapshot where singleton is true");
    if (!backup.rowCount) throw new Error("instantane_absent");
    writeFileSync(options.backupPath, JSON.stringify(backup.rows[0].document));
    await client.query("begin");
    await client.query(
      "update private.search_pilot_snapshot set document = $1::jsonb where singleton is true",
      [raw.toString("utf8")]
    );
    const verify = await client.query(`
      select
        length(document::text) as chars,
        pg_column_size(document) as toasted_bytes,
        document->>'release' as release,
        document->>'coverage' as coverage,
        (
          select jsonb_agg(jsonb_build_object('key', city->>'key', 'features', jsonb_array_length(city->'features')) order by city->>'key')
          from jsonb_array_elements(document->'cities') city
        ) as cities,
        pg_database_size(current_database()) as database_bytes
      from private.search_pilot_snapshot
      where singleton is true
    `);
    const row = verify.rows[0];
    if (row.release !== "2026-10-21.0" || Number(row.chars) < 1_000_000) {
      await client.query("rollback");
      throw new Error("verification_refusee");
    }
    await client.query("commit");
    return {
      ok: true,
      sha256,
      bytes: raw.length,
      project: TEST_PROJECT,
      documentChars: Number(row.chars),
      toastedBytes: Number(row.toasted_bytes),
      databaseBytes: Number(row.database_bytes),
      coverage: row.coverage,
      cities: row.cities,
      backup: options.backupPath
    };
  } catch (error) {
    const code = error && error.message && !/postgres(ql)?:\/\//i.test(error.message) ? error.message : "chargement_refuse";
    throw new Error(code);
  } finally {
    await client.end().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
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
