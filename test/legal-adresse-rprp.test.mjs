import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");
const ADDRESS = /4848 rue de Castille, Montréal \(Québec\) H1G 3B7/;

test("confidentialité : adresse de Klirline Inc. et responsable nommé", async () => {
  const html = await read("src/confidentialite.html");
  assert.match(html, ADDRESS);
  assert.match(html, /Philippe Davenson Azor, chef de la direction \(CEO\), Klirline Inc\./);
  assert.doesNotMatch(html, /COMPLÉTER|\[NOM/);
});

test("conditions : l'adresse du vendeur est affichée", async () => {
  assert.match(await read("src/billing.js"), ADDRESS);
  assert.match(await read("docs/conditions-de-vente-brouillon.md"), ADDRESS);
});
