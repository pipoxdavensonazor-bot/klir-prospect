import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

async function loadStore() {
  const session = new Map();
  const sandbox = {
    sessionStorage: {
      getItem: (key) => session.has(key) ? session.get(key) : null,
      setItem: (key, value) => session.set(key, String(value)),
      removeItem: (key) => session.delete(key),
      clear: () => session.clear()
    },
    structuredClone,
    Blob,
    crypto,
    console,
    Date,
    URL,
    setTimeout,
    clearTimeout,
    Promise
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(await readFile(new URL("../src/security.js", import.meta.url), "utf8"), sandbox);
  vm.runInContext(await readFile(new URL("../src/store.js", import.meta.url), "utf8"), sandbox);
  return { store: sandbox.KlirStore, sandbox };
}

test("le drapeau démo local ne devient pas live sans session serveur", async () => {
  const { store } = await loadStore();
  store.S = { demo: false, user: { email: "demo@local.invalid" } };
  assert.equal(store.S.demo, true);
  store.save();
  assert.equal(store.S.demo, true);
});

test("une session de compte envoie les recherches au stockage du compte", async () => {
  const { store, sandbox } = await loadStore();
  const calls = [];
  sandbox.KlirAuth = {
    persistWorkspace(payload) {
      calls.push(payload);
      return Promise.resolve({ data: { updated_at: new Date().toISOString() }, error: null });
    }
  };
  store.setTrustedLive(true);
  store.S.user = { email: "ada@example.com", id: "11111111-1111-1111-1111-111111111111" };
  store.S.searches = [{ id: "s1", label: "Rénovation Montréal", total: 10 }];
  store.S.prospects = [{ id: "p1", company_name: "Nord Rénovation", searchId: "s1" }];
  store.save();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].searches[0].label, "Rénovation Montréal");
  assert.equal(calls[0].prospects[0].company_name, "Nord Rénovation");
  assert.equal(calls[0].demo, false);
});

test("le mode démo n'envoie pas les recherches vers un compte", async () => {
  const { store, sandbox } = await loadStore();
  const calls = [];
  sandbox.KlirAuth = {
    persistWorkspace(payload) {
      calls.push(payload);
      return Promise.resolve({ data: {}, error: null });
    }
  };
  store.S.searches = [{ id: "s1", label: "Démo locale" }];
  store.save();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(store.S.demo, true);
  assert.equal(calls.length, 0);
});

test("une erreur réseau conserve la recherche et permet de réessayer", async () => {
  const { store, sandbox } = await loadStore();
  let attempts = 0;
  sandbox.KlirAuth = {
    persistWorkspace() {
      attempts += 1;
      return Promise.resolve({ data: null, error: { message: "réseau indisponible" } });
    }
  };
  store.setTrustedLive(true);
  store.S.user = { email: "ada@example.com", id: "11111111-1111-1111-1111-111111111111" };
  store.S.searches = [{ id: "s1", query: "rénovation Montréal", label: "Rénovation Montréal", status: "terminée", total: 10 }];
  const failed = await store.flushCloudPersist();
  assert.equal(failed.error.message, "réseau indisponible");
  assert.equal(store.S.searches[0].id, "s1");
  assert.equal(store.cloudSyncState().status, "error");
  assert.equal(store.pendingOutbox("11111111-1111-1111-1111-111111111111").searches[0].query, "rénovation Montréal");
  store.logoutUser();
  assert.equal(store.S.searches.length, 0);
  assert.equal(store.pendingOutbox("11111111-1111-1111-1111-111111111111").searches[0].id, "s1");
  assert.equal(attempts, 1);
});

test("une suppression retire la recherche envoyée au compte", async () => {
  const { store, sandbox } = await loadStore();
  const calls = [];
  sandbox.KlirAuth = {
    persistWorkspace(payload) {
      calls.push(payload);
      return Promise.resolve({ data: { updated_at: "2026-10-09T00:00:00.000Z" }, error: null });
    }
  };
  store.setTrustedLive(true);
  store.S.user = { id: "11111111-1111-1111-1111-111111111111", email: "ada@example.com" };
  store.S.searches = [{ id: "s1", label: "À garder" }, { id: "s2", label: "À supprimer" }];
  store.S.prospects = [{ id: "p1", searchId: "s1" }, { id: "p2", searchId: "s2" }];
  store.removeSearch("s2");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(store.S.searches.length, 1);
  assert.equal(store.S.searches[0].id, "s1");
  assert.equal(store.S.prospects.length, 1);
  assert.equal(calls.at(-1).searches.length, 1);
  assert.equal(calls.at(-1).prospects[0].searchId, "s1");
});

test("une session migrée peut quitter le mode démo, puis la déconnexion le rétablit", async () => {
  const { store } = await loadStore();
  store.setTrustedLive(true);
  store.save();
  assert.equal(store.S.demo, false);
  store.logoutUser();
  assert.equal(store.S.demo, true);
  store.startDemo();
  assert.equal(store.S.demo, true);
  assert.equal(store.S.user.email, "demo@local.invalid");
});
