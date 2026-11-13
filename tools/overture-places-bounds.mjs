// Bornes de travail des six centres, pas des limites administratives.
// Aucun appel réseau, aucun géocodeur.

export const EXTRACT_RADIUS_M = 2200;
export const EARTH_M_PER_DEGREE = 111320;
export const CITY_CENTERS = Object.freeze([
  { key: "montréal", countryCode: "CA", latitude: 45.5017, longitude: -73.5673 },
  { key: "laval", countryCode: "CA", latitude: 45.6066, longitude: -73.7124 },
  { key: "québec", countryCode: "CA", latitude: 46.8139, longitude: -71.208 },
  { key: "toronto", countryCode: "CA", latitude: 43.6532, longitude: -79.3832 },
  { key: "paris", countryCode: "FR", latitude: 48.8566, longitude: 2.3522 },
  { key: "lyon", countryCode: "FR", latitude: 45.764, longitude: 4.8357 }
]);

export const ATTRIBUTION = Object.freeze({
  cdla: "Community Data License Agreement – Permissive, Version 2.0. Le partage des données exige de joindre le texte de cet accord. https://cdla.dev/permissive-2-0/",
  apache: "Apache License 2.0. Fournir une copie de la licence, conserver les mentions, signaler les fichiers modifiés et la date. https://www.apache.org/licenses/LICENSE-2.0",
  foursquare: "Copyright 2024 Foursquare Labs, Inc. All rights reserved. Données Foursquare transformées vers le schéma Overture. Changed: 2026-03-18.",
  cc0: "AllThePlaces, CC0 1.0.",
  placesNote: "Overture Places (thème places) ne contient pas de données OpenStreetMap et n'est pas publié sous ODbL. Ne pas le fusionner avec le thème Divisions ou d'autres traces OSM dans cet extrait.",
  sources: [
    "https://docs.overturemaps.org/guides/places/",
    "https://docs.overturemaps.org/attribution/",
    "https://cdla.dev/permissive-2-0/",
    "https://www.apache.org/licenses/LICENSE-2.0"
  ]
});

export const INDUSTRY_CATEGORY_TOKENS = Object.freeze({
  restauration: Object.freeze([
    "food_and_drink", "restaurant", "casual_eatery", "cafe", "coffee_shop", "bar",
    "pub", "bakery", "fast_food_restaurant", "pizzeria", "dessert_shop",
    "ice_cream_shop", "meal_takeaway", "tea_room", "bistro", "brasserie"
  ]),
  construction: Object.freeze([
    "building_or_construction_service", "contractor", "general_contractor",
    "plumbing", "electrician", "roofing", "painting", "masonry_contractor",
    "flooring_contractor", "carpentry", "construction", "hvac"
  ]),
  commerce: Object.freeze([
    "shopping", "fashion_and_apparel_store", "grocery_store", "food_and_beverage_store",
    "electronics_store", "hardware_home_and_garden_store", "specialty_store",
    "shopping_mall", "books_music_and_video_store", "convenience_store",
    "supermarket", "flowers_and_gifts_store", "sporting_goods_store",
    "department_store"
  ]),
  immobilier: Object.freeze(["real_estate_service", "real_estate", "property_management"]),
  sante: Object.freeze([
    "health_care", "outpatient_care_facility", "dental_clinic", "dentist",
    "general_dentistry", "physician", "pharmacy", "hospital", "physical_therapy",
    "primary_care_or_general_clinic", "wellness_service"
  ]),
  technologie: Object.freeze(["technical_service", "software", "it_service", "computer_service", "web_service"]),
  finance: Object.freeze(["financial_service", "bank_or_credit_union", "insurance", "accounting", "investment_service"]),
  services: Object.freeze([
    "professional_service", "attorney_or_law_firm", "home_service",
    "design_service", "event_or_party_service", "legal_service"
  ])
});

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

export function cityCenter(key) {
  return CITY_CENTERS.find((city) => city.key === key) || null;
}

export function radiusBbox(city, radiusM = EXTRACT_RADIUS_M) {
  if (!city || !Number.isFinite(city.latitude) || !Number.isFinite(city.longitude)) {
    throw new Error("emprise_refusee");
  }
  if (!Number.isFinite(radiusM) || radiusM <= 0 || radiusM > EXTRACT_RADIUS_M) {
    throw new Error("emprise_refusee");
  }
  const dlat = radiusM / EARTH_M_PER_DEGREE;
  const dlon = radiusM / (EARTH_M_PER_DEGREE * Math.cos(city.latitude * Math.PI / 180));
  return {
    name: `${city.key}-rayon-${radiusM}m`,
    west: round6(city.longitude - dlon),
    south: round6(city.latitude - dlat),
    east: round6(city.longitude + dlon),
    north: round6(city.latitude + dlat),
    radiusM,
    note: `Rectangle de travail d'un rayon de ${radiusM} m autour du centre déjà utilisé pour ${city.key}. Ce n'est pas la limite administrative de la ville.`
  };
}

export function industryTokenSet(industry) {
  const tokens = INDUSTRY_CATEGORY_TOKENS[industry];
  return tokens ? new Set(tokens) : null;
}

export function categoryTokensOf(row) {
  const values = [];
  if (row && typeof row.basicCategory === "string") values.push(row.basicCategory);
  if (row && typeof row.taxonomyPrimary === "string") values.push(row.taxonomyPrimary);
  if (row && Array.isArray(row.categoryTokens)) values.push(...row.categoryTokens);
  return values.filter((item) => typeof item === "string" && item);
}

export function matchIndustry(row, industry) {
  if (!industry || industry === "all") return true;
  const allowed = industryTokenSet(industry);
  if (!allowed) return false;
  return categoryTokensOf(row).some((token) => allowed.has(token));
}

export function simulateQuantity(kept, options = {}) {
  const quantity = Number(options.quantity);
  const limit = Number.isInteger(quantity) ? Math.min(40, Math.max(0, quantity)) : 10;
  const matched = (kept || []).filter((row) => matchIndustry(row, options.industry));
  return {
    industry: options.industry || "all",
    available: matched.length,
    returned: Math.min(limit, matched.length),
    quantity: limit
  };
}
