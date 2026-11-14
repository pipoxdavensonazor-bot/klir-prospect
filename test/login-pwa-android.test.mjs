import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const read = (p) => readFile(new URL("../" + p, import.meta.url), "utf8");

test("page de connexion : logo KlirProspect, promotion et bouton d'installation", async () => {
  const app = await read("src/app.js");
  assert.match(app, /function authBrand\(\)/);
  assert.match(app, /<form class="card" id="authForm">\$\{authBrand\(\)\}/);
  assert.match(app, /src="icons\/logo\.png" alt="KlirProspect"/);
  assert.match(app, /200 crédits offerts à l’inscription — trouvez vos prochains clients B2B en quelques minutes/);
  assert.match(app, /data-install-app hidden/);
  assert.match(app, /beforeinstallprompt/);
  assert.match(app, /serviceWorker\.register\("\/sw\.js"/);
});

test("PWA : manifeste KlirProspect et service worker sans cache de données", async () => {
  const m = JSON.parse(await read("src/manifest.webmanifest"));
  assert.equal(m.name, "KlirProspect");
  assert.equal(m.display, "standalone");
  assert.equal(m.start_url, "/");
  assert.ok(m.icons.some((i) => i.sizes === "512x512" && i.purpose === "maskable"));
  const sw = await read("src/sw.js");
  assert.match(sw, /addEventListener\("fetch"/);
  assert.doesNotMatch(sw, /caches\./);
  assert.doesNotMatch(sw, /supabase\.co/i);
});

test("Android : assetlinks pour ca.klirline.klirprospect et politique de confidentialité", async () => {
  const links = JSON.parse(await read("src/.well-known/assetlinks.json"));
  assert.equal(links[0].target.package_name, "ca.klirline.klirprospect");
  assert.deepEqual(links[0].relation, ["delegate_permission/common.handle_all_urls"]);
  for (const f of links[0].target.sha256_cert_fingerprints) assert.match(f, /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  const privacy = await read("src/confidentialite.html");
  assert.match(privacy, /Politique de confidentialité/);
  assert.match(privacy, /contact@klirline\.ca/);
  const headers = await read("_headers");
  assert.match(headers, /\/\.well-known\/assetlinks\.json\n  Content-Type: application\/json/);
  const build = await read("tools/build.mjs");
  for (const f of ["sw.js", "confidentialite.html", ".well-known"]) assert.ok(build.includes(`"../src/${f}"`), f);
});

test("assetlinks : clé de signature Play et clé d'envoi", async () => {
  const links = JSON.parse(await read("src/.well-known/assetlinks.json"));
  assert.deepEqual(links[0].target.sha256_cert_fingerprints, [
    "18:7D:F8:3A:2F:0D:DC:8E:0C:4C:A4:28:6F:18:87:3E:0E:2D:29:4B:8A:A3:45:F0:FB:29:65:1E:07:47:14:24",
    "70:2E:AE:55:15:03:11:2D:81:49:7D:CD:C2:C8:BE:0A:B8:AD:38:8C:53:64:2B:F4:D8:AC:79:04:A8:79:16:66"
  ]);
});
