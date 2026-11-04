import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('une fiche sans site publié ne devient pas une preuve de besoin de création', async () => {
  const sandbox = { KlirStore: { S: {} }, KlirSecurity: { domain: () => '' }, addEventListener() {} };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  for (const file of ['webintel.js', 'webai.js']) {
    vm.runInContext(await readFile(new URL('../src/' + file, import.meta.url), 'utf8'), sandbox);
  }
  const prospect = { website: '', domain: '', signals: [] };
  const recommendation = sandbox.WebAI.recommend(prospect);
  assert.equal(recommendation.action, 'ANALYZE');
  assert.match(recommendation.why, /aucune absence de site établie/);
  const html = sandbox.WebIntel.drawerHTML(prospect);
  assert.match(html, /aucun domaine renseigné/);
  assert.doesNotMatch(html, /Le domaine semble enregistré/);
});

test('un site actif sans courriel ou signaux demande une analyse, jamais REBUILD', async () => {
  const sandbox = { KlirStore: { S: {} }, addEventListener() {} };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(await readFile(new URL('../src/webai.js', import.meta.url), 'utf8'), sandbox);
  for (const fields of [
    { public_email: '', signals: ['Information publiée'], website_https: true },
    { public_email: 'contact@example.org', signals: [], website_https: true },
    { public_email: '', signals: [], website_https: false },
    { public_email: '', signals: [], webAudit: { overall: 10, limited: true } },
    { public_email: '', signals: [], webAudit: { overall: 10 } }
  ]) {
    assert.equal(sandbox.WebAI.recommend({ domain_name: 'example.org', website_status: 'ACTIVE', ...fields }).action, 'ANALYZE');
  }
  assert.equal(sandbox.WebAI.recommend({ domain_name: 'example.org', website_status: 'ACTIVE', webAudit: { overall: 10, limited: false } }).action, 'REBUILD');
});

test('le tableau CRM respecte une valeur zéro et les valeurs saisies sans deal', async () => {
  const app = await readFile(new URL('../src/app.js', import.meta.url), 'utf8');
  const sandbox = { KS: { S: { crm: [{ id: 'qa', company_name: 'TEST QA', stage: 'New', value: 0 }], deals: [], prospects: [] } }, esc: String };
  sandbox.window = {};
  vm.createContext(sandbox);
  vm.runInContext(app.slice(app.indexOf('function reviewLabel'), app.indexOf('function sourceDateLabel')), sandbox);
  vm.runInContext(app.slice(app.indexOf('function vCrmLeads'), app.indexOf('function vCrmCompanies')), sandbox);
  assert.doesNotMatch(sandbox.vCrmLeads(), /2[\s, ]?500/);
  assert.match(sandbox.vCrmLeads(), /\$0 potentiel/);
  sandbox.KS.S.crm[0].value = 120;
  assert.match(sandbox.vCrmLeads(), /\$120 potentiel/);
});
