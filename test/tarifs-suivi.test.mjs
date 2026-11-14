import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const billingSrc = await readFile(new URL("../src/billing.js", import.meta.url), "utf8");
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

function loadBilling() {
  const window = { KlirAuth: { state: () => ({ user: null }) } };
  vm.runInNewContext(billingSrc, { window, location: { hash: "#/tarifs", search: "" }, document: {}, console });
  return window.KlirBilling;
}

test("tarifs : courriels publics publiés (1 crédit par courriel trouvé, remboursé sinon), plus « à venir »", () => {
  const B = loadBilling();
  const html = B.pricingBody();
  const soon = B.TIERS.flatMap((t) => t.soon);
  assert.ok(!soon.some((f) => /Courriels extraits/i.test(f)));
  assert.match(B.TIERS[0].features.join(" | "), /Courriels publics extraits des sites web : 1 crédit par courriel trouvé \(remboursé sinon\)/);
  assert.match(html, /1 crédit par courriel trouvé/);
  assert.doesNotMatch(html, /Courriels extraits des sites publics <span class="pill kp-soon">à venir/);
});

test("tarifs : signaux opportunité web inclus dès Gratuit et sur tous les forfaits", () => {
  const B = loadBilling();
  const [gratuit, starter, pro, equipe] = B.TIERS;
  assert.match(gratuit.features.join(" "), /Signaux opportunité web/);
  assert.match(starter.features.join(" "), /Tout Gratuit, dont les signaux opportunité web/);
  assert.match(pro.features.join(" "), /Tout Starter/);
  assert.match(equipe.features.join(" "), /Tout Pro/);
  assert.ok(!B.TIERS.flatMap((t) => t.soon).some((f) => /signaux/i.test(f)));
});

test("abonnement sans session : formulaire de connexion avec message, retour vers #/abonnement", () => {
  assert.match(app, /if\(page==="abonnement"&&!authState\.user&&!window\.KlirStore\.S\.user\)return nav\("\/login\/abonnement"\);/);
  assert.match(app, /AUTH_RETURN=\{abonnement:\{path:"\/abonnement",note:"Connectez-vous pour gérer votre abonnement\."\}\}/);
  assert.match(app, /return vAuth\(page,arg\)/);
  assert.match(app, /nav\(back\?back\.path:"\/dashboard"\)/);
  // La redirection vers la connexion passe avant la redirection générale vers l'accueil.
  assert.ok(app.indexOf('nav("/login/abonnement")') < app.indexOf('return nav("/landing");'));
});
