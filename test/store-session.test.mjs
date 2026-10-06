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
    URL
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(await readFile(new URL("../src/security.js", import.meta.url), "utf8"), sandbox);
  vm.runInContext(await readFile(new URL("../src/store.js", import.meta.url), "utf8"), sandbox);
  return sandbox.KlirStore;
}

test("le drapeau démo local ne devient pas live sans session serveur", async () => {
  const store = await loadStore();
  store.S = { demo: false, user: { email: "demo@local.invalid" } };
  assert.equal(store.S.demo, true);
  store.save();
  assert.equal(store.S.demo, true);
});

test("une session migrée peut quitter le mode démo, puis la déconnexion le rétablit", async () => {
  const store = await loadStore();
  store.setTrustedLive(true);
  store.save();
  assert.equal(store.S.demo, false);
  store.logoutUser();
  assert.equal(store.S.demo, true);
  store.startDemo();
  assert.equal(store.S.demo, true);
  assert.equal(store.S.user.email, "demo@local.invalid");
});
