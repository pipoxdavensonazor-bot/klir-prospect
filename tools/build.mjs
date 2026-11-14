import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build, transform } from "esbuild";
import { allowsPublicConfig, decideSupabase, isPublicSupabaseKey, publishRequiresSupabaseConfig, resolveEnvironment } from "./release-identity.mjs";
import { previewCheckoutFlag, STRIPE_TEST_PROJECT_URL } from "../supabase/functions/_shared/stripe-test-offer.mjs";

function publishedCommit() {
  const fromEnv = process.env.WORKERS_CI_COMMIT_SHA || process.env.CF_PAGES_COMMIT_SHA || process.env.GITHUB_SHA || "";
  if (fromEnv) return String(fromEnv).trim();
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch (error) {
    return "";
  }
}

async function publicSupabaseConfig(environment) {
  if (process.env.SUPABASE_PUBLISHABLE_KEY && !isPublicSupabaseKey(process.env.SUPABASE_PUBLISHABLE_KEY)) {
    throw new Error("Clé Supabase refusée : utilisez une clé publishable publique, jamais une clé privée.");
  }
  const decision = decideSupabase(process.env, environment);
  if (!decision.fetchPublic) {
    if (allowsPublicConfig(environment) && decision.supabaseUrl && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(decision.supabaseUrl)) {
      throw new Error("SUPABASE_URL invalide.");
    }
    if (allowsPublicConfig(environment) && process.env.CI && (!decision.supabaseUrl || !decision.supabasePublishableKey || !isPublicSupabaseKey(decision.supabasePublishableKey))) {
      throw new Error("SUPABASE_URL et SUPABASE_PUBLISHABLE_KEY sont requis pour publier.");
    }
    return decision;
  }
  if (!allowsPublicConfig(environment)) {
    throw new Error("Une prévisualisation ne copie pas la configuration du site public.");
  }
  let supabaseUrl = decision.supabaseUrl;
  let supabasePublishableKey = decision.supabasePublishableKey;
  let supabaseSource = "absent";
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
    supabaseSource = "public-site";
  } catch (error) {
    if (process.env.CI && publishRequiresSupabaseConfig(environment)) {
      throw new Error("Configuration publique Supabase introuvable pour le build.");
    }
  }
  if (supabaseUrl && !/^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl)) {
    throw new Error("SUPABASE_URL invalide.");
  }
  if (supabasePublishableKey && !isPublicSupabaseKey(supabasePublishableKey)) {
    throw new Error("Configuration publique refusée : la clé Supabase n'est pas une clé publique.");
  }
  const missingPublicConfig = !supabaseUrl || !supabasePublishableKey;
  if (process.env.CI && publishRequiresSupabaseConfig(environment) && missingPublicConfig) {
    throw new Error("SUPABASE_URL et SUPABASE_PUBLISHABLE_KEY sont requis pour publier.");
  }
  return {
    supabaseUrl,
    supabasePublishableKey,
    supabaseSource,
    supabaseHost: /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(supabaseUrl) ? supabaseUrl.slice("https://".length) : "",
    fetchPublic: false
  };
}

const out = new URL("../dist/", import.meta.url);
const runtime = [
  "security.js", "data.js", "engine.js", "store.js", "webintel.js",
  "opportunity.js", "sources.js", "overture.js", "webai.js", "projects.js", "billing.js", "app.js", "styles.css"
];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(new URL("../src/index.html", import.meta.url), new URL("index.html", out));
await cp(new URL("../_headers", import.meta.url), new URL("_headers", out));
await cp(new URL("../src/manifest.webmanifest", import.meta.url), new URL("manifest.webmanifest", out));
await cp(new URL("../src/icons", import.meta.url), new URL("icons", out), { recursive: true });
// PWA / Android : service worker à la racine (sans empreinte), politique de
// confidentialité statique et Digital Asset Links pour l'app Play (TWA).
await cp(new URL("../src/sw.js", import.meta.url), new URL("sw.js", out));
await cp(new URL("../src/confidentialite.html", import.meta.url), new URL("confidentialite.html", out));
await cp(new URL("../src/.well-known", import.meta.url), new URL(".well-known", out), { recursive: true });
for (const file of runtime) {
  await cp(new URL("../src/" + file, import.meta.url), new URL(file, out));
}
const environment = resolveEnvironment(process.env);
const published = await publicSupabaseConfig(environment);
const supabaseUrl = published.supabaseUrl;
const supabasePublishableKey = published.supabasePublishableKey;
const stripeTestCheckout = previewCheckoutFlag(environment, process.env.STRIPE_TEST_CHECKOUT_ENABLED);
if (stripeTestCheckout && supabaseUrl !== STRIPE_TEST_PROJECT_URL) {
  throw new Error("Le paiement de test exige le projet Supabase de test, pas la production.");
}
await writeFile(new URL("config.js", out), `window.__KLIR_CONFIG__=${JSON.stringify({
  supabaseUrl,
  supabasePublishableKey,
  environment,
  stripeTestCheckout
}).replace(/</g, "\\u003c")};\n`);
await build({
  entryPoints: [fileURLToPath(new URL("../src/auth.js", import.meta.url))],
  outfile: fileURLToPath(new URL("auth.js", out)),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  legalComments: "none",
  sourcemap: false
});

let html = await readFile(new URL("index.html", out), "utf8");
for (const file of runtime.filter((name) => name.endsWith(".js"))) {
  if (!html.includes(`src="${file}"`)) throw new Error(`Script absent de src/index.html: ${file}`);
}
for (const file of ["config.js", "auth.js"]) {
  if (!html.includes(`src="${file}"`)) throw new Error(`Script absent de src/index.html: ${file}`);
}
const icons = ["icons/icon-192.png", "icons/icon-512.png", "icons/icon-maskable-512.png", "icons/logo.png"];
const iconNames = new Map();
let manifest = await readFile(new URL("manifest.webmanifest", out), "utf8");
for (const icon of icons) {
  const bytes = await readFile(new URL(icon, out));
  const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 10);
  const hashed = icon.replace(/\.png$/i, `.${hash}.png`);
  await writeFile(new URL(hashed, out), bytes);
  await rm(new URL(icon, out));
  iconNames.set(icon, hashed);
  html = html.replaceAll(`${icon}?v=2`, hashed).replaceAll(icon, hashed);
  manifest = manifest.replaceAll(icon, hashed);
}
await writeFile(new URL("manifest.webmanifest", out), manifest);
function stampIcons(text) {
  let next = text;
  for (const [icon, hashed] of iconNames) next = next.replaceAll(icon, hashed);
  return next;
}
const seen = new Set();
for (const file of [...runtime, "config.js", "auth.js"]) {
  const source = await readFile(new URL(file, out));
  const loader = file.endsWith(".css") ? "css" : "js";
  const minified = stampIcons(file === "auth.js"
    ? source.toString("utf8")
    : (await transform(source.toString("utf8"), {
      loader,
      minify: true,
      target: ["es2022"],
      charset: "utf8",
      legalComments: "none"
    })).code);
  const hash = createHash("sha256").update(minified).digest("hex").slice(0, 10);
  const hashed = file.replace(/\.([a-z0-9]+)$/i, `.${hash}.$1`);
  if (seen.has(hashed)) throw new Error(`Empreinte en collision: ${file}`);
  seen.add(hashed);
  await writeFile(new URL(hashed, out), minified);
  if (hashed !== file) await rm(new URL(file, out));
  html = html.replaceAll(`src="${file}"`, `src="${hashed}"`).replaceAll(`href="${file}"`, `href="${hashed}"`);
}
if (!html.includes("defer src=") || html.includes('src="app.js"') || html.includes('href="styles.css"')) {
  throw new Error("Les assets publiés doivent rester différés et porter leur empreinte.");
}
await writeFile(new URL("index.html", out), html);
if (html.includes("text/x-server-plugin") || html.includes("nuage.js") || html.includes("team.js")) {
  throw new Error("Un chemin sensible a été inclus dans le build.");
}
if (!html.includes('rel="manifest" href="manifest.webmanifest"')) {
  throw new Error("Le manifeste web est absent de src/index.html.");
}
for (const file of ["manifest.webmanifest", ...iconNames.values()]) {
  await readFile(new URL(file, out));
}
if (html.includes("icons/icon-192.png") || html.includes("icons/logo.png") || manifest.includes("icons/icon-192.png")) {
  throw new Error("Une icône publiée n'a pas reçu son empreinte.");
}
await writeFile(new URL("build.json", out), JSON.stringify({
  reproducible: true,
  files: runtime.length + 9,
  supabaseConfigured: Boolean(supabaseUrl && supabasePublishableKey),
  supabaseSource: published.supabaseSource,
  supabaseHost: published.supabaseHost || "",
  commit: publishedCommit(),
  builtAt: new Date().toISOString(),
  environment
}, null, 2) + "\n");
console.log(`dist créé avec ${runtime.length + 9} fichiers`);
console.log(`build-identity environment=${environment} supabase=${published.supabaseSource}`);
