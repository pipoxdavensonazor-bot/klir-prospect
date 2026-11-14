// Service worker KlirProspect : rend le site installable (PWA / Android).
// Aucune mise en cache des données ni des réponses Supabase : le réseau reste
// la seule source. Hors ligne, une page d'attente est affichée.
const OFFLINE = '<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KlirProspect — hors ligne</title><body style="margin:0;background:#0b0e1a;color:#e8eaf6;font:16px/1.6 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;text-align:center"><main><h1>Hors ligne</h1><p>KlirProspect a besoin d\'une connexion Internet.<br>Vérifiez votre réseau puis réessayez.</p></main></body></html>';
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => new Response(OFFLINE, { headers: { "Content-Type": "text/html; charset=utf-8" } })));
});
