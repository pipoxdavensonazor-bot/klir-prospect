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

test("valeurs approuvées le 14 nov. 2026 : entrée en vigueur, district, support, conservation", async () => {
  const html = await read("src/confidentialite.html");
  assert.match(html, /En vigueur le 14 novembre 2026/);
  assert.match(html, /90 jours au plus/);
  assert.match(html, /effacées automatiquement après 90 jours/);
  assert.match(html, /Pièces de facturation : 6 ans/);
  assert.doesNotMatch(html, /cycle limité/);
  const billing = await read("src/billing.js");
  assert.match(billing, /En vigueur le 14 novembre 2026/);
  assert.match(billing, /district judiciaire de Montréal/);
  assert.match(billing, /réponse en 1 jour ouvrable/);
  assert.match(billing, /4 h ouvrables pour les clients du pilote/);
});
