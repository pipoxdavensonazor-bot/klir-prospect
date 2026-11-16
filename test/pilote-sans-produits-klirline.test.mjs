import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PRODUCT_LABELS = ["KlirBuild", "KlirPromo", "KlirPay", "KlirMarket", "Klir IA", "Klirline OS"];

test("l'interface de résultats ne propose plus le filtre Service ni les produits Klirline", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  assert.equal(app.includes('id="svcFilter"'), false);
  assert.equal(app.includes(">Service Match<"), false);
  assert.equal(app.includes("Top KlirBuild Opportunities"), false);
  assert.equal(app.includes("Top KlirPromo Opportunities"), false);
  assert.equal(app.includes("KlirBuild 70+"), false);
  assert.equal(app.includes("KlirPromo 70+"), false);
  assert.equal(app.includes("window.OppEngine.topHTML"), false);
  for (const label of PRODUCT_LABELS) {
    assert.equal(app.includes(label), false, "app.js encore visible : " + label);
  }
});

test("le tiroir et le tableau de bord n'affichent plus de service Klirline recommandé", async () => {
  const opportunity = await readFile(new URL("../src/opportunity.js", import.meta.url), "utf8");
  assert.equal(opportunity.includes("SERVICE OPPORTUNITIES"), false);
  assert.equal(opportunity.includes("RECOMMENDED SERVICE"), false);
  assert.equal(opportunity.includes('["KlirBuild"'), false);
  assert.equal(opportunity.includes('["KlirPromo"'), false);
});

test("les dossiers projet n'offrent plus les produits Klirline aux utilisateurs", async () => {
  const projects = await readFile(new URL("../src/projects.js", import.meta.url), "utf8");
  for (const label of PRODUCT_LABELS) {
    assert.equal(projects.includes(label), false, "projects.js encore visible : " + label);
  }
  assert.equal(projects.includes("Démo KlirBuild"), false);
  assert.match(projects, /offer:\s*true/);
  assert.match(projects, /function pjOffered/);
});
