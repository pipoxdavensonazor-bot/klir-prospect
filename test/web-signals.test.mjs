import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const webintel = await readFile(new URL("../src/webintel.js", import.meta.url), "utf8");
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const serverJobs = await readFile(new URL("../src/server-jobs.js", import.meta.url), "utf8");

function load() {
  const sandbox = { console, Date, setTimeout, fetch: () => { throw new Error("aucun_reseau"); } };
  sandbox.window = sandbox;
  sandbox.KlirStore = { S: { prospects: [], webintel: null }, save() {} };
  vm.createContext(sandbox);
  vm.runInContext(webintel, sandbox);
  return sandbox.WebIntel;
}

test("signaux web : sans site, réseau social seulement, HTTP, sans téléphone", () => {
  const W = load();
  const codes = (p) => W.webSignals({ web_fields_known: true, ...p }).signals.map((s) => s.code).slice();
  const plain = (a) => JSON.parse(JSON.stringify(a));
  assert.deepEqual(plain(codes({ website: "", phone: "" })), ["no_website", "no_phone"]);
  assert.equal(W.webSignals({ web_fields_known: true, website: "", phone: "" }).score, 80);
  assert.deepEqual(plain(codes({ website: "https://www.facebook.com/chez.lea", phone: "514" })), ["social_only"]);
  assert.deepEqual(plain(codes({ website: "https://instagram.com/x", phone: "1" })), ["social_only"]);
  assert.deepEqual(plain(codes({ website: "https://m.facebook.com/x", phone: "1" })), ["social_only"]);
  assert.deepEqual(plain(codes({ website: "https://notfacebook.com/x", phone: "1" })), []);
  assert.deepEqual(plain(codes({ website: "http://exemple.ca", phone: "1" })), ["no_https"]);
  assert.deepEqual(plain(codes({ website: "https://exemple.ca", phone: "" })), ["no_phone"]);
  const ok = W.webSignals({ web_fields_known: true, website: "https://exemple.ca", phone: "1" });
  assert.equal(ok.score, 0);
  assert.equal(ok.web, false);
  assert.equal(W.webSignals({ web_fields_known: true, website: "https://exemple.ca", phone: "" }).web, false);
  assert.equal(W.webSignals({ web_fields_known: true, website: "", phone: "1" }).web, true);
});

test("fiche ancienne sans champs lus : aucun signal ni badge, pas de faux « sans site »", () => {
  const W = load();
  const r = W.webSignals({ website: "", phone: "" });
  assert.equal(r.known, false);
  assert.equal(r.score, null);
  assert.equal(W.webBadges({ website: "" }), "");
});

test("les badges échappent le texte et affichent le score", () => {
  const W = load();
  const html = W.webBadges({ web_fields_known: true, website: "", phone: "" });
  assert.match(html, /Sans site web/);
  assert.match(html, /Pas de téléphone/);
  assert.match(html, /Score web 80\/100/);
  assert.match(W.webBadges({ web_fields_known: true, website: "https://a.ca", phone: "1" }), /Présence web publiée/);
});

test("le site lit site/téléphone, filtre « Opportunités web seulement » et exporte les signaux", () => {
  assert.match(serverJobs, /website, phone, contact_fields/);
  assert.match(app, /web_fields_known:row&&row\.contact_fields===true/);
  assert.match(app, /id="webOppOnly"/);
  assert.match(app, /Opportunités web seulement/);
  assert.match(app, /Web Signals,Web Opportunity Score/);
  assert.match(app, /data-webopp=/);
});

test("lots de contacts : premier site http(s), premier téléphone, échappement SQL, lieu du catalogue requis", async () => {
  const { contactRows, contactBatchSql, firstWebsite } = await import("../tools/catalog-contacts-sql.mjs");
  assert.equal(firstWebsite(["javascript:alert(1)", "https://a.ca"]), "https://a.ca");
  const rows = contactRows({ cities: [{ key: "laval", features: [
    { id: "a", properties: { websites: ["https://l'apostrophe.ca"], phones: ["+1 450"] } },
    { id: "b", properties: {} },
    { id: "c", properties: { phones: ["514"] } }
  ] }] });
  assert.equal(rows.length, 2);
  const sql = contactBatchSql(rows);
  assert.match(sql, /l''apostrophe/);
  assert.match(sql, /join private\.search_catalog_places p/);
  assert.match(sql, /on conflict \(city_key, id\) do nothing/);
});
