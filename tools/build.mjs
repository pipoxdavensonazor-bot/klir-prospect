import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url);
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

const html = await readFile(new URL("index.html", out), "utf8");
for (const file of runtime.filter((name) => name.endsWith(".js"))) {
  if (!html.includes(`src="${file}"`)) throw new Error(`Script absent de src/index.html: ${file}`);
}
if (html.includes("text/x-server-plugin") || html.includes("nuage.js") || html.includes("team.js")) {
  throw new Error("Un chemin sensible a été inclus dans le build.");
}
await writeFile(join(out.pathname, "build.json"), JSON.stringify({
  reproducible: true,
  files: runtime.length + 3
}, null, 2) + "\n");
console.log(`dist créé avec ${runtime.length + 3} fichiers`);
