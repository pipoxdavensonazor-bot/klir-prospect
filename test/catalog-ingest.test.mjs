import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fold, ingestSnapshot, overtureLiveSource, PILOT_RELEASE, readLocalSnapshot } from "../tools/catalog-ingest.mjs";

function place(id, name, city, extra = {}) {
  return {
    type: "Feature",
    id,
    geometry: { type: "Point", coordinates: extra.coordinates || [-73.5673, 45.5017] },
    properties: {
      names: { primary: name },
      operating_status: extra.status || "open",
      confidence: extra.confidence,
      addresses: [{
        freeform: extra.address || "1 rue Principale",
        locality: city,
        region: extra.region || "Québec",
        country: "CA",
        postcode: extra.postalCode || "H2X 1Y4"
      }],
      phones: extra.phones || [],
      emails: extra.emails || [],
      websites: extra.websites || [],
      sources: extra.sources || [{ license: "CDLA-Permissive-2.0", dataset: "overture" }]
    }
  };
}

function snapshot(features, scopeCities = ["Montréal"], kind = "fixture") {
  return {
    kind,
    release: PILOT_RELEASE,
    scope: { cities: scopeCities, radiusM: 2200 },
    features
  };
}

test("la source vivante reste fermée et le module n'appelle pas le réseau", async () => {
  assert.deepEqual(overtureLiveSource(), {
    enabled: false,
    network: false,
    operational: false,
    reason: "redistribution_volume_stockage_non_decides"
  });
  const source = await readFile(new URL("../tools/catalog-ingest.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetch\s*\(|nominatim|linkedin|jobs_enabled\s*=\s*true|reserve_usage/i);
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.doesNotMatch(app, /catalog-ingest/);
  await assert.rejects(readLocalSnapshot("https://example.test/places.json"), /reseau_refuse/);
});

test("une fixture conserve l'Unicode, la provenance, et n'invente pas les champs vides", () => {
  const result = ingestSnapshot(snapshot([
    place("ov-1", "Café de l'Île", "Montréal", { phones: ["+1 514 555 0100"], websites: ["https://ile.example"] })
  ]));
  assert.equal(result.operational, false);
  assert.equal(result.network, false);
  assert.equal(result.coverage, "fixture");
  assert.equal(result.kept.length, 1);
  const row = result.kept[0];
  assert.equal(row.name, "Café de l'Île");
  assert.equal(row.city, "Montréal");
  assert.equal(row.region, "Québec");
  assert.equal(row.phone, "+1 514 555 0100");
  assert.equal(row.email, "");
  assert.equal(row.website, "https://ile.example");
  assert.deepEqual(row.provenance.licenses, ["CDLA-Permissive-2.0"]);
  assert.equal(row.provenance.release, PILOT_RELEASE);
  assert.equal(row.provenance.fields.name.path, "properties.names.primary");
});

test("les homonymes restent distincts, le même établissement est dédoublonné, les contradictions restent visibles", () => {
  const result = ingestSnapshot(snapshot([
    place("ov-a", "Café Nord", "Montréal", { address: "10 rue A", postalCode: "H2X 1A1", websites: ["https://nord.example"] }),
    place("ov-b", "Café Nord", "Montréal", { address: "20 rue B", postalCode: "H2Y 2B2", websites: ["https://nord.example"], coordinates: [-73.57, 45.51] }),
    place("ov-c", "Café de l'Île", "Montréal", { address: "1 rue Principale", postalCode: "H2X 1Y4" }),
    place("ov-d", "Cafe de l'Ile", "Montreal", { address: "1 rue Principale", postalCode: "H2X 1Y4", coordinates: [-73.568, 45.502] }),
    place("ov-e", "Boulangerie Est", "Montréal", { phones: ["5145550199", "+1 514 555 0199"] }),
    place("ov-f", "Autre Nom", "Montréal", { phones: ["+1 514 555 0100"], address: "9 rue Z", postalCode: "H1A 1A1", coordinates: [-73.56, 45.50] }),
    place("ov-g", "Téléphone Partagé", "Montréal", { phones: ["+1 514 555 0100"], address: "8 rue Y", postalCode: "H1B 1B1", coordinates: [-73.565, 45.505] })
  ], ["montréal"]));
  const names = result.kept.map((row) => row.id);
  assert.ok(names.includes("ov-a") && names.includes("ov-b"));
  assert.equal(result.duplicates.some((item) => item.droppedId === "ov-d" && item.reason === "meme_nom_adresse_code"), true);
  assert.equal(result.kept.find((row) => row.id === "ov-c").name, "Café de l'Île");
  const shared = result.duplicates.find((item) => item.droppedId === "ov-g");
  assert.equal(shared.reason, "meme_telephone");
  assert.equal(result.kept.find((row) => row.id === shared.keptId).name, "Autre Nom");
  const many = result.kept.find((row) => row.id === "ov-e");
  assert.equal(many.phone, "");
  assert.deepEqual(many.publishedPhones, ["5145550199", "+1 514 555 0199"]);
  assert.ok(many.contradictions.includes("phones"));
  assert.equal(fold("Montréal"), fold("Montreal"));
});

test("un périmètre hors des trois cercles, une release libre ou une fiche hors ville est refusé", () => {
  assert.throws(() => ingestSnapshot(snapshot([place("x", "Tokyo Sushi", "Tokyo")], ["Tokyo"])), /perimetre_refuse/);
  assert.throws(() => ingestSnapshot(snapshot([], ["monde"])), /perimetre_refuse/);
  assert.throws(() => ingestSnapshot({ ...snapshot([]), release: "latest" }), /release_non_figee/);
  assert.throws(() => ingestSnapshot({ ...snapshot([]), scope: { cities: ["Montréal"], radiusM: 5000 } }), /perimetre_refuse/);
  const outside = ingestSnapshot(snapshot([
    place("loin", "Casa", "Montréal", { coordinates: [-71.208, 46.8139] }),
    place("vide", "", "Montréal"),
    place("ferme", "Ancien", "Montréal", { status: "closed" }),
    place("zero", "Incertain", "Montréal", { confidence: 0 })
  ], ["Montréal", "Laval", "Québec"]));
  assert.deepEqual(outside.rejected.map((item) => item.reason), ["hors_cercle", "nom_absent", "ferme_declare", "confiance_nulle"]);
  assert.equal(outside.kept.length, 0);
  assert.equal(outside.operational, false);
  const local = ingestSnapshot({ ...snapshot([place("ov-1", "Café Laval", "Laval", { coordinates: [-73.7124, 45.6066] })], ["Laval"]), kind: "local-snapshot" });
  assert.equal(local.coverage, "local-snapshot");
  assert.equal(local.operational, false);
  assert.equal(local.kept[0].city, "Laval");
});

test("un fichier local de fixture est lu, un URL ne l'est pas", async () => {
  const directory = await mkdtemp(join(tmpdir(), "klir-catalog-"));
  try {
    const file = join(directory, "instantane.json");
    const body = snapshot([place("ov-1", "Café de l'Île", "Montréal")]);
    await writeFile(file, JSON.stringify(body));
    const loaded = await readLocalSnapshot(file);
    const result = ingestSnapshot(loaded);
    assert.equal(result.coverage, "fixture");
    assert.equal(result.kept[0].name, "Café de l'Île");
    await assert.rejects(readLocalSnapshot("http://127.0.0.1/places.geojson"), /reseau_refuse/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
