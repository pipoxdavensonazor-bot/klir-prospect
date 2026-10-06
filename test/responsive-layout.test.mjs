import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import test from "node:test";
import { existsSync } from "node:fs";

const chromeCandidates = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/local/bin/google-chrome"
].filter(Boolean);
const chromePath = chromeCandidates.find((path) => existsSync(path));

const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36";
const DESKTOP = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const VIEWS = [
  { name: "android-390", width: 390, height: 844, scale: 2.75, mobile: true, agent: ANDROID },
  { name: "android-412", width: 412, height: 915, scale: 2.625, mobile: true, agent: ANDROID },
  { name: "tablet-768", width: 768, height: 1024, scale: 2, mobile: true, agent: ANDROID },
  { name: "desktop-1280", width: 1280, height: 800, scale: 1, mobile: false, agent: DESKTOP }
];

function startServer() {
  const root = normalize(new URL("../src/", import.meta.url).pathname);
  const types = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".webmanifest": "application/manifest+json",
    ".png": "image/png"
  };
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/config.js") {
      response.writeHead(200, { "content-type": types[".js"] });
      response.end("window.__KLIR_CONFIG__={};");
      return;
    }
    if (url.pathname === "/auth.js") {
      response.writeHead(200, { "content-type": types[".js"] });
      response.end("");
      return;
    }
    const path = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) {
      response.writeHead(403);
      response.end();
      return;
    }
    try {
      const body = await readFile(file);
      response.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function connect(browserWs) {
  const ws = new WebSocket(browserWs);
  let nextId = 0;
  const pending = new Map();
  const waits = [];
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("WebSocket Chrome refusé")));
  });
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message.result || {});
      return;
    }
    for (const wait of waits) {
      if (wait.method === message.method && (!wait.sessionId || wait.sessionId === message.sessionId)) {
        wait.resolve(message);
      }
    }
  });
  function send(method, params = {}, sessionId) {
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      const payload = { id, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });
  }
  function waitFor(method, sessionId) {
    return new Promise((resolve) => {
      waits.push({ method, sessionId, resolve });
    });
  }
  return { ready, send, waitFor, close: () => ws.close() };
}

async function openSession(cdp, url) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `(() => {
      const orig = window.addEventListener;
      window.addEventListener = function(type, fn, options) {
        if (type !== "hashchange") return orig.call(this, type, fn, options);
        let skipNext = false;
        const wrapped = function(event) {
          if (skipNext) { skipNext = false; return; }
          const before = location.hash;
          const result = fn.call(this, event);
          if (location.hash !== before) skipNext = true;
          return result;
        };
        return orig.call(this, type, wrapped, options);
      };
    })();`
  }, sessionId);
  return {
    sessionId,
    async emulate(view) {
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width: view.width,
        height: view.height,
        deviceScaleFactor: view.scale,
        mobile: view.mobile
      }, sessionId);
      await cdp.send("Emulation.setUserAgentOverride", { userAgent: view.agent }, sessionId);
    },
    async goto(nextUrl) {
      const loaded = cdp.waitFor("Page.loadEventFired", sessionId);
      await cdp.send("Page.navigate", { url: nextUrl }, sessionId);
      await loaded;
    },
    async eval(expression) {
      const result = await cdp.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true
      }, sessionId);
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || "évaluation impossible");
      }
      return result.result?.value;
    },
    async screenshot(file) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, sessionId);
      await writeFile(file, Buffer.from(shot.data, "base64"));
    }
  };
}

const PROBE = `(() => {
  const root = document.documentElement;
  const links = [...document.querySelectorAll(".land-actions a")].map((link) => {
    const rect = link.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return {
      text: link.textContent.trim(),
      href: link.getAttribute("href"),
      x: rect.x, y: rect.y, w: rect.width, h: rect.height,
      tabIndex: link.tabIndex,
      hit: hit === link || (hit && link.contains(hit))
    };
  });
  const heading = document.querySelector(".auth h2");
  const menu = document.getElementById("menuBtn");
  const side = document.querySelector(".side");
  const sideStyle = side ? getComputedStyle(side) : null;
  const sideRect = side ? side.getBoundingClientRect() : null;
  return {
    hash: location.hash,
    scrollWidth: Math.max(root.scrollWidth, document.body.scrollWidth),
    clientWidth: root.clientWidth,
    innerWidth: window.innerWidth,
    bodyFont: parseFloat(getComputedStyle(document.body).fontSize),
    links,
    heading: heading ? heading.textContent : "",
    menu: menu ? getComputedStyle(menu).display : "",
    side: side ? {
      visibility: sideStyle.visibility,
      position: sideStyle.position,
      left: sideRect.left,
      right: sideRect.right,
      width: sideRect.width
    } : null
  };
})()`;

function overlaps(a, b) {
  return a.x < b.x + b.w - 1 && a.x + a.w > b.x + 1 && a.y < b.y + b.h - 1 && a.y + a.h > b.y + 1;
}

function assertContained(view, probe, label) {
  assert.ok(probe.scrollWidth <= probe.clientWidth + 1, `${view.name} ${label}: défilement horizontal ${probe.scrollWidth} > ${probe.clientWidth}`);
  assert.ok(probe.bodyFont >= 16, `${view.name} ${label}: texte ${probe.bodyFont}px`);
}

function assertNav(view, probe) {
  assertContained(view, probe, "accueil");
  assert.deepEqual(probe.links.map((link) => [link.text, link.href]), [
    ["Connexion", "#/login"],
    ["Inscription", "#/register"],
    ["Démo", "#/demo"]
  ]);
  for (const link of probe.links) {
    assert.ok(link.w >= 44 && link.h >= 44, `${view.name} ${link.text}: cible ${link.w}x${link.h}`);
    assert.equal(link.tabIndex, 0, `${view.name} ${link.text} hors du clavier`);
    assert.ok(link.x >= -1 && link.x + link.w <= probe.innerWidth + 1, `${view.name} ${link.text} sort de l’écran`);
    assert.equal(link.hit, true, `${view.name} ${link.text} est couvert`);
  }
  for (let i = 0; i < probe.links.length; i++) {
    for (let j = i + 1; j < probe.links.length; j++) {
      assert.equal(overlaps(probe.links[i], probe.links[j]), false, `${view.name}: ${probe.links[i].text} chevauche ${probe.links[j].text}`);
    }
  }
}

test("Chrome affiche le site de 390 px au bureau sans chevauchement", { skip: chromePath ? false : "Chrome introuvable", timeout: 120000 }, async () => {
  const server = await startServer();
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}/`;
  const userDataDir = await mkdtemp(join(tmpdir(), "klir-chrome-"));
  const child = spawn(chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let debugPort = 0;
  try {
    debugPort = await new Promise((resolve, reject) => {
      let buffer = "";
      const timer = setTimeout(() => reject(new Error("port Chrome absent")), 15000);
      child.stderr.on("data", (chunk) => {
        buffer += chunk.toString();
        const match = buffer.match(/DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//);
        if (!match) return;
        clearTimeout(timer);
        resolve(Number(match[1]));
      });
      child.on("exit", () => {
        clearTimeout(timer);
        reject(new Error("Chrome s’est arrêté"));
      });
    });
    const version = await (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).json();
    const cdp = connect(version.webSocketDebuggerUrl);
    await cdp.ready;
    const page = await openSession(cdp, origin);
    const shots = await mkdtemp(join(tmpdir(), "klir-shots-"));
    for (const view of VIEWS) {
      await page.emulate(view);
      await page.goto(`${origin}?vue=${view.name}`);
      let probe = await page.eval(`document.querySelector(".land-actions a") ? ${PROBE} : null`);
      assert.ok(probe, `${view.name}: accueil absent`);
      assertNav(view, probe);
      const focus = await page.eval(`(() => {
        const link = document.querySelector(".land-actions a");
        link.focus({ focusVisible: true });
        const style = getComputedStyle(link);
        return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) };
      })()`);
      assert.equal(focus.style, "solid", `${view.name}: focus invisible`);
      assert.ok(focus.width >= 3, `${view.name}: contour de focus trop fin`);

      await page.eval(`document.querySelector('.land-actions a[href="#/login"]').click()`);
      probe = await page.eval(PROBE);
      assert.equal(probe.hash, "#/login");
      assert.equal(probe.heading, "Connexion");
      assertContained(view, probe, "connexion");

      await page.eval(`location.hash = "#/landing"`);
      await page.eval(`document.querySelector('.land-actions a[href="#/register"]').click()`);
      probe = await page.eval(PROBE);
      assert.equal(probe.hash, "#/register");
      assert.equal(probe.heading, "Inscription");
      assertContained(view, probe, "inscription");

      await page.eval(`location.hash = "#/landing"`);
      await page.eval(`document.querySelector('.land-actions a[href="#/demo"]').click()`);
      probe = await page.eval(PROBE);
      assert.equal(probe.hash, "#/dashboard", `${view.name}: la démo n’ouvre pas le tableau de bord`);
      assert.ok(probe.side, `${view.name}: coque absente`);
      assertContained(view, probe, "démo");
      if (view.width < 901) {
        assert.notEqual(probe.menu, "none", `${view.name}: le menu mobile est absent`);
        assert.equal(probe.side.visibility, "hidden", `${view.name}: la barre latérale de bureau reste visible`);
        assert.ok(probe.side.right <= 0, `${view.name}: la barre latérale empiète sur l’écran`);
        await page.eval(`document.getElementById("menuBtn").click()`);
        probe = await page.eval(PROBE);
        assert.equal(probe.side.visibility, "visible");
        assert.ok(probe.side.left >= -1, `${view.name}: le menu ne s’ouvre pas`);
        assertContained(view, probe, "menu ouvert");
        await page.eval(`document.getElementById("sideOverlay").click()`);
        probe = await page.eval(PROBE);
        assert.equal(probe.side.visibility, "hidden");
      } else {
        assert.equal(probe.menu, "none", `${view.name}: le bouton menu reste affiché au bureau`);
        assert.equal(probe.side.visibility, "visible");
        assert.equal(probe.side.position, "sticky");
        assert.ok(probe.side.left >= -1 && probe.side.width >= 200);
      }
      if (view.name === "android-390" || view.name === "desktop-1280") {
        await page.eval(`location.hash = "#/landing"`);
        await page.screenshot(join(shots, `${view.name}-landing.png`));
        await page.eval(`location.hash = "#/demo"`);
        await page.screenshot(join(shots, `${view.name}-dashboard.png`));
      }
    }
    console.log(`captures: ${shots}`);
    cdp.close();
  } finally {
    child.kill("SIGKILL");
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode) resolve();
      else child.once("exit", resolve);
    });
    server.close();
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 }).catch(() => {});
  }
});
