import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

const source = await readFile(new URL("../src/security.js", import.meta.url), "utf8");
const context = { window: {}, URL, crypto: webcrypto };
vm.runInNewContext(source, context);
const security = context.window.KlirSecurity;

test("neutralise les charges HTML et les attributs", () => {
  const value = security.text('"><img src=x onerror=alert(1)>');
  assert.equal(value.includes("<"), false);
  assert.equal(value.includes('"'), false);
});

test("neutralise les formules CSV", () => {
  for (const value of ["=2+2", "+cmd", "-10+1", "@SUM(A1:A2)", "\tformula", "  =2+2", " \t@cmd"]) {
    assert.match(security.csvCell(value), /^"'|^"'/);
  }
  assert.equal(security.csvCell("normal"), '"normal"');
});

test("lit les champs CSV cites sans decaler les colonnes et refuse les fichiers mal formes", () => {
  const comma=security.csvRows('\uFEFFCompany,City,Phone\r\n"Café, Inc.","Québec","+1 418"\r\n');
  assert.deepEqual(JSON.parse(JSON.stringify(comma)),[['Company','City','Phone'],['Café, Inc.','Québec','+1 418']]);
  const semi=security.csvRows('Company;City;Phone\n"Café; ""Bleu""";Laval;123\n');
  assert.deepEqual(JSON.parse(JSON.stringify(semi[1])),['Café; "Bleu"','Laval','123']);
  assert.equal(security.csvRows('Company,City\n"ligne\nmultiligne",Laval')[1][0],'ligne\nmultiligne');
  assert.throws(()=>security.csvRows('Company,City\n"non ferme,Laval'),/CSV invalide/);
  assert.throws(()=>security.csvRows('Company,City\nNom,Québec,123'),/CSV invalide/);
});

test("l’import associe la ville et le telephone au bon candidat et refuse une ligne incomplete", async () => {
  const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
  const sandbox = {window:{KlirSecurity:security},KS:{S:{prospects:[],weights:{}},uid:()=>"fixture"},
    E:{fingerprint:p=>p.company_name,normDomain:()=>"",scoreProspect:()=>({})},KlirData:{CITIES:{default:{}}}};
  vm.createContext(sandbox);
  vm.runInContext(app.slice(app.indexOf("function importCsvText("),app.indexOf("function drawCharts(")),sandbox);
  const result=sandbox.importCsvText('Company,City,Phone\n"Café, Inc.",Québec,4181234567');
  assert.equal(result.rows[0].company_name,'Café, Inc.');
  assert.equal(result.rows[0].city,'Québec');
  assert.equal(result.rows[0].phone,'4181234567');
  assert.match(sandbox.importCsvText('Company,City,Phone\nCafé,Québec').err,/CSV invalide/);
});

test("refuse les destinations privées et ambiguës", () => {
  for (const value of ["localhost", "127.0.0.1", "10.0.0.1", "[::1]", "intranet.local", "https://user:pass@example.com"]) {
    assert.equal(security.domain(value), "");
  }
  assert.equal(security.domain("https://www.example.com/path"), "www.example.com");
});

test("échappe le HTML et ne réécrit pas un nom légitime", () => {
  assert.equal(security.html("Boulangerie Au Pain Doré"), "Boulangerie Au Pain Doré");
  assert.equal(security.html("Montréal"), "Montréal");
  assert.equal(security.html("Schwartz's"), "Schwartz&#39;s");
  assert.equal(security.html('<img src=x onerror=alert(1)>').includes("<"), false);
  assert.equal(security.html('"><img src=x>').includes('"'), false);
  const kept = security.publishValue({ company_name: "Schwartz's", city: "Montréal" });
  assert.equal(kept.company_name, "Schwartz's");
  assert.equal(kept.city, "Montréal");
  const hostile = security.publishValue({ company_name: "<img src=x onerror=alert(1)>" });
  assert.equal(hostile.company_name.includes("<"), false);
  assert.equal(hostile.company_name.includes(">"), false);
});

test("retire récursivement secrets et jetons", () => {
  const clean = security.cleanState({
    password: "secret",
    token: "secret",
    nested: { apiKey: "secret", company: "<b>ACME</b>" }
  });
  assert.equal("password" in clean, false);
  assert.equal("token" in clean, false);
  assert.equal("apiKey" in clean.nested, false);
  assert.equal(clean.nested.company.includes("<"), false);
});
