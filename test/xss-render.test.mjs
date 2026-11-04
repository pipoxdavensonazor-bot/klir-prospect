import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";

const root = new URL("../src/", import.meta.url);
const payload = "<img src=x onerror=alert(1)>";

function decode(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

function parseFragment(html) {
  const rootNode = { tag: "#document", children: [] };
  const stack = [rootNode];
  const voids = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
  let index = 0;
  while (index < html.length) {
    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index);
      index = end < 0 ? html.length : end + 3;
      continue;
    }
    if (html[index] === "<" && /[a-zA-Z/!]/.test(html[index + 1] || "")) {
      const end = html.indexOf(">", index);
      if (end < 0) break;
      const raw = html.slice(index + 1, end);
      index = end + 1;
      if (raw.startsWith("/")) {
        const name = raw.slice(1).trim().toLowerCase().split(/\s/)[0];
        for (let depth = stack.length - 1; depth > 0; depth -= 1) {
          const closed = stack.pop();
          if (closed.tag === name) break;
        }
        continue;
      }
      const self = /\/$/.test(raw.trim());
      const body = self ? raw.trim().slice(0, -1) : raw;
      const name = (body.match(/^([a-zA-Z0-9]+)/) || [])[1];
      if (!name) continue;
      const tag = name.toLowerCase();
      const node = { tag, children: [] };
      stack[stack.length - 1].children.push(node);
      if (!self && !voids.has(tag)) stack.push(node);
      continue;
    }
    const next = html.indexOf("<", index);
    const text = html.slice(index, next < 0 ? html.length : next);
    index = next < 0 ? html.length : next;
    if (text) stack[stack.length - 1].children.push({ tag: "#text", text, children: [] });
  }
  function find(node, selector) {
    if (node.tag === selector) return node;
    for (const child of node.children || []) {
      const found = find(child, selector);
      if (found) return found;
    }
    return null;
  }
  function textOf(node) {
    if (node.tag === "#text") return decode(node.text);
    return (node.children || []).map(textOf).join("");
  }
  rootNode.querySelector = (selector) => find(rootNode, selector);
  rootNode.textContent = textOf(rootNode);
  return rootNode;
}

function assertNoElement(html, label) {
  const view = parseFragment(html);
  assert.equal(view.querySelector("img"), null, label);
  assert.equal(/<img\b/i.test(html), false, label);
  assert.equal(view.textContent.includes("img"), true, label);
  assert.equal(view.textContent.includes("onerror"), true, label);
  return view;
}

const storage = new Map();
const sessionStorage = {
  getItem(key) { return storage.has(key) ? storage.get(key) : null; },
  setItem(key, value) { storage.set(key, String(value)); },
  removeItem(key) { storage.delete(key); }
};
const slots = {};
function element(id) {
  if (!slots[id]) slots[id] = { id, innerHTML: "", textContent: "", value: "", style: {}, className: "", disabled: false, onclick: null };
  return slots[id];
}
const sandbox = {
  console,
  Date,
  Set,
  Map,
  URL,
  Blob,
  Intl,
  structuredClone,
  crypto: webcrypto,
  setTimeout,
  clearTimeout,
  sessionStorage,
  localStorage: sessionStorage,
  location: { hash: "#/landing" },
  alert() {},
  confirm() { return false; },
  fetch() { return Promise.reject(new Error("hors ligne")); },
  addEventListener() {},
  document: {
    getElementById(id) { return element(id); },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
    createElement() { return { click() {}, href: "", download: "" }; }
  }
};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const file of ["security.js", "data.js", "engine.js", "store.js", "app.js"]) {
  vm.runInContext(await readFile(new URL(file, root), "utf8"), sandbox);
}

const hostile = {
  id: "p-hostile",
  company_name: payload,
  city: "Montréal",
  industry: "Services",
  address: "12 rue Principale",
  phone: "",
  public_email: "",
  website: "",
  domain: "",
  source: "OpenStreetMap",
  postal_code: "H2X 1Y4",
  dq: 40,
  rel: 55,
  signals: [payload],
  ai: "Estimation " + payload,
  inCrm: false,
  opp_priority_badge: ""
};
const legit = {
  id: "p-legit",
  company_name: "Boulangerie Au Pain Doré",
  city: "Montréal",
  industry: "Alimentation",
  dq: 80,
  rel: 90,
  signals: ["Source ouverte"],
  ai: "Correspond au profil.",
  inCrm: false
};
const apostrophe = {
  id: "p-schwartz",
  company_name: "Schwartz's",
  city: "Montréal",
  industry: "Restauration",
  dq: 70,
  rel: 75,
  signals: [],
  ai: "",
  inCrm: false
};

test("un company_name hostile en mémoire ne crée pas d'élément img", () => {
  sandbox.KS.S.prospects = [hostile, legit, apostrophe];
  sandbox.KS.S.crm = [{
    id: "l-hostile",
    company_name: payload,
    city: "Montréal",
    stage: "New",
    prospectId: "p-legit",
    nextAction: payload,
    log: []
  }];
  sandbox.KS.S.deals = [];
  const prospects = assertNoElement(sandbox.vProspects(), "prospects");
  assert.equal(prospects.textContent.includes("Boulangerie Au Pain Doré"), true);
  assert.equal(prospects.textContent.includes("Montréal"), true);
  assert.equal(prospects.textContent.includes("Schwartz's"), true);
  assertNoElement(sandbox.vCrmLeads(), "crm");
  sandbox.showDrawer("p-hostile");
  const drawer = slots.drawer.innerHTML;
  assertNoElement(drawer, "drawer");
  assert.equal(parseFragment(drawer).textContent.includes("Montréal"), true);
  assert.equal(sandbox.KS.S.prospects[0].company_name, payload);
  assert.equal(sandbox.KS.S.prospects[1].company_name, "Boulangerie Au Pain Doré");
});
