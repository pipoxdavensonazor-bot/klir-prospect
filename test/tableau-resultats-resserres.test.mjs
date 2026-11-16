import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("le tableau des résultats porte une classe dédiée et conserve toutes les colonnes", () => {
  assert.match(app, /class="tbl tbl-results"/);
  assert.match(app, /<colgroup>/);
  for (const header of ["Entreprise / Site", "Secteur", "Ville", "Tél pro", "Email pro", "🌐 Website", "🔥 Opportunity", "Data Quality", "Relevance", "Source / Collecte"]) {
    assert.equal(app.includes("<th>" + header + "</th>"), true, "en-tête manquant : " + header);
  }
  assert.match(app, /class="cell-company"/);
  assert.match(app, /class="cell-url"/);
  assert.match(app, /class="cell-compact"/);
  assert.match(app, /class="cell-email"/);
  assert.match(app, /class="cell-web"/);
  assert.match(app, /class="cell-actions"/);
  assert.match(app, /data-view=/);
  assert.match(app, /data-oid2=/);
  assert.match(app, /Trouver le courriel</);
});

test("les autres tableaux ne reçoivent pas la classe tbl-results", () => {
  const other = [...app.matchAll(/class="tbl"/g)];
  assert.ok(other.length >= 1, "d'autres .tbl doivent rester inchangés");
  assert.equal(app.includes('class="tbl tbl-results"'), true);
});

test("la feuille de style resserre le tableau des résultats sans casser le défilement mobile", () => {
  assert.match(css, /\.tbl-results table/);
  assert.match(css, /table-layout:\s*fixed/);
  assert.match(css, /@media \(min-width: 1280px\)/);
  assert.match(css, /\.tbl-results \.cell-url/);
  assert.match(css, /text-overflow:\s*ellipsis/);
  assert.match(css, /\.tbl-results \.cell-compact[^}]*white-space:\s*nowrap/s);
  assert.match(css, /\.tbl-results \.trialReview[^}]*min-width:\s*0/s);
  assert.match(css, /\.tbl, \.kanban, pre \{ overflow-x: auto/);
});
