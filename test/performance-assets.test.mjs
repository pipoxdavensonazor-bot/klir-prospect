import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
const headers = normalizeNewlines(await readFile(new URL("../_headers", import.meta.url), "utf8"));

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function assertLongCacheRules(raw) {
  const text = normalizeNewlines(raw);
  assert.match(text, /^\/\n {2}Cache-Control: public, max-age=0, must-revalidate$/m);
  assert.match(text, /^\/index\.html\n {2}Cache-Control: public, max-age=0, must-revalidate$/m);
  assert.match(text, /^\/\*\.js\n {2}Cache-Control: public, max-age=31536000, immutable$/m);
  assert.match(text, /^\/\*\.css\n {2}Cache-Control: public, max-age=31536000, immutable$/m);
  assert.match(text, /^\/icons\/\*\n {2}Cache-Control: public, max-age=31536000, immutable$/m);
  assert.match(text, /Content-Security-Policy:/);
}

const SCRIPT_ORDER = [
  "config.js",
  "security.js",
  "data.js",
  "engine.js",
  "store.js",
  "webintel.js",
  "opportunity.js",
  "sources.js",
  "overture.js",
  "webai.js",
  "projects.js",
  "billing.js",
  "auth.js",
  "app.js"
];

test("les 14 scripts restent dans l’ordre et ne bloquent plus l’analyse", () => {
  const tags = [...html.matchAll(/<script\b([^>]*)><\/script>/g)].map((match) => match[1]);
  assert.equal(tags.length, 14);
  const sources = tags.map((attributes) => {
    assert.match(attributes, /(^|\s)defer(\s|$)/);
    assert.equal(attributes.includes("async"), false);
    const source = attributes.match(/\ssrc="([^"]+)"/);
    assert.ok(source);
    return source[1];
  });
  assert.deepEqual(sources, SCRIPT_ORDER);
});

test("le cache long vise les assets empreintés, pas le document", () => {
  assertLongCacheRules(headers);
});

test("les mêmes règles de cache acceptent un fichier _headers en CRLF", () => {
  const crlf = headers.replace(/\n/g, "\r\n");
  assert.equal(crlf.includes("\r\n"), true);
  assert.equal(crlf.replace(/\r\n/g, "").includes("\n"), false);
  assertLongCacheRules(crlf);
});
