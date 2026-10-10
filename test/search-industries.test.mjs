import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

async function loadEngine() {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(await readFile(new URL("../src/data.js", import.meta.url), "utf8"), sandbox);
  vm.runInContext(await readFile(new URL("../src/engine.js", import.meta.url), "utf8"), sandbox);
  return sandbox.KlirEngine;
}

test("une recherche sans secteur couvre tous les domaines", async () => {
  const engine = await loadEngine();
  const params = engine.parseQuery("Trouve-moi 100 entreprises à Montréal");
  assert.equal(params.industry, "all");
  assert.equal(params.city.city, "Montréal");
  const rows = engine.genProspects(params, 40);
  const keys = new Set(rows.map((row) => row.industry_key));
  assert.equal(keys.size, Object.keys(engine.industryKeys({ industry: "all" })).length);
  assert.equal(keys.has("construction"), true);
  assert.equal(keys.has("sante"), true);
  assert.equal(keys.has("technologie"), true);
  assert.equal(keys.has("restauration"), true);
});

test("un secteur nommé reste ciblé, et une demande explicite rouvre tous les domaines", async () => {
  const engine = await loadEngine();
  const clinic = engine.parseQuery("20 cliniques dentaires à Québec");
  assert.equal(clinic.industry, "sante");
  const only = new Set(engine.genProspects(clinic, 12).map((row) => row.industry_key));
  assert.deepEqual([...only], ["sante"]);

  const broad = engine.parseQuery("100 entreprises de construction à Montréal, tous les domaines");
  assert.equal(broad.industry, "all");
  assert.equal(engine.industryLabel("all"), "Tous les secteurs");
  assert.equal(engine.industryLabel("finance"), "Finance / Assurance");
});
