import { importPlaces } from "../../../tools/overture-places-import.mjs";
import { matchIndustry } from "../../../tools/overture-places-bounds.mjs";

const CITY_KEYS = new Set(["montréal", "laval", "québec", "toronto", "paris", "lyon"]);

function coded(code, retryable = false) {
  const error = new Error(code);
  error.code = code;
  error.retryable = retryable;
  return error;
}

export function createOverturePilotProvider(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.cities)) throw coded("instantane_invalide");
  const coverage = typeof snapshot.coverage === "string" && snapshot.coverage ? snapshot.coverage : "sonde_centre";
  const byCity = new Map();
  for (const city of snapshot.cities) {
    if (!CITY_KEYS.has(city.key)) continue;
    const imported = importPlaces({
      kind: city.kind,
      release: city.release || snapshot.release,
      bbox: city.bbox,
      features: city.features,
      bytes: city.bytes
    });
    byCity.set(city.key, imported);
  }
  return {
    source: "overture-places-pilot",
    operational: false,
    network: false,
    coverage,
    async run(payload) {
      if (!payload || payload.place_status !== "supported" || !CITY_KEYS.has(payload.cityKey)) {
        throw coded("place_rejected");
      }
      const imported = byCity.get(payload.cityKey);
      if (!imported) throw coded("place_rejected");
      const quantity = Number(payload.quantity);
      const limit = Number.isInteger(quantity) ? Math.min(40, Math.max(0, quantity)) : 10;
      const selected = imported.kept.filter((row) => matchIndustry(row, payload.industry)).slice(0, limit);
      const records = selected.map((row) => ({
        gersId: row.gersId,
        name: row.name,
        basicCategory: row.basicCategory,
        licenses: row.licenses,
        release: row.release,
        contactsVerified: false
      }));
      return {
        count: records.length,
        source: "overture-places-pilot",
        release: imported.release,
        coverage,
        contactsVerified: false,
        records
      };
    }
  };
}
