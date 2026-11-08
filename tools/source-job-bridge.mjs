// Prépare un payload compatible avec enqueue_search_job sans l'appeler.
// place_status ne devient "supported" que pour une ville déjà au contrat,
// après confirmation explicite du géocodage. Le drapeau jobs reste éteint.

const CITIES = [
  { key: "montréal", countryCode: "CA", latitude: 45.5017, longitude: -73.5673 },
  { key: "laval", countryCode: "CA", latitude: 45.6066, longitude: -73.7124 },
  { key: "québec", countryCode: "CA", latitude: 46.8139, longitude: -71.208 },
  { key: "toronto", countryCode: "CA", latitude: 43.6532, longitude: -79.3832 },
  { key: "paris", countryCode: "FR", latitude: 48.8566, longitude: 2.3522 },
  { key: "lyon", countryCode: "FR", latitude: 45.764, longitude: 4.8357 }
];
const RADIUS_M = 2200;
const MAX_PAYLOAD = 8192;

function distanceM(lat1, lon1, lat2, lon2) {
  const earth = 6371000;
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dLon / 2) ** 2;
  return 2 * earth * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function cityForPoint(latitude, longitude, countryCode) {
  const country = String(countryCode || "").toUpperCase();
  const matches = CITIES.filter((city) => city.countryCode === country && distanceM(latitude, longitude, city.latitude, city.longitude) <= RADIUS_M);
  if (matches.length !== 1) return null;
  return matches[0].key;
}

export function prepareJobPayload(input = {}) {
  const closed = {
    operational: false,
    enqueue: false,
    jobsEnabled: false,
    billing: "refuse",
    provider: "absent",
    scheduler: "off"
  };
  const geocode = input.geocode;
  if (!geocode || geocode.outcome !== "confirme" || !geocode.selected) {
    return { ...closed, ready: false, reason: "lieu_non_confirme", payload: null };
  }
  const cityKey = cityForPoint(geocode.selected.latitude, geocode.selected.longitude, geocode.selected.countryCode);
  if (!cityKey) return { ...closed, ready: false, reason: "lieu_hors_contrat", payload: null };
  const quantity = Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity < 10 || quantity > 40) {
    return { ...closed, ready: false, reason: "quantite_hors_contrat", payload: null };
  }
  const payload = {
    place_status: "supported",
    cityKey,
    quantity,
    radiusM: RADIUS_M,
    source: "overture-places",
    release: input.release || "",
    geocoder: "opencage"
  };
  if (Buffer.byteLength(JSON.stringify(payload)) > MAX_PAYLOAD) {
    return { ...closed, ready: false, reason: "payload_trop_grand", payload: null };
  }
  return { ...closed, ready: true, reason: "preparation_locale", payload, collection: "non_lancee" };
}
