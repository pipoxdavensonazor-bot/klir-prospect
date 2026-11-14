import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const billingSrc = await readFile(new URL("../src/billing.js", import.meta.url), "utf8");

function loadBilling(hash) {
  const window = { KlirAuth: { state: () => ({ user: null }) } };
  vm.runInNewContext(billingSrc, { window, location: { hash, search: "" }, document: {}, console });
  return window.KlirBilling;
}

test("pilote : la page Tarifs ne propose que Gratuit et Starter", () => {
  const B = loadBilling("#/tarifs");
  assert.deepEqual([...B.PILOT_ON_SALE], ["gratuit", "starter"]);
  for (const interval of ["month", "year"]) {
    B.state.interval = interval;
    const html = B.pricingBody();
    assert.match(html, /Starter/);
    assert.doesNotMatch(html, /2 000 crédits par mois|6 000 crédits par mois/);
    assert.match(html, /Pro et Équipe ne sont pas en vente pendant le pilote/);
  }
  assert.equal(B.TIERS.length, 4, "les forfaits restent définis pour les abonnements existants");
});
