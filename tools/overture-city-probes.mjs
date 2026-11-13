// Six sondes autour des centres déjà au contrat. Chaque rectangle fait
// quelques centaines de mètres. Ce n'est pas la ville, ni un géocodage.

export const RELEASE_PIN = "2026-10-21.0";
export const PROBE_HALF_DEGREES = 0.0025;
export const PROBE_LIMIT = 8;

export const CITY_PROBES = [
  { key: "montréal", countryCode: "CA", latitude: 45.5017, longitude: -73.5673, partition: "part-00006" },
  { key: "laval", countryCode: "CA", latitude: 45.6066, longitude: -73.7124, partition: "part-00006" },
  { key: "québec", countryCode: "CA", latitude: 46.8139, longitude: -71.208, partition: "part-00006" },
  { key: "toronto", countryCode: "CA", latitude: 43.6532, longitude: -79.3832, partition: "part-00003" },
  { key: "paris", countryCode: "FR", latitude: 48.8566, longitude: 2.3522, partition: "part-00007" },
  { key: "lyon", countryCode: "FR", latitude: 45.764, longitude: 4.8357, partition: "part-00009" }
];

export function probeBbox(city) {
  const half = PROBE_HALF_DEGREES;
  const bbox = {
    name: `${city.key}-centre-sonde`,
    west: round(city.longitude - half),
    south: round(city.latitude - half),
    east: round(city.longitude + half),
    north: round(city.latitude + half),
    note: `Sonde autour du centre déjà utilisé pour ${city.key}. Ce rectangle n'est pas la ville.`
  };
  if (bbox.east - bbox.west > 0.02 || bbox.north - bbox.south > 0.02) {
    throw new Error("emprise_refusee");
  }
  return bbox;
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
