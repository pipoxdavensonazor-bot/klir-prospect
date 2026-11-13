import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const start = app.indexOf("function overtureHeaderFacts(");
const end = app.indexOf("\n}\n", start) + 3;
const overtureHeaderFacts = new Function(`${app.slice(start, end)}; return overtureHeaderFacts;`)();

test("résultats de la file serveur : aucun champ vide, version lue sur les fiches", () => {
  const s = { id: "job_1", jobId: "1", date: "2026-11-13", source: "Overture Maps" };
  const prospects = [{ searchId: "job_1", overture_release: "2026-10-21.0" }, { searchId: "autre", overture_release: "x" }];
  const facts = overtureHeaderFacts(s, prospects);
  assert.deepEqual(facts, ["Source : catalogue Overture (file serveur)", "Version 2026-10-21.0", "Recherche du 2026-11-13"]);
  const line = facts.join(" · ");
  assert.doesNotMatch(line, /révision historique|cache\s*$|Version\s*·|·\s*·/i);
  assert.ok(facts.every((f) => f.trim() && !/[:]\s*$/.test(f)));
});

test("version portée par la recherche prioritaire, champs absents masqués", () => {
  const facts = overtureHeaderFacts({ id: "job_2", jobId: "2", release: "2026-10-21.0" }, []);
  assert.deepEqual(facts, ["Source : catalogue Overture (file serveur)", "Version 2026-10-21.0"]);
  assert.deepEqual(overtureHeaderFacts({ id: "job_3", jobId: "3" }, []), ["Source : catalogue Overture (file serveur)"]);
});

test("ancien pilote navigateur : révision et cache affichés seulement s'ils existent", () => {
  assert.deepEqual(
    overtureHeaderFacts({ id: "s", release: "2026-10-21.0", revision: "r7", cacheAt: "2026-11-01" }, []),
    ["Source : Overture Maps", "Version 2026-10-21.0", "Révision r7", "Cache 2026-11-01"]
  );
});

test("l'en-tête n'écrit plus de gabarit à champs vides", () => {
  assert.doesNotMatch(app, /révision \$\{esc\(s\.revision\|\|"historique"\)\}/);
  assert.match(app, /overtureHeaderFacts\(s,KS\.S\.prospects\)\.map\(esc\)\.join\(" · "\)/);
  assert.match(app, /release:String\(\(places\.find\(r=>r&&r\.release\)\|\|\{\}\)\.release\|\|""\)/);
});
