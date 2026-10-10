import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

async function loadSources() {
  const sandbox = { console, URL, fetch, AbortController, setTimeout, clearTimeout, Date };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(await readFile(new URL("../src/data.js", import.meta.url), "utf8"), sandbox);
  vm.runInContext(await readFile(new URL("../src/sources.js", import.meta.url), "utf8"), sandbox);
  return sandbox.KlirSources;
}

test("une fiche OpenStreetMap garde seulement les coordonnées publiées", async () => {
  const sources = await loadSources();
  const city = { city: "Montréal", province: "QC", country: "Canada", lat: 45.5, lng: -73.56 };
  const row = sources.osm.mapElement({
    type: "node",
    id: 42,
    tags: {
      name: "Noodles Star",
      amenity: "restaurant",
      phone: "+1-514-932-2888",
      website: "https://example.com/menu",
      "addr:housenumber": "1200",
      "addr:street": "rue Saint-Denis"
    }
  }, { industry: "restauration", city });
  assert.equal(row.company_name, "Noodles Star");
  assert.equal(row.phone, "+1-514-932-2888");
  assert.equal(row.website, "https://example.com/menu");
  assert.equal(row.public_email, "");
  assert.equal(row.industry_key, "restauration");
  assert.equal(row.source, "OpenStreetMap");
  assert.equal(row.source_url, "https://www.openstreetmap.org/node/42");

  const bare = sources.osm.mapElement({
    type: "node",
    id: 7,
    tags: { name: "Provigo", shop: "supermarket" }
  }, { industry: "all", city });
  assert.equal(bare.phone, "");
  assert.equal(bare.website, "");
  assert.equal(bare.public_email, "");
  assert.equal(bare.public_email.includes("@"), false);
});

test("la requête Overpass reste bornée et ne fabrique pas de filtre depuis le texte libre", async () => {
  const sources = await loadSources();
  const query = sources.osm.query({
    industry: "sante",
    city: { lat: 45.5017, lng: -73.5673 }
  }, 40);
  assert.match(query, /clinic\|doctors\|dentist/);
  assert.match(query, /out tags 40/);
  assert.equal(query.includes("ignore previous"), false);
  assert.throws(() => sources.osm.query({ industry: "all", city: {} }, 10), /coordonnées/);
});
