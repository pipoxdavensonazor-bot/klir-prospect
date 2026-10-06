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
  for (const value of ["=2+2", "+cmd", "-10+1", "@SUM(A1:A2)", "\tformula"]) {
    assert.match(security.csvCell(value), /^"'|^"'/);
  }
  assert.equal(security.csvCell("normal"), '"normal"');
});

test("refuse les destinations privées et ambiguës", () => {
  for (const value of ["localhost", "127.0.0.1", "10.0.0.1", "[::1]", "intranet.local", "https://user:pass@example.com"]) {
    assert.equal(security.domain(value), "");
  }
  assert.equal(security.domain("https://www.example.com/path"), "www.example.com");
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
