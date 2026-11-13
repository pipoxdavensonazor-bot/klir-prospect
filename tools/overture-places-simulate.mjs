#!/usr/bin/env node
// Lecture locale d'un instantané : aucun job, aucun crédit, aucun réseau.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { importPlaces } from "./overture-places-import.mjs";
import { INDUSTRY_CATEGORY_TOKENS, matchIndustry, simulateQuantity } from "./overture-places-bounds.mjs";

export const DEFAULT_SECTORS = Object.freeze(["restauration", "construction", "commerce"]);

export function simulateSnapshot(snapshot, options = {}) {
  if (!snapshot || snapshot.release == null) throw new Error("instantane_invalide");
  const sectors = options.sectors || DEFAULT_SECTORS;
  const quantity = options.quantity ?? 10;
  const cities = [];
  for (const city of snapshot.cities || []) {
    const imported = importPlaces({ ...city, release: city.release || snapshot.release });
    const counts = {};
    for (const industry of Object.keys(INDUSTRY_CATEGORY_TOKENS)) {
      counts[industry] = imported.kept.filter((place) => matchIndustry(place, industry)).length;
    }
    const labeled = Object.values(counts).reduce((sum, value) => sum + value, 0);
    const simulations = {};
    for (const sector of sectors) {
      simulations[sector] = simulateQuantity(imported.kept, { industry: sector, quantity });
    }
    cities.push({
      key: city.key,
      features: imported.kept.length,
      truncated: city.truncated || 0,
      bytes: city.bytes || 0,
      rejected: imported.rejected.length,
      industryCounts: { ...counts, autre: imported.kept.length - labeled },
      simulations
    });
  }
  return {
    release: snapshot.release,
    coverage: snapshot.coverage || "sonde_centre",
    engine: snapshot.engine || null,
    totalFeatures: cities.reduce((sum, city) => sum + city.features, 0),
    cities
  };
}

export function simulateFile(path, options = {}) {
  const raw = readFileSync(path);
  const report = simulateSnapshot(JSON.parse(raw), options);
  report.path = path;
  report.sha256 = createHash("sha256").update(raw).digest("hex");
  report.bytes = raw.length;
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node tools/overture-places-simulate.mjs <snapshot.json>");
    process.exit(1);
  }
  console.log(JSON.stringify(simulateFile(path), null, 2));
}
