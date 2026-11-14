import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL(`../${p}`, import.meta.url), "utf8");

test("gouvernance : page publiée, identité de Klirline Inc. et adoption", async () => {
  const html = await read("src/gouvernance.html");
  assert.match(html, /<h1>Politique de gouvernance des renseignements personnels<\/h1>/);
  assert.match(html, /Klirline Inc\., 4848 rue de Castille, Montréal \(Québec\) H1G 3B7/);
  assert.match(html, /NE 777880576RC0001/);
  assert.match(html, /mailto:contact@klirline\.ca/);
  assert.match(html, /Adoptée par Philippe Davenson Azor, chef de la direction \(CEO\), le 14 novembre 2026/);
  for (const section of ["1. Rôles", "2. Cycle de vie des renseignements", "3. Mesures de sécurité", "4. Demandes des personnes", "5. Plaintes", "6. Projets technologiques", "7. Formation et revue"]) {
    assert.ok(html.includes(`<h2>${section}</h2>`), section);
  }
  assert.match(html, /sauvegardes 90 jours ; pièces de facturation 6 ans/);
  assert.doesNotMatch(html, /COMPLÉTER|\[NOM|\[DATE|à inscrire|<script/i);
});

test("gouvernance : copiée au build, en-têtes et lien depuis la confidentialité", async () => {
  const build = await read("tools/build.mjs");
  assert.ok(build.includes('"../src/gouvernance.html"'));
  assert.match(await read("_headers"), /\/gouvernance\n  Cache-Control: public, max-age=300/);
  assert.match(await read("src/confidentialite.html"), /href="\/gouvernance"/);
});
