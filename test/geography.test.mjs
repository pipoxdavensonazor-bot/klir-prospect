import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const sandbox = { console, window: {} };
sandbox.window = sandbox;
vm.createContext(sandbox);
vm.runInContext(await readFile(new URL("../src/data.js", import.meta.url), "utf8"), sandbox);
vm.runInContext(await readFile(new URL("../src/engine.js", import.meta.url), "utf8"), sandbox);
const engine = sandbox.KlirEngine;
const data = sandbox.KlirData;

function ring(bounds) {
  return [
    [bounds.west, bounds.south],
    [bounds.east, bounds.south],
    [bounds.east, bounds.north],
    [bounds.west, bounds.north],
    [bounds.west, bounds.south]
  ];
}

test("les six villes gardent un pays ISO, un centre valide et le rayon publié", () => {
  assert.equal(data.SECTOR_TAXONOMY.version, "sectors-2026-11");
  for (const key of data.SUPPORTED_CITY_KEYS) {
    const city = data.CITIES[key];
    const scope = engine.validateSearchScope({ lat: city.lat, lng: city.lng, radiusM: 2200 });
    assert.equal(scope.ok, true, key);
    assert.equal(["CA", "FR"].includes(city.countryCode), true, key);
    assert.equal(city.locality, city.city);
  }
  const island = engine.validateSearchScope({ polygon: ring(data.SEARCH_SCOPE.montrealIsland) });
  assert.equal(island.ok, true);
  assert.equal(engine.validateSearchScope({ lat: 91, lng: 2 }).errors.join(","), "latitude");
  assert.equal(engine.validateSearchScope({ lat: 45, lng: 200 }).errors.join(","), "longitude");
  assert.equal(engine.validateSearchScope({ lat: 45.5, lng: -73.5, radiusM: 0 }).ok, false);
  assert.equal(engine.validateSearchScope({ lat: 45.5, lng: -73.5, radiusM: -5 }).ok, false);
  assert.equal(engine.validateSearchScope({ lat: 45.5, lng: -73.5, radiusM: 9000 }).ok, false);
  const open = [[-73.9, 45.4], [-73.5, 45.4], [-73.5, 45.7]];
  assert.equal(engine.validateSearchScope({ polygon: open }).ok, false);
  const broken = ring(data.SEARCH_SCOPE.montrealIsland);
  broken[2] = [broken[2][0], 95];
  assert.equal(engine.validateSearchScope({ polygon: broken }).ok, false);
});

test("les homonymes de pays et les périmètres trop larges ne choisissent pas une ville", () => {
  const france = engine.parseQuery("10 restaurants à Paris, France");
  assert.equal(france.cityKey, "paris");
  assert.equal(france.city.countryCode, "FR");
  assert.equal(france.city.lat, 48.8566);

  const united = engine.parseQuery("10 restaurants à Paris, États-Unis");
  assert.equal(united.city, null);
  assert.notEqual(united.place.status, "supported");
  assert.match(united.place.message, /États-Unis|Paris/);

  const province = engine.parseQuery("entreprises dans la province de Québec");
  assert.equal(province.city, null);
  assert.equal(province.place.status, "unsupported");
  assert.match(province.place.message, /pas été recherché/);

  const country = engine.parseQuery("entreprises en France");
  assert.equal(country.city, null);
  assert.notEqual(country.cityKey, "paris");
  const canada = engine.parseQuery("entreprises au Canada");
  assert.equal(canada.city, null);
  assert.notEqual(canada.cityKey, "montréal");

  const accent = engine.parseQuery("10 restaurants à Montréal");
  const plain = engine.parseQuery("10 restaurants in Montreal");
  assert.equal(accent.city.countryCode, "CA");
  assert.equal(plain.cityKey, accent.cityKey);
  const paulo = engine.parseQuery("10 restaurants à São Paulo");
  assert.equal(paulo.place.display, "São Paulo");
  assert.equal(paulo.city, null);
  const tokyo = engine.parseQuery("10 restaurants à 東京");
  assert.equal(tokyo.place.display, "東京");
});

test("un critère indisponible reste inconnu et le géocodeur sans licence ne cherche pas", async () => {
  const asked = engine.parseQuery("10 restaurants à Montréal, chiffre d'affaires et effectif exact");
  assert.equal(asked.cityKey, "montréal");
  assert.equal(asked.size, null);
  assert.equal(Array.from(asked.unknownCriteria).join("|"), "chiffre d'affaires|effectif");
  assert.match(engine.describePlace(asked), /laissés inconnus/);
  assert.match(engine.describePlace(asked), /n'est pas branché/);

  let calls = 0;
  const mock = { async lookup() { calls += 1; return [{ id: "a" }, { id: "b" }]; } };
  const off = engine.createGeocoder({ provider: mock, enabled: true });
  const blocked = await off.lookup("Georgia");
  assert.equal(blocked.status, "disabled");
  assert.equal(calls, 0);

  const on = engine.createGeocoder({ provider: mock, enabled: true, licenseAccepted: true });
  const first = await on.lookup("Georgia");
  const second = await on.lookup("Georgia");
  assert.equal(first.status, "ambiguous");
  assert.equal(first.matches.length, 2);
  assert.equal(second.cached, true);
  assert.equal(calls, 1);

  const config = engine.readGeocoderConfig({
    SEARCH_GEOCODER_PROVIDER: "acme",
    SEARCH_GEOCODER_API_KEY: "secret-should-not-leak"
  });
  assert.equal(config.enabled, false);
  assert.equal(config.provider, "acme");
  assert.equal(JSON.stringify(config).includes("secret"), false);
  assert.match(config.reason, /licence/);
});
