import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

async function publicSupabaseConfig() {
  let supabaseUrl = process.env.SUPABASE_URL || "";
  let supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || "";
  if (!supabaseUrl || !supabasePublishableKey) {
    try {
      const response = await fetch("https://klirprospect.klirline.ca/config.js", {
        headers: { Accept: "application/javascript", "User-Agent": "Mozilla/5.0 KlirProspect-build" }
      });
      if (!response.ok) throw new Error("http " + response.status);
      const text = await response.text();
      const match = text.match(/window\.__KLIR_CONFIG__=(\{.*?\});/);
      if (!match) throw new Error("format");
      const parsed = JSON.parse(match[1]);
      supabaseUrl = supabaseUrl || parsed.supabaseUrl || "";
      supabasePublishableKey = supabasePublishableKey || parsed.supabasePublishableKey || "";
    } catch (error) {
      if (process.env.CI) throw new Error("Configuration publique Supabase introuvable pour le build.");
    }
  }
  if (supabaseUrl && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl)) {
    throw new Error("SUPABASE_URL invalide.");
  }
  if (process.env.CI && (!supabaseUrl || !supabasePublishableKey || /service_role/i.test(supabasePublishableKey))) {
    throw new Error("SUPABASE_URL et SUPABASE_PUBLISHABLE_KEY sont requis pour publier.");
  }
  return { supabaseUrl, supabasePublishableKey };
}

const out = new URL("../dist/", import.meta.url);
const runtime = [
  "security.js", "data.js", "engine.js", "store.js", "webintel.js",
  "opportunity.js", "sources.js", "webai.js", "projects.js", "app.js", "styles.css"
];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(new URL("../src/index.html", import.meta.url), new URL("index.html", out));
await cp(new URL("../_headers", import.meta.url), new URL("_headers", out));
await cp(new URL("../src/manifest.webmanifest", import.meta.url), new URL("manifest.webmanifest", out));
await cp(new URL("../src/icons", import.meta.url), new URL("icons", out), { recursive: true });
for (const file of runtime) {
  await cp(new URL("../src/" + file, import.meta.url), new URL(file, out));
}
const published = await publicSupabaseConfig();
const supabaseUrl = published.supabaseUrl;
const supabasePublishableKey = published.supabasePublishableKey;
await writeFile(new URL("config.js", out), `window.__KLIR_CONFIG__=${JSON.stringify({
  supabaseUrl,
  supabasePublishableKey
}).replace(/</g, "\\u003c")};\n`);
await build({
  entryPoints: [new URL("../src/auth.js", import.meta.url).pathname],
  outfile: new URL("auth.js", out).pathname,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  sourcemap: false
});

const html = await readFile(new URL("index.html", out), "utf8");
for (const file of runtime.filter((name) => name.endsWith(".js"))) {
  if (!html.includes(`src="${file}"`)) throw new Error(`Script absent de src/index.html: ${file}`);
}
for (const file of ["config.js", "auth.js"]) {
  if (!html.includes(`src="${file}"`)) throw new Error(`Script absent de src/index.html: ${file}`);
}
if (html.includes("text/x-server-plugin") || html.includes("nuage.js") || html.includes("team.js")) {
  throw new Error("Un chemin sensible a été inclus dans le build.");
}
if (!html.includes('rel="manifest" href="manifest.webmanifest"')) {
  throw new Error("Le manifeste web est absent de src/index.html.");
}
for (const file of ["manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png"]) {
  await readFile(new URL(file, out));
}
await writeFile(join(out.pathname, "build.json"), JSON.stringify({
  reproducible: true,
  files: runtime.length + 9,
  supabaseConfigured: Boolean(supabaseUrl && supabasePublishableKey)
}, null, 2) + "\n");
console.log(`dist créé avec ${runtime.length + 9} fichiers`);
