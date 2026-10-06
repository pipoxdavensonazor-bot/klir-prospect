import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

const supabaseUrl = process.env.SUPABASE_URL || "";
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || "";
if (process.env.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_SERVICE_ROLE_KEY ne doit pas être présent pendant le build client.");
}
if (supabaseUrl && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl)) {
  throw new Error("SUPABASE_URL invalide.");
}
if (/service[_-]role|sb_secret_/i.test(supabasePublishableKey)) {
  throw new Error("SUPABASE_PUBLISHABLE_KEY ne doit pas être une clé secrète.");
}
if (supabasePublishableKey.split(".").length === 3) {
  try {
    const payload = JSON.parse(Buffer.from(supabasePublishableKey.split(".")[1], "base64url").toString("utf8"));
    if (payload.role === "service_role") throw new Error("SUPABASE_PUBLISHABLE_KEY ne doit pas être une clé secrète.");
  } catch (error) {
    if (String(error.message).includes("clé secrète")) throw error;
  }
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
for (const file of runtime) {
  await cp(new URL("../src/" + file, import.meta.url), new URL(file, out));
}
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
await writeFile(join(out.pathname, "build.json"), JSON.stringify({
  reproducible: true,
  files: runtime.length + 5,
  supabaseConfigured: Boolean(supabaseUrl && supabasePublishableKey)
}, null, 2) + "\n");
console.log(`dist créé avec ${runtime.length + 5} fichiers`);
