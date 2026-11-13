function fold(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Import local d'un extrait Places déjà borné. Pas de téléchargement planète,
// pas de recherche utilisateur, pas de débit. La release est épinglée ; les
// champs taxonomy / basic_category / categories sont lus selon ce qui est
// présent, pas selon une hypothèse figée.

export const RELEASE_PIN = "2026-10-21.0";
export const CATEGORIES_REMOVED_AT = "2026-09-23.0";
export const MAX_FEATURES = 15_000;
export const MAX_BYTES = 20_000_000;
export const MAX_BBOX_DEGREES = 0.08;
export const PILOT_PROBE_BBOX = Object.freeze({
  name: "montréal-centre-sonde",
  west: -73.5695,
  south: 45.5008,
  east: -73.5651,
  north: 45.5027,
  note: "Sonde autour du centre Montréal déjà utilisé (45.5017, -73.5673). Ce rectangle n'est pas la ville."
});

const FOURSQUARE_NOTICE = "Copyright 2024 Foursquare Labs, Inc. All rights reserved.";
const FOURSQUARE_CHANGED = "2026-03-18";

const SOURCE_LICENSES = new Map([
  ["meta", "CDLA-Permissive-2.0"],
  ["microsoft", "CDLA-Permissive-2.0"],
  ["pinmeto", "CDLA-Permissive-2.0"],
  ["krick", "CDLA-Permissive-2.0"],
  ["renderseo", "CDLA-Permissive-2.0"],
  ["dac", "CDLA-Permissive-2.0"],
  ["brightquery", "CDLA-Permissive-2.0"],
  ["birdeye", "CDLA-Permissive-2.0"],
  ["uberall", "CDLA-Permissive-2.0"],
  ["opentravel", "CDLA-Permissive-2.0"],
  ["opentravelalliance", "CDLA-Permissive-2.0"],
  ["overture", "CDLA-Permissive-2.0"]
]);

function reject(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function releaseStamp(value) {
  const match = /^(\d{4}-\d{2}-\d{2})\.(\d+)$/.exec(String(value || ""));
  if (!match) return null;
  return match[1];
}

export function knownSourceNotice(name) {
  const key = fold(name).replace(/[^a-z0-9]+/g, "");
  if (key === "foursquare" || key === "foursquareosplaces") {
    return {
      license: "Apache-2.0",
      notice: FOURSQUARE_NOTICE,
      transformed: "Données Foursquare transformées vers le schéma Overture.",
      changed: FOURSQUARE_CHANGED
    };
  }
  if (key === "alltheplaces") return { license: "CC0-1.0", notice: "AllThePlaces, CC0 1.0." };
  const license = SOURCE_LICENSES.get(key);
  if (!license) return null;
  return { license, notice: `Data from ${name}. Available under CDLA Permissive 2.0.` };
}

export function readPlaceCategory(properties, release) {
  const source = properties || {};
  const taxonomy = source.taxonomy && typeof source.taxonomy === "object" ? source.taxonomy : null;
  const basic = typeof source.basic_category === "string" ? source.basic_category : "";
  const legacy = source.categories && typeof source.categories === "object" ? source.categories : null;
  const hierarchy = taxonomy && Array.isArray(taxonomy.hierarchy)
    ? taxonomy.hierarchy.filter((item) => typeof item === "string")
    : [];
  const alternates = taxonomy && Array.isArray(taxonomy.alternates)
    ? taxonomy.alternates.filter((item) => typeof item === "string")
    : [];
  const primary = taxonomy && typeof taxonomy.primary === "string"
    ? taxonomy.primary
    : legacy && typeof legacy.primary === "string"
      ? legacy.primary
      : "";
  const current = releaseStamp(release) && releaseStamp(release) >= CATEGORIES_REMOVED_AT;
  let observed = "absent";
  if (basic) observed = "basic_category";
  else if (taxonomy) observed = "taxonomy";
  else if (legacy) observed = "categories";
  return {
    basicCategory: basic,
    primary,
    hierarchy,
    alternates,
    legacyPresent: Boolean(legacy),
    observed,
    unexpectedLegacy: Boolean(current && legacy && !taxonomy && !basic)
  };
}

function strings(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}

function sourceEntries(properties) {
  const raw = Array.isArray(properties.sources) ? properties.sources : [];
  return raw.map((source) => {
    const dataset = typeof source.dataset === "string" ? source.dataset : "";
    const property = typeof source.property === "string" ? source.property : "";
    const stated = typeof source.license === "string" ? source.license : "";
    const known = knownSourceNotice(dataset) || knownSourceNotice(property);
    return {
      dataset,
      property,
      recordId: typeof source.record_id === "string" ? source.record_id : "",
      updateTime: typeof source.update_time === "string" ? source.update_time : "",
      statedLicense: stated,
      documentedLicense: known ? known.license : "",
      notice: known ? known.notice : "",
      changed: known && known.changed ? known.changed : "",
      divergent: Boolean(stated && known && stated !== known.license)
    };
  });
}

function bboxOf(value) {
  if (!value || typeof value !== "object") throw reject("emprise_refusee");
  const west = Number(value.west);
  const south = Number(value.south);
  const east = Number(value.east);
  const north = Number(value.north);
  if (![west, south, east, north].every(Number.isFinite)) throw reject("emprise_refusee");
  if (west < -180 || east > 180 || south < -90 || north > 90 || west >= east || south >= north) throw reject("emprise_refusee");
  if (east - west > MAX_BBOX_DEGREES || north - south > MAX_BBOX_DEGREES) throw reject("emprise_refusee");
  return { west, south, east, north };
}

function inside(longitude, latitude, bbox) {
  return longitude >= bbox.west && longitude <= bbox.east && latitude >= bbox.south && latitude <= bbox.north;
}

function normalize(feature, release, bbox) {
  const properties = feature && feature.properties || {};
  const id = feature && feature.id ? String(feature.id) : "";
  if (!id) return { reject: "identifiant_absent" };
  const name = properties.names && typeof properties.names.primary === "string" ? properties.names.primary.normalize("NFC").trim() : "";
  if (!name) return { reject: "nom_absent", id };
  const geometry = feature.geometry || {};
  const coordinates = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  if (geometry.type !== "Point" || coordinates.length < 2) return { reject: "geometrie_absente", id };
  const longitude = Number(coordinates[0]);
  const latitude = Number(coordinates[1]);
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) return { reject: "geometrie_absente", id };
  if (!inside(longitude, latitude, bbox)) return { reject: "hors_emprise", id };
  const address = Array.isArray(properties.addresses) ? properties.addresses[0] || {} : {};
  const category = readPlaceCategory(properties, release);
  const sources = sourceEntries(properties);
  const licenses = [...new Set(sources.flatMap((source) => [source.statedLicense, source.documentedLicense]).filter(Boolean))];
  return {
    record: {
      gersId: id,
      name,
      nameFold: fold(name),
      basicCategory: category.basicCategory,
      taxonomyPrimary: category.primary,
      categoryTokens: [...new Set([category.basicCategory, category.primary, ...category.hierarchy, ...category.alternates].filter(Boolean))],
      categoryObserved: category.observed,
      unexpectedLegacy: category.unexpectedLegacy,
      latitude,
      longitude,
      locality: typeof address.locality === "string" ? address.locality.normalize("NFC").trim() : "",
      country: typeof address.country === "string" ? address.country : "",
      phones: strings(properties.phones),
      emails: strings(properties.emails),
      websites: strings(properties.websites),
      contactsVerified: false,
      sources,
      licenses,
      notices: sources.filter((source) => source.notice).map((source) => source.notice),
      release,
      dataset: "overture-places"
    }
  };
}

function duplicate(left, right) {
  if (left.gersId === right.gersId) return "meme_gers";
  if (left.nameFold && left.nameFold === right.nameFold && left.locality && fold(left.locality) === fold(right.locality) && left.latitude === right.latitude && left.longitude === right.longitude) {
    return "meme_nom_point";
  }
  return "";
}

export function importPlaces(snapshot) {
  if (!snapshot || (snapshot.kind !== "fixture" && snapshot.kind !== "local-extract")) throw reject("instantane_invalide");
  if (snapshot.release !== RELEASE_PIN) throw reject("release_non_figee");
  if (snapshot.bytes != null && (!Number.isInteger(snapshot.bytes) || snapshot.bytes < 0 || snapshot.bytes > MAX_BYTES)) {
    throw reject("extrait_trop_grand");
  }
  const bbox = bboxOf(snapshot.bbox);
  const features = Array.isArray(snapshot.features) ? snapshot.features : null;
  if (!features) throw reject("instantane_invalide");
  if (features.length > MAX_FEATURES) throw reject("trop_de_fiches");
  const rejected = [];
  const prepared = [];
  for (const feature of features) {
    const result = normalize(feature, snapshot.release, bbox);
    if (result.reject) rejected.push({ id: result.id || "", reason: result.reject });
    else prepared.push(result.record);
  }
  const kept = [];
  const duplicates = [];
  for (const record of prepared) {
    const match = kept.find((item) => duplicate(item, record));
    if (!match) {
      kept.push(record);
      continue;
    }
    duplicates.push({ keptId: match.gersId, droppedId: record.gersId, reason: duplicate(match, record) });
  }
  return {
    operational: false,
    network: false,
    indexReady: false,
    contactsVerified: false,
    coverage: "extrait_borne",
    kind: snapshot.kind,
    release: snapshot.release,
    bbox,
    kept,
    rejected,
    duplicates,
    limits: { maxFeatures: MAX_FEATURES, maxBytes: MAX_BYTES, maxBboxDegrees: MAX_BBOX_DEGREES }
  };
}
