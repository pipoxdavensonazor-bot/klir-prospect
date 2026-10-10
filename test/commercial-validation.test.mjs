import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

async function loadEngine() {
  const sandbox = { console };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(await readFile(new URL("../src/data.js", import.meta.url), "utf8"), sandbox);
  vm.runInContext(await readFile(new URL("../src/engine.js", import.meta.url), "utf8"), sandbox);
  return sandbox.KlirEngine;
}

async function loadHelpers() {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const security = await readFile(new URL("../src/security.js", import.meta.url), "utf8");
  const opportunity = await readFile(new URL("../src/opportunity.js", import.meta.url), "utf8");
  const helpers = app.slice(app.indexOf("function sizeLabel"), app.indexOf("function spendCredits"));
  const sandbox = { Date, console, crypto: webcrypto };
  sandbox.window = sandbox;
  sandbox.KlirStore = { S: { searches: [], prospects: [] } };
  vm.createContext(sandbox);
  vm.runInContext(security, sandbox);
  vm.runInContext(opportunity, sandbox);
  vm.runInContext(helpers, sandbox);
  sandbox.KlirSecurity = sandbox.window.KlirSecurity;
  sandbox.OppEngine = sandbox.window.OppEngine;
  return { sandbox, app };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell.length || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function fiche(i) {
  return {
    id: "p" + i,
    searchId: "s1",
    status: "Active",
    company_name: i === 0 ? '=HYPERLINK("http://evil.test")' : (i === 7 ? 'Café "Nord", Montréal' : `Réno ${i} & Fils`),
    industry: "Construction / Rénovation",
    website: i % 3 === 0 ? "" : "https://exemple.ca",
    phone: i % 2 === 0 ? "" : "+1 514 555-0100",
    public_email: i % 4 === 0 ? "" : "contact@exemple.ca",
    address: i % 5 === 0 ? "" : `${i}, rue Saint-Denis\nMontréal`,
    city: "Montréal",
    province: "QC",
    country: "Canada",
    source: "OpenStreetMap",
    collected_at: i % 6 === 0 ? "" : "2026-10-10T15:04:00.000Z",
    opp_signals: [{ signal_name: "construction_fit", evidence: "Profil bâtiment / construction détecté" }],
    opp_score: 70,
    dq: 80,
    rel: 88,
    employee_range: ""
  };
}

test("Montréal et Québec sont reconnus avec ou sans accent", async () => {
  const engine = await loadEngine();
  const cases = [
    ["30 entreprises de rénovation à Montréal", "montréal", "Montréal", 45.5017, -73.5673],
    ["30 entreprises de renovation a Montreal", "montréal", "Montréal", 45.5017, -73.5673],
    ["30 entreprises de construction à Québec", "québec", "Québec", 46.8139, -71.208],
    ["30 entreprises de construction a Quebec", "québec", "Québec", 46.8139, -71.208]
  ];
  for (const [query, key, city, lat, lng] of cases) {
    const params = engine.parseQuery(query);
    assert.equal(params.industry, "construction", query);
    assert.equal(params.cityKey, key, query);
    assert.equal(params.city.city, city, query);
    assert.equal(params.city.lat, lat, query);
    assert.equal(params.city.lng, lng, query);
    assert.equal(params.quantity, 30, query);
    assert.equal(params.size, null, query);
  }
  const unnamed = engine.parseQuery("30 entreprises de rénovation");
  assert.equal(unnamed.cityKey, "default");
  assert.equal(unnamed.city.city, "Montréal");
  const last = engine.parseQuery("entreprises de Montréal vers Québec");
  assert.equal(last.city.city, "Québec");
});

test("une taille absente reste Non renseigné", async () => {
  const { sandbox, app } = await loadHelpers();
  assert.equal(sandbox.sizeLabel(""), "Non renseigné");
  assert.equal(sandbox.sizeLabel(null), "Non renseigné");
  assert.equal(sandbox.sizeLabel("11–50"), "11–50");
  assert.equal(app.includes('params.size||"PME"'), false);
  assert.equal(app.includes("sizeLabel(params.size)"), true);
  assert.equal(app.includes('<option value="" selected>Non renseigné</option>'), true);
});

test("les exports de 1, 10 et 30 fiches gardent les champs publiés et neutralisent les formules", async () => {
  const { sandbox } = await loadHelpers();
  const displayed = Array.from({ length: 30 }, (_, i) => fiche(i));
  const extra = fiche(99);
  extra.searchId = "s2";
  extra.company_name = "Autre recherche";
  const archived = fiche(98);
  archived.status = "Archived";
  archived.company_name = "Archivée";
  const all = displayed.concat([extra, archived]);
  const picked10 = new Set(displayed.slice(0, 10).map((row) => row.id));
  const picked1 = new Set([displayed[1].id]);

  assert.equal(sandbox.rowsForExport(all, "s1", picked10, false, "s1").length, 30);
  assert.equal(sandbox.rowsForExport(all, "s1", picked10, true, "s1").length, 10);
  assert.equal(sandbox.rowsForExport(all, "s1", picked1, true, "s1").length, 1);
  assert.equal(sandbox.rowsForExport(all, "s1", picked10, true, "s-autre").length, 30);

  for (const count of [1, 10, 30]) {
    const rows = displayed.slice(0, count);
    const csv = sandbox.exportCsvText(rows);
    const parsed = parseCsv(csv);
    assert.equal(parsed.length, count + 1, "lignes CSV " + count);
    assert.equal(parsed[0][24], "Address");
    assert.equal(parsed[0][29], "Collected At");
    assert.equal(parsed[0].includes("Phone"), true);
    assert.equal(parsed[0].includes("Public Email"), true);
    assert.equal(csv.split("\n").length, count + 1);
    for (const line of csv.split("\n").slice(1)) assert.equal(/^[=+\-@]/.test(line), false);
    parsed.slice(1).forEach((record, index) => {
      const source = rows[index];
      assert.equal(record.length, 32);
      assert.equal(record[22], source.phone && /^[=+\-@\t]/.test(source.phone) ? "'" + source.phone : source.phone);
      assert.equal(record[23], source.public_email);
      assert.equal(record[24], source.address.replace(/\n/g, " "));
      assert.equal(record[25], "Montréal");
      assert.equal(record[29], source.collected_at ? "2026-10-10" : "");
      assert.equal(record[20], "Secteur construction indiqué, pas une découverte");
      assert.equal(record[20].includes("construction_fit"), false);
      assert.equal(record[20].includes("détecté"), false);
      if (source.company_name.startsWith("=")) assert.equal(record[0].startsWith("'="), true);
      else assert.equal(record[0], source.company_name);
    });
    const html = sandbox.exportXlsText(rows);
    assert.equal(html.split("<tr>").length - 1, count + 1);
    assert.equal(html.includes("Collected At"), true);
    assert.equal(html.includes("Address"), true);
    assert.equal(html.includes("<script"), false);
    assert.equal(html.includes("'=HYPERLINK"), count > 0);
    assert.equal(html.includes("construction_fit"), false);
  }
});

test("un secteur demandé n'est pas présenté comme une découverte et l'historique reste intact", async () => {
  const { sandbox } = await loadHelpers();
  const fresh = {
    id: "n1",
    company_name: "Atelier",
    industry: "Construction / Rénovation",
    industry_key: "construction",
    description: "builder — Montréal",
    city: "Montréal",
    dq: 80,
    conf: 70,
    signals: ["Source ouverte"],
    phone: "",
    public_email: "",
    website: "",
    domain: "",
    employee_range: "",
    social_links: {}
  };
  sandbox.OppEngine.attach(fresh, { industry: "construction", city: { city: "Montréal" } });
  const fit = fresh.opp_signals.find((item) => item.signal_name === "construction_fit");
  assert.ok(fit);
  assert.equal(fit.weight, 15);
  assert.equal(fit.evidence.includes("découverte indépendante"), true);
  assert.equal(fit.evidence.includes("détecté"), false);
  assert.equal(fresh.opp_why.includes("pas des faits vérifiés"), true);
  assert.equal(fresh.opp_why.includes("profil détecté"), false);
  assert.equal(fresh.opp_why.includes("signaux publics détectés"), false);
  const html = sandbox.OppEngine.drawerHTML(fresh);
  assert.equal(html.includes("Secteur construction indiqué, pas une découverte"), true);
  assert.equal(html.includes("construction_fit"), false);
  assert.equal(html.includes("Profil bâtiment / construction détecté"), false);

  const named = {
    id: "n2",
    company_name: "Toiture du Plateau",
    industry: "Services",
    industry_key: "services",
    description: "réparation",
    city: "Québec",
    dq: 80,
    conf: 70,
    signals: ["Source ouverte"],
    phone: "",
    public_email: "",
    website: "",
    social_links: {}
  };
  sandbox.OppEngine.attach(named, { industry: "all", city: { city: "Québec" } });
  const mentioned = named.opp_signals.find((item) => item.signal_name === "construction_fit");
  assert.ok(mentioned);
  assert.equal(mentioned.evidence.includes("description publiée"), true);
  assert.equal(mentioned.evidence.includes("événement commercial confirmé"), true);
  assert.equal(mentioned.evidence.includes("détecté"), false);

  const historical = {
    id: "old",
    opp_version: sandbox.OppEngine.version,
    company_name: "Ancienne fiche",
    opp_why: "Correspondance élevée avec le profil détecté.",
    opp_signals: [{ signal_name: "construction_fit", evidence: "Profil bâtiment / construction détecté" }]
  };
  const before = JSON.stringify(historical);
  sandbox.OppEngine.ensure(historical);
  assert.equal(JSON.stringify(historical), before);
  assert.equal(sandbox.OppEngine.version, "opportunity_engine_v1");
});

test("la recherche et les crédits restent ordonnés quand la couverture OSM change", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const sources = await readFile(new URL("../src/sources.js", import.meta.url), "utf8");
  const search = app.slice(app.indexOf("async function runSearch"), app.indexOf("function toCrm"));
  assert.equal(search.includes("KlirSources.osm.search"), true);
  assert.equal(search.includes("genProspects"), false);
  assert.ok(search.indexOf("Recherche échouée") < search.indexOf("spendCredits(searchCost"));
  assert.ok(search.indexOf("Recherche partielle, aucun résultat reçu") < search.indexOf("spendCredits(searchCost"));
  assert.ok(search.indexOf("Recherche terminée, aucun résultat") < search.indexOf("spendCredits(searchCost"));
  assert.equal(search.includes('if(!partial&&!spendCredits(searchCost,"Recherche"))return;'), true);
  assert.equal(search.includes("5+Math.ceil(_costQ/10)"), true);
  assert.equal(search.includes("selExplicit=false"), true);
  const exporters = app.slice(app.indexOf("function exportRows"), app.indexOf("function createCamp"));
  assert.equal(exporters.includes("spendCredits"), false);
  assert.equal(sources.includes('["office"="construction_company"]'), true);
  assert.equal(sources.includes("(around:\" + radius + \",\" + lat + \",\" + lng + \")"), true);
  assert.equal(sources.includes("last_verified: new Date()"), true);
  assert.equal(sources.includes('["shop"="trade"]'), false);
  assert.equal(sources.includes('["office"="company"]'), false);
});
