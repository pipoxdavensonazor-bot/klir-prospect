#!/usr/bin/env node
// Point d'entrée reproductible. L'extrait S3 public est délégué au script
// Python + DuckDB. Les tests unitaires n'appellent pas le réseau.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
export const EXTRACT_SCRIPT = join(here, "overture-places-extract.py");

export function extractCommand(outPath, options = {}) {
  const python = options.python || process.env.DUCKDB_PYTHON || "python3";
  const args = [EXTRACT_SCRIPT, "--out", outPath];
  if (options.radiusM) args.push("--radius-m", String(options.radiusM));
  if (options.checkOnly) args.push("--python-check-only");
  return { python, args };
}

export function runExtract(outPath, options = {}) {
  const { python, args } = extractCommand(outPath, options);
  return new Promise((resolve, reject) => {
    const child = spawn(python, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      const error = new Error(stderr.trim() || `extract_failed_${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const outIndex = process.argv.indexOf("--out");
  if (outIndex < 0 || !process.argv[outIndex + 1]) {
    console.error("usage: node tools/overture-places-extract.mjs --out <fichier.json>");
    process.exit(2);
  }
  const options = { python: process.env.DUCKDB_PYTHON };
  const radiusIndex = process.argv.indexOf("--radius-m");
  if (radiusIndex >= 0) options.radiusM = Number(process.argv[radiusIndex + 1]);
  const result = await runExtract(process.argv[outIndex + 1], options);
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
}
