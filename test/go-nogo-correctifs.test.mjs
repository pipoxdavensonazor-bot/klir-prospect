// Correctifs minimaux du rapport GO/NO-GO (nov. 2026) : aucune nouvelle fonctionnalité.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const build = await readFile(new URL("../tools/build.mjs", import.meta.url), "utf8");
const redirects = await readFile(new URL("../_redirects", import.meta.url), "utf8");

function body(name) {
  const start = app.indexOf("function " + name);
  assert.notEqual(start, -1, name);
  return app.slice(start, app.indexOf("\nfunction ", start + 10));
}

test("les adresses /guide, /tarifs, /offre, /conditions et /demo redirigent vers les routes de l'application", () => {
  for (const [from, to] of [["/guide", "/#/guide"], ["/guide/", "/#/guide"], ["/tarifs", "/#/tarifs"], ["/offre", "/#/offre"], ["/conditions", "/#/conditions"], ["/demo", "/#/demo"]]) {
    const rule = redirects.split("\n").find((line) => line.split(/\s+/)[0] === from);
    assert.ok(rule, from);
    assert.deepEqual(rule.trim().split(/\s+/), [from, to, "302"]);
  }
  assert.match(build, /cp\(new URL\("\.\.\/_redirects", import\.meta\.url\), new URL\("_redirects", out\)\)/);
});

test("le navigateur n'applique plus le plafond de 10 recherches ni de 20 exports par mois", () => {
  const search = app.slice(app.indexOf("async function runSearch"), app.indexOf("\nfunction ", app.indexOf("async function runSearch")));
  assert.doesNotMatch(search, /Quota mensuel atteint/);
  assert.doesNotMatch(search, /KlirStore\.LIMITS/);
  assert.doesNotMatch(body("exportCsv"), /Limite d'exports/);
  assert.doesNotMatch(body("vNew"), /KlirStore\.LIMITS/);
});

test("les pages publiques ne disent plus que le pilote payant est fermé et renvoient aux Tarifs", () => {
  const publicPart = (name) => { const b = body(name); const i = b.indexOf("return;}App.innerHTML="); return i === -1 ? b : b.slice(i); };
  for (const name of ["vLanding", "vGuide", "vOffre"]) {
    const html = publicPart(name);
    assert.doesNotMatch(html, /pilote payant reste fermé|pilote payant n'est pas encore ouvert|L'achat et le pilote payant ne sont pas ouverts/, name);
    assert.doesNotMatch(html, /doivent être publiés par Klirline avant d'accepter un paiement|restent à définir par Klirline/, name);
    assert.doesNotMatch(html, /OpenStreetMap/, name);
    assert.match(html, /#\/tarifs/, name);
  }
});

test("l'export CSV d'une fiche de la file serveur porte l'attribution et la licence Overture", () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(body("exportLicenseValues"), sandbox);
  const row = { source: "Overture Maps", overture_release: "2026-10-21.0", job_id: "x" };
  assert.deepEqual(Array.from(vm.runInContext("exportLicenseValues", sandbox)(row)), [
    "© Overture Maps Foundation et fournisseurs",
    "CDLA-Permissive-2.0 et licences des fournisseurs",
    "https://docs.overturemaps.org/attribution/"
  ]);
  const osm = vm.runInContext("exportLicenseValues", sandbox)({ source: "OpenStreetMap" });
  assert.equal(osm[1], "ODbL 1.0");
});

test("LCAP/CASL : chaque brouillon de message porte l'identification de l'expéditeur et un mécanisme d'exclusion", () => {
  const sandbox = { KS: { S: { org: { name: "Agence Exemple" } } } };
  vm.createContext(sandbox);
  vm.runInContext(body("caslFooter") + "\n" + body("withCaslFooter"), sandbox);
  const out = vm.runInContext("withCaslFooter", sandbox)("Bonjour,\nUn échange de 15 min ?");
  assert.match(out, /Agence Exemple · \[adresse postale\]/);
  assert.match(out, /Répondez « STOP »/);
  assert.equal(vm.runInContext("withCaslFooter", sandbox)(out), out);
  for (const fn of ["genMessages", "genMessagesRadar"]) {
    const start = app.indexOf("async function " + fn);
    const code = app.slice(start, app.indexOf("\nasync function ", start + 10) > 0 ? app.indexOf("\n", app.indexOf("drafts.push", start)) : undefined);
    assert.match(code, /text:withCaslFooter\(/, fn);
  }
});
