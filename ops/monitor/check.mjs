#!/usr/bin/env node
// Surveillance KlirProspect : site, fonctions Edge, jobs bloqués.
// Sans dépendance. Sortie : rapport Markdown sur stdout (aucun secret, aucune donnée
// personnelle) et code 1 si au moins un contrôle échoue.
// Variables : MONITOR_SUPABASE_URL, MONITOR_ANON_KEY (clé anon publique JWT),
//             MONITOR_SITE_URL (optionnel), MONITOR_ACCESS_CLIENT_ID/SECRET (optionnel,
//             jeton de service Cloudflare Access), MONITOR_SITE_STRICT=true (défi = échec).

const PROD_REF = "cbklwmjudobqwbkbxqgy";
const env = process.env;

export async function runChecks({ supabaseUrl, anonKey, siteUrl, access, siteStrict, fetchImpl = fetch, now = new Date() }) {
  const results = [];
  const add = (name, ok, detail, level = ok ? "ok" : "echec") => results.push({ name, ok, level, detail });
  const timed = async (url, init = {}) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    try { return await fetchImpl(url, { ...init, signal: ctl.signal, redirect: "manual" }); }
    finally { clearTimeout(t); }
  };

  if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(supabaseUrl || "")) {
    add("configuration", false, "MONITOR_SUPABASE_URL absente ou invalide");
    return results;
  }
  const isProd = supabaseUrl.includes(PROD_REF);
  const auth = { Authorization: `Bearer ${anonKey}`, apikey: anonKey };

  // 1. Site (build.json). Un défi Cloudflare prouve que le bord répond, pas l'origine.
  if (siteUrl) {
    try {
      const headers = {};
      if (access?.id && access?.secret) {
        headers["CF-Access-Client-Id"] = access.id;
        headers["CF-Access-Client-Secret"] = access.secret;
      }
      const r = await timed(new URL("/build.json", siteUrl), { headers });
      if (r.status === 200) {
        let commit = "?";
        try { const b = await r.json(); commit = String(b.commit ?? b.sha ?? "?").slice(0, 12); } catch { /* corps non JSON */ }
        add("site", true, `build.json 200, commit ${commit}`);
      } else if (r.headers.get("cf-mitigated") === "challenge") {
        add("site", !siteStrict, `défi Cloudflare (${r.status}) : bord joignable, origine non vérifiée`, siteStrict ? "echec" : "attention");
      } else {
        add("site", false, `build.json HTTP ${r.status}`);
      }
    } catch (e) { add("site", false, `injoignable (${e.name})`); }
  } else {
    add("site", true, "désactivé (MONITOR_SITE_URL absente)", "attention");
  }

  // 2. API search-jobs : santé publique.
  try {
    const r = await timed(`${supabaseUrl}/functions/v1/search-jobs/healthz`, { headers: auth });
    add("api search-jobs", r.status === 200, `healthz HTTP ${r.status}`);
  } catch (e) { add("api search-jobs", false, `injoignable (${e.name})`); }

  // 3. Runner : démarre et refuse l'anonyme (401/403). 5xx/timeout = panne.
  //    Le diagnostic admin complet exige une session admin : non automatisé (voir doc).
  try {
    const r = await timed(`${supabaseUrl}/functions/v1/search-job-runner`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}",
    });
    add("runner", r.status === 401 || r.status === 403, `démarrage OK si 401/403 anonyme ; reçu ${r.status}`);
  } catch (e) { add("runner", false, `injoignable (${e.name})`); }

  // 4. Base : jobs bloqués / réservations échues via public.klir_ops_health() (lecture seule).
  try {
    const r = await timed(`${supabaseUrl}/rest/v1/rpc/klir_ops_health`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: "{}",
    });
    if (r.status !== 200) {
      add("base", false, `klir_ops_health HTTP ${r.status}`);
    } else {
      const h = await r.json();
      const stuck = (h.queued_over_15m ?? 0) + (h.running_over_15m ?? 0);
      add("jobs bloqués", stuck === 0, `queued>15 min: ${h.queued_over_15m}, running>15 min: ${h.running_over_15m}`);
      add("réservations échues", (h.open_reservations_expired ?? 0) === 0, `réservations open échues: ${h.open_reservations_expired}`);
      add("runner HTTP (pg_net 1 h)", (h.runner_http_errors_1h ?? 0) === 0, `réponses non 2xx: ${h.runner_http_errors_1h ?? "n/a"}`);
      const last = h.scheduler_last_call ? new Date(h.scheduler_last_call) : null;
      const ageMin = last ? Math.round((now - last) / 60000) : null;
      add("moteur", true, `jobs_enabled=${h.jobs_enabled}, planificateur=${h.scheduler_enabled}, dernier appel il y a ${ageMin ?? "?"} min (${h.scheduler_last_outcome ?? "?"})`, "info");
    }
  } catch (e) { add("base", false, `injoignable (${e.name})`); }

  if (isProd) results.push({ name: "cible", ok: true, level: "info", detail: "production (lecture seule)" });
  return results;
}

export function renderReport(results, label) {
  const icon = { ok: "✅", echec: "❌", attention: "⚠️", info: "ℹ️" };
  const lines = [`Surveillance KlirProspect — ${label} — ${new Date().toISOString()}`, "", "| Contrôle | État | Détail |", "|---|---|---|"];
  for (const r of results) lines.push(`| ${r.name} | ${icon[r.level] ?? ""} | ${r.detail} |`);
  return lines.join("\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const results = await runChecks({
    supabaseUrl: env.MONITOR_SUPABASE_URL,
    anonKey: env.MONITOR_ANON_KEY ?? "",
    siteUrl: env.MONITOR_SITE_URL || "",
    access: { id: env.MONITOR_ACCESS_CLIENT_ID, secret: env.MONITOR_ACCESS_CLIENT_SECRET },
    siteStrict: env.MONITOR_SITE_STRICT === "true",
  });
  const failed = results.filter((r) => !r.ok);
  console.log(renderReport(results, env.MONITOR_LABEL || "cible"));
  process.exit(failed.length ? 1 : 0);
}
