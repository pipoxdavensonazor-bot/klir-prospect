import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import vm from "node:vm";

const billingSrc = await readFile(new URL("../src/billing.js", import.meta.url), "utf8");
const doc = await readFile(new URL("../docs/conditions-de-vente-brouillon.md", import.meta.url), "utf8");

function loadBilling(hash) {
  const window = { KlirAuth: { state: () => ({ user: null }) } };
  vm.runInNewContext(billingSrc, { window, location: { hash, search: "" }, document: {}, console });
  return window.KlirBilling;
}

test("conditions : vendeur Klirline Inc., NE 777880576RC0001, aucune taxe (petit fournisseur), adresse à compléter", () => {
  const B = loadBilling("#/conditions");
  const app = { innerHTML: "" };
  B.viewConditions(app);
  assert.match(app.innerHTML, /Version préliminaire/);
  assert.match(app.innerHTML, /Klirline Inc\./);
  assert.match(app.innerHTML, /777880576RC0001/);
  assert.match(app.innerHTML, /Aucune TPS ni TVQ n&#39;est facturée : Klirline Inc\. est un petit fournisseur/);
  assert.match(app.innerHTML, /prix pourront être ajustés pour ajouter les taxes applicables, avec un préavis/);
  assert.match(app.innerHTML, /Pour nous joindre : contact@klirline\.ca/);
  assert.doesNotMatch(app.innerHTML, /COMPLÉTER|[Aa]dresse d&#39;affaires/);
  assert.doesNotMatch(app.innerHTML, /en sus/);
  assert.match(doc, /\*\*Klirline Inc\.\*\*/);
  assert.match(doc, /777880576RC0001/);
  assert.match(doc, /Aucune taxe n'est facturée/);
  assert.match(doc, /petit\s+fournisseur/);
  assert.match(doc, /contact@klirline\.ca/);
  assert.doesNotMatch(doc, /COMPLÉTER|adresse postale|adresse de soutien|Adresse d'affaires/);
  assert.doesNotMatch(doc, /taxes en sus/i);
});

test("tarifs : « Aucune taxe facturée (petit fournisseur) », plus jamais « taxes en sus »", () => {
  const B = loadBilling("#/tarifs");
  for (const interval of ["month", "year"]) {
    B.state.interval = interval;
    const html = B.pricingBody();
    assert.match(html, /Aucune taxe facturée \(petit fournisseur\)/);
    assert.doesNotMatch(html, /en sus/i);
  }
  assert.doesNotMatch(billingSrc, /taxes en sus|TPS et TVQ en sus/i);
});

test("aucun code de paiement n'active la taxe automatique Stripe", async () => {
  const roots = ["../supabase/functions/", "../src/", "../tools/"];
  for (const root of roots) {
    const files = await readdir(new URL(root, import.meta.url), { recursive: true });
    for (const f of files.filter((x) => /\.(m?js|ts)$/.test(x))) {
      const text = await readFile(new URL(root + f, import.meta.url), "utf8");
      assert.doesNotMatch(text, /automatic_tax[^\n]{0,40}(true|enabled\s*[:=]\s*true)/, root + f);
    }
  }
});
