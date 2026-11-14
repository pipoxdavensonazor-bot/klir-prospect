import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const data = await readFile(new URL("../src/data.js", import.meta.url), "utf8");
const engine = await readFile(new URL("../src/engine.js", import.meta.url), "utf8");

function render(overture) {
  const sandbox = {
    console,
    App: { innerHTML: "" },
    document: { getElementById: () => null },
    window: {},
    authState: { user: null },
    esc: (value) => String(value ?? ""),
    KS: { S: { prefill: "", usage: { searches: 0 }, plan: "Free" } }
  };
  sandbox.window = sandbox;
  sandbox.KlirStore = { LIMITS: { Free: { searches: 10 } } };
  sandbox.KlirAuth = { overturePreview: () => overture };
  vm.createContext(sandbox);
  vm.runInContext(data, sandbox);
  vm.runInContext(engine, sandbox);
  sandbox.E = sandbox.KlirEngine;
  vm.runInContext(app.slice(app.indexOf("function vLanding"), app.indexOf("function searchFilters")), sandbox);
  sandbox.vLanding();
  return { landing: sandbox.App.innerHTML, search: sandbox.vNew(), quote: sandbox };
}

test("la prévisualisation Overture n'affiche pas le parcours OpenStreetMap public", () => {
  const { landing, search } = render(true);
  assert.match(landing, /catalogue Overture 2026-10-21\.0/);
  assert.match(landing, /pas une couverture mondiale/);
  assert.match(landing, /plus de plafond mensuel/);
  assert.match(landing, /30 recherches par heure et 200 par jour/);
  assert.equal(landing.includes("recherchez des entreprises dans OpenStreetMap"), false);
  assert.match(search, /id="aCity"/);
  assert.match(search, /value="montréal"/);
  assert.match(search, /value="laval"/);
  assert.match(search, /value="québec"/);
  assert.equal(search.includes("toronto"), false);
  assert.equal(search.includes("paris"), false);
  assert.equal(search.includes("lyon"), false);
  assert.equal(search.includes("montreal_island"), false);
  assert.equal(search.includes("data-webf"), false);
  assert.match(search, /Pas la ville entière/);
});

test("le site sans catalogue Overture continue de décrire OpenStreetMap", () => {
  const { landing, search } = render(false);
  assert.match(landing, /dans OpenStreetMap/);
  assert.equal(landing.includes("catalogue Overture"), false);
  assert.match(search, /OpenStreetMap/);
  assert.match(search, /toronto/);
  assert.match(search, /paris/);
  assert.match(search, /lyon/);
  assert.match(search, /montreal_island/);
});

test("le récapitulatif Overture reprend le cercle, la source et les limites d’usage", () => {
  const { quote } = render(true);
  const fields = {
    qInput: { value: "10 restaurants à Montréal" },
    aInd: { value: "restauration" },
    aCity: { value: "montréal" },
    aQty: { value: "10" },
    aSize: { value: "" },
    aArea: { value: "radius" },
    searchPrice: { textContent: "" },
    searchSummary: { textContent: "" }
  };
  quote.document.getElementById = (id) => fields[id] || null;
  quote.updateSearchQuote();
  assert.match(fields.searchSummary.textContent, /Montréal/);
  assert.match(fields.searchSummary.textContent, /cercle de 2,2 km/);
  assert.match(fields.searchSummary.textContent, /Overture 2026-10-21\.0/);
  assert.match(fields.searchSummary.textContent, /pas une couverture mondiale/);
  assert.match(fields.searchSummary.textContent, /Pas de plafond mensuel/);
  assert.doesNotMatch(fields.searchSummary.textContent, /10 recherches/);
  assert.equal(fields.searchPrice.textContent, "6");
});

test("l'offre de prévisualisation ne présente pas 49 $ CA comme le prix de vente", () => {
  const offer = app.slice(app.indexOf("function vTrialOffer"), app.indexOf("function bindTrialCheckout"));
  assert.match(offer, /Ce n'est pas le prix de vente/);
  assert.match(offer, /aucun prix commercial n'est retenu/);
  assert.match(offer, /Paiement de démonstration indisponible/);
  assert.match(offer, /ni une couverture mondiale/);
  assert.equal(offer.includes("sk_test_"), false);
  assert.equal(offer.includes("sk_live_"), false);
});
