// Messages de solde insuffisant cohérents avec la page Tarifs (Starter en vente) : aucune nouvelle fonctionnalité.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const auth = await readFile(new URL("../src/auth.js", import.meta.url), "utf8");

function usageMessage() {
  const start = auth.indexOf("function usageMessage(");
  assert.notEqual(start, -1);
  const src = auth.slice(start, auth.indexOf("\n}\n", start) + 2);
  return vm.runInNewContext(`(${src})`);
}

test("solde insuffisant : renvoie vers Tarifs, ne dit plus que l'achat est fermé", () => {
  const msg = usageMessage();
  const text = msg(new Error("credits_insuffisants"));
  assert.match(text, /Solde de crédits insuffisant/);
  assert.match(text, /#\/tarifs/);
  assert.doesNotMatch(text, /n'est pas ouvert/);
  assert.doesNotMatch(auth + app, /L'achat de crédits n'est pas ouvert/);
});

test("le message « Quota mensuel atteint » n'existe plus (le serveur n'a plus de plafond mensuel)", () => {
  assert.doesNotMatch(auth, /Quota mensuel atteint/);
  assert.doesNotMatch(app, /Quota mensuel atteint/);
  const text = usageMessage()(new Error("quota_mensuel"));
  assert.doesNotMatch(text, /Quota mensuel/);
});

test("la recherche refusée faute de crédits propose un lien vers #/tarifs", () => {
  assert.match(app, /credits_insuffisants:"Solde de crédits insuffisant\. Aucune recherche lancée, aucun crédit débité\."/);
  assert.match(app, /outcome==="credits_insuffisants"\?' <a href="#\/tarifs">Voir les Tarifs<\/a>'/);
  assert.match(app, /const m=\{credits_insuffisants:"Solde de crédits insuffisant\.[^"]*#\/tarifs/);
});

test("#/offre : l'abonnement se prend depuis Tarifs, sans phrase ambiguë", () => {
  const start = app.indexOf("function vOffre(");
  const offre = app.slice(start, app.indexOf("\nfunction ", start + 10));
  assert.doesNotMatch(offre, /aucun paiement n'est ouvert/);
  assert.match(offre, /L'abonnement se prend depuis la page <a href="#\/tarifs">Tarifs<\/a>/);
});
