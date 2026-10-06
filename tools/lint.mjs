import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const files = [
  "security.js", "data.js", "engine.js", "store.js", "auth-policy.js", "auth.js", "webintel.js",
  "opportunity.js", "sources.js", "webai.js", "projects.js", "app.js"
];

for (const file of files) {
  const path = new URL("../src/" + file, import.meta.url);
  const result = spawnSync(process.execPath, ["--check", path.pathname], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `Syntaxe invalide: ${file}`);
}

const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
const forbiddenScripts = ["team.js", "recovery.js", "nuage.js", "text/x-server-plugin"];
for (const value of forbiddenScripts) {
  if (html.includes(value)) throw new Error(`Chemin sensible actif dans index: ${value}`);
}

const store = await readFile(new URL("../src/store.js", import.meta.url), "utf8");
if (store.includes("localStorage") || /hashPw|password\s*:|apiKey\s*:\s*["'`]/.test(store)) {
  throw new Error("Le stockage client contient encore un secret ou un mot de passe.");
}
console.log(`${files.length} scripts valides; chemins sensibles absents`);
