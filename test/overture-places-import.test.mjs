import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MAX_BYTES,
  MAX_FEATURES,
  PILOT_PROBE_BBOX,
  RELEASE_PIN,
  importPlaces,
  readPlaceCategory
} from "../tools/overture-places-import.mjs";

function feature(partial = {}) {
  return {
    type: "Feature",
    id: partial.id || "gers-cafe-montreal",
    geometry: { type: "Point", coordinates: partial.coordinates || [-73.5673, 45.5017] },
    properties: {
      names: { primary: partial.name || "Café Montréal" },
      basic_category: partial.basic === undefined ? "cafe" : partial.basic,
      taxonomy: partial.taxonomy === undefined ? { primary: "cafe", hierarchy: ["food_and_drink", "cafe"], alternates: [] } : partial.taxonomy,
      categories: partial.categories,
      addresses: [{ locality: partial.locality || "Montréal", country: "CA" }],
      phones: partial.phones || [],
      emails: partial.emails || [],
      websites: partial.websites || [],
      sources: partial.sources || [{ dataset: "meta", property: "names", record_id: "m-1" }]
    }
  };
}

function snapshot(features, extra = {}) {
  return {
    kind: "fixture",
    release: RELEASE_PIN,
    bbox: PILOT_PROBE_BBOX,
    features,
    ...extra
  };
}

test("une fiche fictive garde le nom Unicode, la licence lue et aucun contact vérifié", () => {
  const result = importPlaces(snapshot([
    feature({
      phones: ["514-555-0100", "514-555-0199"],
      sources: [
        { dataset: "meta", property: "names" },
        { dataset: "Foursquare", property: "names", license: "Apache-2.0" }
      ]
    })
  ]));
  assert.equal(result.operational, false);
  assert.equal(result.indexReady, false);
  assert.equal(result.contactsVerified, false);
  assert.equal(result.kind, "fixture");
  const row = result.kept[0];
  assert.equal(row.name, "Café Montréal");
  assert.equal(row.nameFold, "cafe montreal");
  assert.equal(row.gersId, "gers-cafe-montreal");
  assert.equal(row.emails.length, 0);
  assert.equal(row.contactsVerified, false);
  assert.equal(row.categoryObserved, "basic_category");
  assert.ok(row.licenses.includes("CDLA-Permissive-2.0"));
  assert.ok(row.licenses.includes("Apache-2.0"));
  assert.match(row.notices.join(" "), /Copyright 2024 Foursquare Labs, Inc/);
  assert.ok(row.sources.some((source) => source.changed === "2026-03-18"));
});

test("la release épinglée lit categories comme héritage inattendu, pas comme schéma courant", () => {
  const category = readPlaceCategory({ categories: { primary: "restaurant" } }, RELEASE_PIN);
  assert.equal(category.observed, "categories");
  assert.equal(category.unexpectedLegacy, true);
  const current = readPlaceCategory({ basic_category: "restaurant", taxonomy: { primary: "casual_eatery", hierarchy: ["food_and_drink", "casual_eatery"] } }, RELEASE_PIN);
  assert.equal(current.observed, "basic_category");
  assert.equal(current.unexpectedLegacy, false);
  const result = importPlaces(snapshot([feature({ basic: "", taxonomy: null, categories: { primary: "restaurant" } })]));
  assert.equal(result.kept[0].unexpectedLegacy, true);
  assert.equal(result.kept[0].taxonomyPrimary, "restaurant");
});

test("les plafonds de volume, d'octets et d'emprise sont des refus", () => {
  assert.throws(() => importPlaces(snapshot([feature()], { release: "2026-09-23.0" })), /release_non_figee/);
  assert.throws(() => importPlaces(snapshot(Array.from({ length: MAX_FEATURES + 1 }, (_, index) => feature({ id: `gers-${index}` })))), /trop_de_fiches/);
  assert.throws(() => importPlaces(snapshot([feature()], { bytes: MAX_BYTES + 1 })), /extrait_trop_grand/);
  assert.throws(() => importPlaces(snapshot([feature()], { bbox: { west: -74, south: 45, east: -73, north: 46 } })), /emprise_refusee/);
  const outside = importPlaces(snapshot([feature({ coordinates: [-73.6, 45.51] })]));
  assert.equal(outside.kept.length, 0);
  assert.equal(outside.rejected[0].reason, "hors_emprise");
});

test("le même GERS n'est pas recopié et un domaine n'est pas un contact inventé", () => {
  const result = importPlaces(snapshot([
    feature({ id: "gers-1", websites: ["https://exemple.invalid"] }),
    feature({ id: "gers-1", name: "Autre nom" })
  ]));
  assert.equal(result.kept.length, 1);
  assert.equal(result.duplicates[0].reason, "meme_gers");
  assert.equal(result.kept[0].emails.length, 0);
  assert.equal(result.kept[0].phones.length, 0);
});

test("un extrait public local, s'il a été déposé, reste distinct d'une fixture", async (t) => {
  let text;
  try {
    text = await readFile(new URL("./fixtures/overture-places-public.json", import.meta.url), "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      t.skip("aucun extrait public local : la sonde n'a pas été conservée");
      return;
    }
    throw error;
  }
  const snapshotFile = JSON.parse(text);
  assert.equal(snapshotFile.kind, "local-extract");
  assert.equal(snapshotFile.release, RELEASE_PIN);
  assert.ok(snapshotFile.bytes <= MAX_BYTES);
  assert.ok(snapshotFile.features.length <= MAX_FEATURES);
  assert.equal(snapshotFile.categoriesColumn, false);
  assert.equal(snapshotFile.emailsOmittedFromRepo, 1);
  const result = importPlaces(snapshotFile);
  assert.equal(result.kind, "local-extract");
  assert.equal(result.operational, false);
  assert.equal(result.contactsVerified, false);
  assert.ok(result.kept.some((row) => row.name !== row.nameFold));
  assert.ok(result.kept.every((row) => row.categoryObserved !== "categories"));
  for (const row of result.kept) {
    assert.equal(row.contactsVerified, false);
    assert.ok(row.gersId);
    assert.equal(row.name, row.name.normalize("NFC"));
  }
});
