import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
const css = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const app = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const manifestText = await readFile(new URL("../src/manifest.webmanifest", import.meta.url), "utf8");
const manifest = JSON.parse(manifestText);
const headers = await readFile(new URL("../_headers", import.meta.url), "utf8");

function pngSize(bytes) {
  assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(bytes.toString("ascii", 12, 16), "IHDR");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test("le viewport mobile autorise le zoom et les zones sûres", () => {
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/);
  assert.doesNotMatch(html, /user-scalable\s*=\s*no|maximum-scale\s*=\s*1/);
  assert.match(html, /name="theme-color"/);
  assert.match(html, /rel="manifest" href="manifest.webmanifest"/);
});

test("le manifeste permet l’installation Chrome", () => {
  assert.equal(manifest.name, "Klir Prospect");
  assert.equal(manifest.short_name, "Klir");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.prefer_related_applications, false);
  assert.equal(manifest.lang, "fr");
  const icons = new Map(manifest.icons.map((icon) => [icon.purpose + ":" + icon.sizes, icon.src]));
  assert.equal(icons.get("any:192x192"), "icons/icon-192.png");
  assert.equal(icons.get("any:512x512"), "icons/icon-512.png");
  assert.equal(icons.get("maskable:512x512"), "icons/icon-maskable-512.png");
  assert.match(headers, /\/manifest\.webmanifest[\s\S]*Content-Type: application\/manifest\+json/);
});

test("les icônes ont les tailles annoncées", async () => {
  const expected = {
    "icons/icon-192.png": 192,
    "icons/icon-512.png": 512,
    "icons/icon-maskable-512.png": 512
  };
  for (const [file, size] of Object.entries(expected)) {
    const bytes = await readFile(new URL("../src/" + file, import.meta.url));
    assert.deepEqual(pngSize(bytes), { width: size, height: size });
  }
});

test("Connexion, Inscription et Démo ouvrent trois écrans distincts", () => {
  assert.match(app, /class="land-actions"><a href="#\/login">Connexion<\/a><a href="#\/register">Inscription<\/a><a class="cta" href="#\/demo">Démo<\/a>/);
  assert.match(app, /aria-label="Navigation principale"/);
  assert.match(app, /aria-controls="sideNav" aria-expanded="false"/);
  assert.match(app, /\$\{register\?"Inscription":"Connexion"\}/);
  assert.doesNotMatch(app, /service[_-]?role|SUPABASE_SERVICE_ROLE_KEY/);
});

test("la feuille de style prévoit le tactile, le texte et l’absence de défilement de page", () => {
  assert.match(css, /font-size:\s*100%/);
  assert.match(css, /font-size:\s*1rem/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(css, /env\(safe-area-inset-top/);
  assert.match(css, /env\(safe-area-inset-bottom/);
  assert.match(css, /overflow-x:\s*clip/);
  assert.match(css, /\.land-actions\s*\{[^}]*flex-wrap:\s*wrap/);
  assert.match(css, /@media \(min-width:\s*901px\)/);
  assert.match(css, /#menuBtn,\s*#sideOverlay\s*\{\s*display:\s*none/);
});
