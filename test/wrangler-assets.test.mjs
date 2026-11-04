import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("le déploiement Workers sert dist sans fichier worker.js", async () => {
  const raw = (await readFile(new URL("../wrangler.toml", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const config = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("#"))
    .join("\n");
  assert.equal(existsSync(new URL("../worker.js", import.meta.url)), false);
  assert.match(config, /^name = "klir-prospect"$/m);
  assert.match(config, /^\[assets\]\ndirectory = "\.\/dist"$/m);
  assert.match(config, /^\[build\]\ncommand = "npm run build"$/m);
  assert.match(config, /^\[previews\]$/m);
  assert.equal(/^main\s*=/m.test(config), false);
  assert.equal(config.includes("paynfc-agg"), false);
  assert.equal(config.includes("worker.js"), false);
});
