import assert from "node:assert/strict";
import test from "node:test";
import { createOverturePilotProvider } from "../supabase/functions/_shared/search-job-overture-pilot.mjs";
import {
  ATTRIBUTION,
  CITY_CENTERS,
  EXTRACT_RADIUS_M,
  matchIndustry,
  radiusBbox,
  simulateQuantity
} from "../tools/overture-places-bounds.mjs";
import { extractCommand, EXTRACT_SCRIPT } from "../tools/overture-places-extract.mjs";
import {
  importPlaces,
  MAX_BBOX_DEGREES,
  MAX_FEATURES,
  RELEASE_PIN
} from "../tools/overture-places-import.mjs";

function feature(id, name, lon, lat, tokens = ["restaurant"]) {
  return {
    id,
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: {
      names: { primary: name },
      basic_category: tokens[0],
      taxonomy: { primary: tokens[0], hierarchy: tokens, alternates: [] },
      addresses: [{ locality: "Laval", country: "CA" }],
      sources: [{ dataset: "meta", license: "CDLA-Permissive-2.0" }]
    }
  };
}

test("les rectangles de 2200 m restent sous le plafond d'emprise et ne prétendent pas être la ville", () => {
  assert.equal(CITY_CENTERS.length, 6);
  for (const city of CITY_CENTERS) {
    const bbox = radiusBbox(city);
    assert.equal(bbox.radiusM, EXTRACT_RADIUS_M);
    assert.ok(bbox.east - bbox.west <= MAX_BBOX_DEGREES);
    assert.ok(bbox.north - bbox.south <= MAX_BBOX_DEGREES);
    assert.match(bbox.note, /pas la limite administrative/);
  }
});

test("un extrait local de plus de 40 fiches est accepté dans le rayon de travail", () => {
  const city = CITY_CENTERS.find((item) => item.key === "laval");
  const bbox = radiusBbox(city);
  const features = Array.from({ length: 41 }, (_, index) => feature(
    `08b2k${String(index).padStart(6, "0")}`,
    index % 2 ? `Café ${index}` : `Boutique ${index}`,
    city.longitude,
    city.latitude,
    index % 2 ? ["cafe", "food_and_drink"] : ["fashion_and_apparel_store", "shopping"]
  ));
  const imported = importPlaces({
    kind: "local-extract",
    release: RELEASE_PIN,
    bbox,
    features
  });
  assert.equal(imported.kept.length, 41);
  assert.equal(imported.rejected.length, 0);
  assert.equal(imported.limits.maxFeatures, MAX_FEATURES);
  assert.ok(MAX_FEATURES > 40);
  const food = imported.kept.filter((row) => matchIndustry(row, "restauration"));
  const retail = imported.kept.filter((row) => matchIndustry(row, "commerce"));
  assert.equal(food.length, 20);
  assert.equal(retail.length, 21);
  assert.equal(simulateQuantity(imported.kept, { industry: "restauration", quantity: 10 }).returned, 10);
  assert.equal(simulateQuantity(imported.kept, { industry: "construction", quantity: 10 }).returned, 0);
});

test("le fournisseur filtre un secteur sans appeler le réseau et ignore un secteur inconnu", async () => {
  const city = CITY_CENTERS.find((item) => item.key === "laval");
  const bbox = radiusBbox(city);
  const snapshot = {
    release: RELEASE_PIN,
    coverage: "rayon_2200m_six_centres",
    attribution: ATTRIBUTION,
    cities: [{
      key: "laval",
      kind: "local-extract",
      release: RELEASE_PIN,
      bbox,
      features: [
        feature("food-1", "Café Testé", city.longitude, city.latitude, ["cafe", "food_and_drink"]),
        feature("shop-1", "Boutique Test", city.longitude, city.latitude, ["fashion_and_apparel_store", "shopping"])
      ]
    }]
  };
  const provider = createOverturePilotProvider(snapshot);
  assert.equal(provider.network, false);
  assert.equal(provider.coverage, "rayon_2200m_six_centres");
  const all = await provider.run({ place_status: "supported", cityKey: "laval", quantity: 10 });
  assert.equal(all.count, 2);
  const food = await provider.run({ place_status: "supported", cityKey: "laval", industry: "restauration", quantity: 10 });
  assert.equal(food.count, 1);
  assert.equal(food.records[0].name, "Café Testé");
  assert.equal(food.records[0].contactsVerified, false);
  const unknown = await provider.run({ place_status: "supported", cityKey: "laval", industry: "secteur-inconnu", quantity: 10 });
  assert.equal(unknown.count, 0);
});

test("la commande d'extrait pointe vers le script Python versionné, sans réseau dans ce test", () => {
  const command = extractCommand("/tmp/overture-six-centers.json", { python: "/tmp/duckdb-venv/bin/python", checkOnly: true });
  assert.equal(command.python, "/tmp/duckdb-venv/bin/python");
  assert.ok(command.args[0].endsWith("overture-places-extract.py"));
  assert.equal(command.args[0], EXTRACT_SCRIPT);
  assert.ok(command.args.includes("--python-check-only"));
});
