import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
const headers = await readFile(new URL("../_headers", import.meta.url), "utf8");
const webai = await readFile(new URL("../src/webai.js", import.meta.url), "utf8");
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");

function scriptSrc(policy) {
  const match = policy.match(/script-src[^;]*/);
  assert.ok(match, policy);
  return match[0];
}

test("script-src n’autorise plus unsafe-inline", () => {
  for (const policy of [html, headers]) {
    const directive = scriptSrc(policy);
    assert.equal(directive.includes("unsafe-inline"), false);
    assert.match(directive, /script-src 'self' 'sha256-[A-Za-z0-9+/]+=+'/);
  }
  assert.equal(scriptSrc(html), scriptSrc(headers));
  assert.match(html, /style-src 'self' 'unsafe-inline'/);
  assert.match(headers, /style-src 'self' 'unsafe-inline'/);
});

test("les sources ne contiennent plus d’attributs d’événements inline", async () => {
  const names = (await readdir(new URL("../src/", import.meta.url))).filter((name) => name.endsWith(".js") || name.endsWith(".html"));
  const attribute = /(?:^|[^.\w])on[a-z]+\s*=\s*(?:\\)?["']/g;
  for (const name of names) {
    const source = await readFile(new URL("../src/" + name, import.meta.url), "utf8");
    assert.equal(attribute.test(source), false, name);
    attribute.lastIndex = 0;
  }
});

test("l’empreinte CSP correspond au script fixe de l’aperçu", () => {
  const sandbox = { addEventListener() {}, KlirStore: { S: {}, save() {}, audit() {}, uid() { return "x"; } } };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(webai, sandbox);
  const first = sandbox.WebAI.renderSite({ id: "abc_1", company: "Café", model: { sections: [{ type: "contact" }] } });
  const second = sandbox.WebAI.renderSite({ id: "autre-id", company: "Autre", model: { sections: [{ type: "contact" }] } });
  const classic = (markup) => [...markup.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
  const [script] = classic(first);
  assert.equal(classic(first).length, 1);
  assert.equal(script, classic(second)[0]);
  assert.match(first, /data-webai-project="abc_1"/);
  assert.match(second, /data-webai-project="autre-id"/);
  assert.equal(script.includes("abc_1"), false);
  const hash = "sha256-" + createHash("sha256").update(script).digest("base64");
  assert.match(html, new RegExp(hash.replace(/[+/]/g, "\\$&")));
  assert.match(headers, new RegExp(hash.replace(/[+/]/g, "\\$&")));
});

test("les clics délégués naviguent, défilent ou ferment sans exécuter une URL", () => {
  const start = app.indexOf("function onDelegatedClick");
  const end = app.indexOf('document.addEventListener("click",onDelegatedClick)');
  const elements = new Map();
  const sandbox = {
    location: { hash: "" },
    document: { getElementById(id) { return elements.get(id) || null; } }
  };
  vm.createContext(sandbox);
  vm.runInContext(app.slice(start, end), sandbox);
  function control(attrs, parent) {
    const node = {
      parentElement: parent || null,
      getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null; },
      closest(selector) {
        const name = selector.slice(1, -1);
        if (Object.hasOwn(attrs, name)) return node;
        return parent && parent.closest ? parent.closest(selector) : null;
      },
      remove() { node.removed = true; }
    };
    return node;
  }
  sandbox.onDelegatedClick({ target: control({ "data-nav": "#/ai" }) });
  assert.equal(sandbox.location.hash, "#/ai");
  sandbox.onDelegatedClick({ target: control({ "data-nav": "javascript:alert(1)" }) });
  assert.equal(sandbox.location.hash, "#/ai");
  const child = control({}, control({ "data-nav": "#/project/abc_1/overview" }));
  sandbox.onDelegatedClick({ target: child });
  assert.equal(sandbox.location.hash, "#/project/abc_1/overview");
  const demo = { scrolled: false, scrollIntoView() { this.scrolled = true; } };
  elements.set("demo", demo);
  sandbox.onDelegatedClick({ target: control({ "data-scroll": "demo" }) });
  assert.equal(demo.scrolled, true);
  const drawer = control({});
  const close = control({ "data-dismiss": "" }, drawer);
  sandbox.onDelegatedClick({ target: close });
  assert.equal(drawer.removed, true);
});
