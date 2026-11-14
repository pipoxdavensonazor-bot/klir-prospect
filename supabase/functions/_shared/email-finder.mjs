// Extraction des courriels publics professionnels, sur demande (phase 2, feu vert t120u).
// Pages lues : accueil + pages contact/à propos du même site, 4 au plus, délai court,
// robots.txt respecté, User-Agent identifiable, une page à la fois par site.
// Aucune clé ici : la base est appelée par les fonctions begin/finish injectées.

export const EMAIL_FINDER_UA = "KlirProspectBot/1.0 (+https://klirprospect.klirline.ca/ ; courriels publics professionnels ; retrait : contact@klirline.ca)";
export const MAX_PAGES = 4;
export const MAX_BATCH = 25;
export const PAGE_TIMEOUT_MS = 5000;
export const SITE_DEADLINE_MS = 15000;
export const BATCH_DEADLINE_MS = 100000;
export const PAGE_BYTES = 400 * 1024;
export const PAGE_GAP_MS = 250;
export const CONCURRENCY = 4;

const EMAIL_RE = /[a-z0-9._%+-]{1,64}@[a-z0-9-]{1,63}(?:\.[a-z0-9-]{1,63})*\.[a-z]{2,24}/gi;
const VALID_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}$/;
const ASSET_TLD = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|woff2?|ttf|mp4|pdf)$/i;
const BLOCKED_DOMAINS = [
  "example.com", "example.org", "domain.com", "email.com", "yourdomain.com", "votredomaine.com", "sentry.io",
  "wixpress.com", "sentry-next.wixpress.com", "godaddy.com", "squarespace.com", "wordpress.com", "shopify.com",
  "sentry.wixpress.com", "mysite.com", "test.com", "company.com"
];
const BLOCKED_LOCAL = /^(no-?reply|do-?not-?reply|nepasrepondre|ne-pas-repondre|mailer-daemon|postmaster|abuse|webmaster|privacy|gdpr|example|user|name|prenom|nom|votre|your)$/i;
const ROLE_LOCAL = /^(info|infos|contact|contacts|bonjour|hello|hi|allo|admin|administration|reservation|reservations|reception|accueil|sales|ventes|vente|service|services|serviceclient|support|office|bureau|commande|commandes|orders|events|evenements|booking|team|equipe|general|mail|courriel)$/i;
const FREEMAIL = /^(gmail\.com|hotmail\.(com|fr|ca)|outlook\.(com|fr)|live\.(com|ca|fr)|yahoo\.(com|ca|fr)|icloud\.com|videotron\.ca|bell\.net|sympatico\.ca|orange\.fr|free\.fr|sfr\.fr|wanadoo\.fr|laposte\.net|rogers\.com)$/i;
const CONTACT_LINK = /(contact|joindre|nous-joindre|nousjoindre|coordonn|about|a-propos|apropos|propos|qui-sommes|equipe|team|impressum|mentions-legales|reservation)/i;
const FALLBACK_PATHS = ["/contact", "/nous-joindre", "/contact-us", "/a-propos"];
const SOCIAL = /(^|\.)(facebook|fb|instagram|twitter|x|linkedin|tiktok|youtube|pinterest|yelp|tripadvisor|google|goo|linktr|wa)\.(com|me|ee|gl|ca|fr)$/i;

export function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "";
    return u.hostname.toLowerCase().replace(/^www\./, "");
  } catch { return ""; }
}

// Domaine de base approximatif (deux derniers libellés, trois pour .qc.ca/.co.uk).
export function baseDomain(host) {
  const parts = String(host || "").toLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (parts.length <= 2) return parts.join(".");
  const tail2 = parts.slice(-2).join(".");
  if (/^(qc|on|bc|ab|co|com|org|gouv)\.(ca|uk|fr)$/.test(tail2)) return parts.slice(-3).join(".");
  return tail2;
}

export function safeSiteUrl(website) {
  let u;
  try { u = new URL(String(website || "")); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  const h = u.hostname.toLowerCase();
  if (!h.includes(".") || h === "localhost" || /^[0-9.]+$/.test(h) || h.includes(":") || /\.(local|internal|lan)$/.test(h)) return null;
  if (SOCIAL.test(h.replace(/^www\./, "")) || SOCIAL.test(baseDomain(h))) return null;
  u.hash = "";
  return u;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function cleanEmail(raw) {
  let e = String(raw || "").trim().toLowerCase();
  e = e.replace(/^mailto:/, "").split("?")[0].replace(/^[.\-_]+|[.\-_]+$/g, "");
  try { e = decodeURIComponent(e); } catch {}
  e = e.trim();
  if (e.length > 254 || !VALID_EMAIL.test(e)) return "";
  const [local, domain] = e.split("@");
  if (!local || !domain || local.length > 64) return "";
  if (ASSET_TLD.test(domain) || /@\d+x\./.test(e) || /\.(png|jpe?g|gif|svg|webp)$/i.test(local)) return "";
  if (BLOCKED_LOCAL.test(local)) return "";
  if (BLOCKED_DOMAINS.some((d) => domain === d || domain.endsWith("." + d))) return "";
  if (/^[0-9a-f]{16,}$/.test(local)) return "";
  return e;
}

// Courriels d'une page : liens mailto, texte visible et champs "email" JSON-LD.
// Les adresses masquées (« info [at] ... ») et les images ne sont pas lues.
export function extractEmails(html, pageUrl) {
  const out = [];
  const seen = new Set();
  const push = (raw, via) => {
    const email = cleanEmail(raw);
    if (!email || seen.has(email)) return;
    seen.add(email);
    out.push({ email, source: pageUrl, via });
  };
  const source = String(html || "");
  for (const m of source.matchAll(/href\s*=\s*["']\s*mailto:([^"'?\s>]+)/gi)) push(decodeEntities(m[1]), "mailto");
  for (const m of source.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const e of m[1].matchAll(/"email"\s*:\s*"(?:mailto:)?([^"]+)"/gi)) push(e[1], "jsonld");
  }
  const visible = decodeEntities(
    source
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
  );
  for (const m of visible.matchAll(EMAIL_RE)) push(m[0], "text");
  return out;
}

export function scoreEmail(candidate, siteHost) {
  const [local, domain] = candidate.email.split("@");
  let score = 0;
  const site = baseDomain(siteHost);
  if (site && baseDomain(domain) === site) score += 4;
  else if (relatedDomain(domain, siteHost)) score += 3;
  else if (FREEMAIL.test(domain)) score += 1;
  if (ROLE_LOCAL.test(local)) score += 2;
  if (candidate.via === "mailto") score += 1;
  return score;
}

// Domaine apparenté : un mot d'au moins 5 lettres du nom de domaine du site
// se retrouve dans celui du courriel (ex. mexigrill.express / mexigrillmexicanfood.com).
export function relatedDomain(emailDomain, siteHost) {
  const label = (d) => baseDomain(d).split(".")[0] || "";
  const site = label(siteHost);
  const other = label(emailDomain);
  if (!site || !other) return false;
  return site.split(/[^a-z]+/).filter((t) => t.length >= 5).some((t) => other.includes(t))
    || other.split(/[^a-z]+/).filter((t) => t.length >= 5).some((t) => site.includes(t));
}

export function pickEmail(candidates, siteHost) {
  const site = baseDomain(siteHost);
  const usable = (candidates || []).filter((c) => {
    const domain = c.email.split("@")[1];
    return (site && baseDomain(domain) === site) || FREEMAIL.test(domain) || relatedDomain(domain, siteHost);
  });
  if (!usable.length) return null;
  return usable
    .map((c, i) => ({ c, i, s: scoreEmail(c, siteHost) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)[0].c;
}

export function contactLinks(html, baseUrl) {
  const base = new URL(baseUrl);
  const site = baseDomain(base.hostname);
  const out = [];
  for (const m of String(html || "").matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = decodeEntities(m[1]).trim();
    const label = m[2].replace(/<[^>]+>/g, " ");
    if (!CONTACT_LINK.test(href) && !CONTACT_LINK.test(label)) continue;
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    if (baseDomain(u.hostname) !== site) continue;
    if (ASSET_TLD.test(u.pathname)) continue;
    u.hash = "";
    const key = u.toString();
    if (key === base.toString() || out.includes(key)) continue;
    out.push(key);
  }
  return out.sort((a, b) => Number(/contact|joindre/i.test(b)) - Number(/contact|joindre/i.test(a)));
}

// robots.txt : groupe du robot (klirprospectbot) sinon « * » ; règle la plus longue gagne.
export function robotsAllows(text, path) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = line.match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent) { current = { agents: [], rules: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!current) continue;
      if (key === "allow" || key === "disallow") current.rules.push({ allow: key === "allow", path: value });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a && a !== "*" && "klirprospectbot".includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  let best = null;
  for (const g of chosen) {
    for (const r of g.rules) {
      if (!r.path) continue;
      const pattern = r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      const anchored = pattern.endsWith("\\$") ? pattern.slice(0, -2) + "$" : pattern;
      if (!new RegExp("^" + anchored).test(path)) continue;
      if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
    }
  }
  return !best || best.allow;
}

async function readLimited(response, limit) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    return text.slice(0, limit);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  try { await reader.cancel(); } catch {}
  const all = new Uint8Array(Math.min(size, limit));
  let offset = 0;
  for (const c of chunks) {
    const part = c.subarray(0, Math.max(0, all.length - offset));
    all.set(part, offset);
    offset += part.length;
    if (offset >= all.length) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(all);
}

export async function fetchPage(fetchImpl, url, timeoutMs, accept = "text/html") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": EMAIL_FINDER_UA, accept, "accept-language": "fr-CA,fr;q=0.9,en;q=0.7" }
    });
    const type = String(response.headers.get("content-type") || "");
    if (!response.ok) return { status: response.status, text: "", url: response.url || url };
    if (accept === "text/html" && type && !/html|xhtml/i.test(type)) return { status: response.status, text: "", url: response.url || url };
    return { status: response.status, text: await readLimited(response, PAGE_BYTES), url: response.url || url };
  } catch {
    return { status: 0, text: "", url };
  } finally {
    clearTimeout(timer);
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Une fiche : statut found | none | robots | unreachable | invalid.
export async function findEmailForSite(website, options = {}) {
  const fetchImpl = options.fetch || fetch;
  const now = options.now || (() => Date.now());
  const gap = options.gapMs ?? PAGE_GAP_MS;
  const deadline = now() + (options.deadlineMs ?? SITE_DEADLINE_MS);
  const site = safeSiteUrl(website);
  if (!site) return { status: "invalid", pages: 0 };
  const origin = site.origin;
  const robots = await fetchPage(fetchImpl, origin + "/robots.txt", 3000, "text/plain");
  if (robots.status >= 500 || robots.status === 0 && options.strictRobots) return { status: "robots", pages: 0, http: robots.status };
  const robotsText = robots.status >= 200 && robots.status < 300 ? robots.text : "";
  const allowed = (u) => { try { return robotsAllows(robotsText, new URL(u).pathname || "/"); } catch { return false; } };
  const home = site.toString();
  if (!allowed(home)) return { status: "robots", pages: 0 };

  const host = site.hostname;
  const candidates = [];
  const queue = [home];
  const visited = new Set();
  let pages = 0;
  let reached = false;
  let blocked = 0;
  let lastStatus = robots.status;
  while (queue.length && pages < MAX_PAGES && now() < deadline) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);
    if (!allowed(url)) { blocked += 1; continue; }
    if (pages > 0 && gap) await wait(gap);
    const remaining = Math.max(500, Math.min(PAGE_TIMEOUT_MS, deadline - now()));
    const page = await fetchPage(fetchImpl, url, remaining);
    pages += 1;
    lastStatus = page.status;
    if (!page.text) {
      if (pages === 1 && site.pathname !== "/" && !visited.has(origin + "/")) queue.unshift(origin + "/");
      continue;
    }
    reached = true;
    const pageUrl = /^https?:\/\//i.test(page.url) ? page.url : url;
    candidates.push(...extractEmails(page.text, pageUrl.slice(0, 300)));
    const best = pickEmail(candidates, host);
    if (best && baseDomain(best.email.split("@")[1]) === baseDomain(host) && ROLE_LOCAL.test(best.email.split("@")[0])) break;
    if (pages === 1 || (pages === 2 && url === origin + "/")) {
      const links = contactLinks(page.text, pageUrl);
      for (const l of links) if (!queue.includes(l)) queue.push(l);
      if (!links.length) for (const p of FALLBACK_PATHS) queue.push(new URL(p, origin).toString());
    }
  }
  const best = pickEmail(candidates, host);
  if (best) return { status: "found", email: best.email, source: best.source, pages };
  if (!reached) return { status: blocked && !pages ? "robots" : "unreachable", pages, http: lastStatus };
  return { status: "none", pages };
}

export async function runBatch(targets, options = {}) {
  const now = options.now || (() => Date.now());
  const deadline = now() + (options.batchDeadlineMs ?? BATCH_DEADLINE_MS);
  const results = new Array(targets.length);
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const index = next++;
      const t = targets[index];
      if (now() >= deadline) { results[index] = { id: t.id, status: "not_checked" }; continue; }
      const r = await findEmailForSite(t.website, { ...options, deadlineMs: Math.min(SITE_DEADLINE_MS, deadline - now()) });
      results[index] = { id: t.id, ...r };
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.concurrency ?? CONCURRENCY, targets.length) }, worker));
  return results;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function cleanRefs(body) {
  const refs = body && Array.isArray(body.refs) ? body.refs : null;
  if (!refs || refs.length < 1 || refs.length > MAX_BATCH) return null;
  const out = [];
  for (const r of refs) {
    if (r && UUID.test(String(r.id || ""))) out.push({ id: String(r.id).toLowerCase() });
    else if (r && UUID.test(String(r.job_id || "")) && typeof r.name === "string" && r.name.trim()) out.push({ job_id: String(r.job_id).toLowerCase(), name: r.name.slice(0, 160) });
    else return null;
  }
  return out;
}

export function newReceipt(randomBytes) {
  const bytes = randomBytes(12);
  return "email_" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Résultats envoyés à finish : trouvés, aucun, ou robots (fiche marquée vérifiée).
// Injoignable / non vérifié : non marqués, remboursés, nouvel essai possible.
export function settleItems(results) {
  return results
    .filter((r) => r && (r.status === "found" || r.status === "none" || r.status === "robots"))
    .map((r) => ({ id: r.id, email: r.status === "found" ? r.email : null, source: r.status === "found" ? r.source : null }));
}

const KNOWN_ERRORS = new Set(["credits_insuffisants", "limite_recherches_heure", "limite_recherches_jour", "selection_invalide"]);

export function errorCode(error) {
  const text = String(error && (error.message || error.code) || "");
  for (const code of KNOWN_ERRORS) if (text.includes(code)) return code;
  return "";
}

// Orchestration : begin (réserve), extraction, finish (facture les trouvés, rembourse le reste).
export async function handleEmailFinder({ userId, body, begin, finish, randomBytes, extract }) {
  const refs = cleanRefs(body);
  if (!refs) return { status: 400, body: { error: "selection_invalide" } };
  const receipt = newReceipt(randomBytes);
  let started;
  try {
    started = await begin(userId, receipt, refs);
  } catch (error) {
    const code = errorCode(error);
    return { status: code ? 409 : 502, body: { error: code || "service_indisponible" } };
  }
  const done = Array.isArray(started && started.done) ? started.done : [];
  const targets = Array.isArray(started && started.targets) ? started.targets : [];
  if (!targets.length || started.status !== "reserved") {
    return { status: 200, body: { charged: 0, refunded: 0, balance: started && started.balance, results: [], done } };
  }
  let results = [];
  try {
    results = await extract(targets);
  } catch {
    results = targets.map((t) => ({ id: t.id, status: "not_checked" }));
  }
  let settled;
  try {
    settled = await finish(userId, receipt, settleItems(results));
  } catch {
    return { status: 502, body: { error: "reglement_en_attente" } };
  }
  return {
    status: 200,
    body: {
      charged: settled.charged,
      refunded: settled.refunded,
      balance: settled.balance,
      results: results.map((r, i) => ({ id: r.id, job_id: targets[i] && targets[i].job_id || null, name: targets[i] && targets[i].name || null, status: r.status, http: Number.isInteger(r.http) ? r.http : undefined, email: r.status === "found" ? r.email : null, source: r.status === "found" ? r.source : null })),
      done
    }
  };
}
