import { readFile } from "node:fs/promises";

// Périmètre du pilote déjà mesuré, pas une couverture mondiale.
// Aucun téléchargement, aucun géocodeur, aucune acceptation de licence.
export const PILOT_RELEASE = "2026-10-21.0";
export const PILOT_RADIUS_M = 2200;
export const PILOT_CITIES = [
  { key: "montréal", latitude: 45.5017, longitude: -73.5673 },
  { key: "laval", latitude: 45.6066, longitude: -73.7124 },
  { key: "québec", latitude: 46.8139, longitude: -71.208 }
];

export function overtureLiveSource() {
  return {
    enabled: false,
    network: false,
    operational: false,
    reason: "redistribution_volume_stockage_non_decides"
  };
}

function reject(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function fold(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function digits(value) {
  return String(value || "").replace(/\D/g, "");
}

function distanceM(lat1, lon1, lat2, lon2) {
  const earth = 6371000;
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

function asStrings(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && item.trim() !== "").map((item) => item.trim());
}

function singleOrEmpty(values, contradictions, field) {
  if (values.length === 1) return values[0];
  if (values.length > 1) contradictions.push(field);
  return "";
}

function cityOf(locality) {
  const folded = fold(locality);
  return PILOT_CITIES.find((city) => fold(city.key) === folded) || null;
}

function declaredCities(scope) {
  if (!scope || !Array.isArray(scope.cities) || scope.cities.length === 0) throw reject("perimetre_refuse");
  if (scope.radiusM == null || Number(scope.radiusM) <= 0 || Number(scope.radiusM) > PILOT_RADIUS_M) {
    throw reject("perimetre_refuse");
  }
  const cities = [];
  for (const name of scope.cities) {
    const city = cityOf(name);
    if (!city || cities.some((item) => item.key === city.key)) throw reject("perimetre_refuse");
    cities.push(city);
  }
  return cities;
}

function normalizeFeature(feature, cities, radiusM, release) {
  const properties = feature && feature.properties || {};
  const id = feature && feature.id ? String(feature.id) : "";
  if (!id) return { reject: "identifiant_absent" };
  const name = properties.names && typeof properties.names.primary === "string" ? properties.names.primary.trim() : "";
  if (!name) return { reject: "nom_absent", id };
  const status = String(properties.operating_status || "").toLowerCase();
  if (status === "closed") return { reject: "ferme_declare", id };
  if (properties.confidence === 0) return { reject: "confiance_nulle", id };
  const geometry = feature.geometry || {};
  const coordinates = Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  if (geometry.type !== "Point" || coordinates.length < 2 || !Number.isFinite(coordinates[0]) || !Number.isFinite(coordinates[1])) {
    return { reject: "geometrie_absente", id };
  }
  const address = Array.isArray(properties.addresses) ? properties.addresses[0] || {} : {};
  const locality = typeof address.locality === "string" ? address.locality.trim() : "";
  const city = cityOf(locality);
  if (!locality || !city) return { reject: "localite_hors_perimetre", id };
  if (!cities.some((item) => item.key === city.key)) return { reject: "localite_hors_perimetre", id };
  const longitude = coordinates[0];
  const latitude = coordinates[1];
  if (distanceM(latitude, longitude, city.latitude, city.longitude) > radiusM) {
    return { reject: "hors_cercle", id };
  }
  const contradictions = [];
  const phones = asStrings(properties.phones);
  const emails = asStrings(properties.emails);
  const websites = asStrings(properties.websites);
  const sources = Array.isArray(properties.sources) ? properties.sources : [];
  const licenses = [...new Set(asStrings(sources.map((source) => source && source.license)))];
  const field = (path) => ({ path, release, licenses });
  return {
    record: {
      id,
      name,
      address: typeof address.freeform === "string" ? address.freeform.trim() : "",
      city: locality,
      region: typeof address.region === "string" ? address.region.trim() : "",
      country: typeof address.country === "string" ? address.country.trim() : "",
      postalCode: typeof address.postcode === "string" ? address.postcode.trim() : "",
      latitude,
      longitude,
      phone: singleOrEmpty(phones, contradictions, "phones"),
      email: singleOrEmpty(emails, contradictions, "emails"),
      website: singleOrEmpty(websites, contradictions, "websites"),
      publishedPhones: phones,
      publishedEmails: emails,
      publishedWebsites: websites,
      contradictions,
      provenance: {
        release,
        sourceId: id,
        dataset: "overture-places",
        licenses,
        fields: {
          name: field("properties.names.primary"),
          address: field("properties.addresses[0]"),
          city: field("properties.addresses[0].locality")
        }
      }
    }
  };
}

function duplicateReason(left, right) {
  if (left.id === right.id) return "meme_identifiant";
  const leftAddress = fold(left.address);
  const rightAddress = fold(right.address);
  if (fold(left.name) === fold(right.name) && leftAddress && leftAddress === rightAddress && left.postalCode && left.postalCode === right.postalCode) {
    return "meme_nom_adresse_code";
  }
  const leftPhone = digits(left.phone);
  if (leftPhone && leftPhone === digits(right.phone)) return "meme_telephone";
  const leftEmail = fold(left.email);
  if (leftEmail && leftEmail === fold(right.email)) return "meme_courriel";
  return "";
}

export function ingestSnapshot(snapshot) {
  if (!snapshot || (snapshot.kind !== "fixture" && snapshot.kind !== "local-snapshot")) throw reject("instantane_invalide");
  if (!/^\d{4}-\d{2}-\d{2}\.\d+$/.test(String(snapshot.release || ""))) throw reject("release_non_figee");
  const cities = declaredCities(snapshot.scope);
  const features = Array.isArray(snapshot.features) ? snapshot.features : null;
  if (!features) throw reject("instantane_invalide");
  const rejected = [];
  const prepared = [];
  for (const feature of features) {
    const result = normalizeFeature(feature, cities, Number(snapshot.scope.radiusM), snapshot.release);
    if (result.reject) rejected.push({ id: result.id || "", reason: result.reject });
    else prepared.push(result.record);
  }
  const kept = [];
  const duplicates = [];
  for (const record of prepared) {
    const match = kept.find((item) => duplicateReason(item, record));
    if (!match) {
      kept.push(record);
      continue;
    }
    duplicates.push({ keptId: match.id, droppedId: record.id, reason: duplicateReason(match, record) });
  }
  return {
    operational: false,
    network: false,
    coverage: snapshot.kind,
    release: snapshot.release,
    scope: cities.map((city) => city.key),
    kept,
    rejected,
    duplicates
  };
}

export async function readLocalSnapshot(filePath) {
  const path = String(filePath || "");
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) throw reject("reseau_refuse");
  const text = await readFile(path, "utf8");
  return JSON.parse(text);
}
