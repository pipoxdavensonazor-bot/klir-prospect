import { importPlaces } from "../../../tools/overture-places-import.mjs";
import { matchIndustry } from "../../../tools/overture-places-bounds.mjs";

const CITY_KEYS = new Set(["montréal", "laval", "québec", "toronto", "paris", "lyon", "marseille"]);

export const CATALOG_LOOKUP_SQL =
  "select gers_id, name, basic_category, licenses, release, website, phone from private.search_catalog_lookup_contacts($1, $2, $3)";

const WEBSITE = /^https?:\/\//i;

function cleanWebsite(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= 300 && WEBSITE.test(text) ? text : "";
}

function cleanPhone(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, 40) : "";
}

function coded(code, retryable = false) {
  const error = new Error(code);
  error.code = code;
  error.retryable = retryable;
  return error;
}

function quantityLimit(value) {
  const quantity = Number(value);
  return Number.isInteger(quantity) ? Math.min(40, Math.max(0, quantity)) : 10;
}

function rowsOf(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.rows)) return result.rows;
  return [];
}

function mapLookupRow(row) {
  const licenses = row.licenses;
  return {
    gersId: row.gers_id || row.gersId || "",
    name: row.name || "",
    basicCategory: row.basic_category || row.basicCategory || "",
    licenses: Array.isArray(licenses) ? licenses : [],
    release: row.release || "",
    website: cleanWebsite(row.website),
    phone: cleanPhone(row.phone),
    contactFields: true,
    contactsVerified: false
  };
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
      const limit = quantityLimit(payload.quantity);
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

export function createCatalogQueryProvider(query) {
  if (typeof query !== "function") throw coded("connexion_non_branchee");
  return {
    source: "overture-places-pilot",
    operational: false,
    network: false,
    coverage: "rayon_2200m_six_centres",
    async run(payload) {
      if (!payload || payload.place_status !== "supported" || !CITY_KEYS.has(payload.cityKey)) {
        throw coded("place_rejected");
      }
      const limit = quantityLimit(payload.quantity);
      const result = await query(CATALOG_LOOKUP_SQL, [payload.cityKey, payload.industry || "all", limit]);
      const records = rowsOf(result).map(mapLookupRow);
      return {
        count: records.length,
        source: "overture-places-pilot",
        release: records[0] && records[0].release ? records[0].release : "2026-10-21.0",
        coverage: "rayon_2200m_six_centres",
        contactsVerified: false,
        records
      };
    }
  };
}
