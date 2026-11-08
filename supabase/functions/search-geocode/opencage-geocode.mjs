// Géocodage ponctuel OpenCage, côté serveur seulement.
// La clé reste dans l'environnement transmis par l'appelant. Elle n'est pas
// écrite dans le résultat, le cache, ni les messages. Aucun appel si elle manque.
// Ce module n'est pas importé par le navigateur.

export const OPENCAGE_SECRET = "OPENCAGE_API_KEY";
export const OPENCAGE_ENDPOINT = "https://api.opencagedata.com/geocode/v1/json";
export const OSM_ATTRIBUTION = "Geodata copyright OpenStreetMap contributors";
export const OSM_ATTRIBUTION_FR = "Géodonnées © les contributeurs OpenStreetMap";

const RESULT_LIMIT = 5;
const TIMEOUT_MS = 4000;
const MIN_INTERVAL_MS = 1000;
const DEFAULT_BUDGET = 8;
const MAX_QUERY = 200;

function fold(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function refuse(outcome, extra = {}) {
  return { ok: false, outcome, operational: false, provider: "opencage", ...extra };
}

function redact(text, key) {
  const raw = String(text || "");
  if (!key) return raw.slice(0, 180);
  return raw.split(key).join("[secret]").slice(0, 180);
}

function countryOf(components) {
  const code = components && components.country_code;
  return typeof code === "string" && /^[a-z]{2}$/i.test(code) ? code.toUpperCase() : "";
}

function localityOf(components) {
  if (!components || typeof components !== "object") return "";
  for (const field of ["city", "town", "village", "municipality", "county"]) {
    if (typeof components[field] === "string" && components[field].trim()) return components[field].trim();
  }
  return "";
}

export function publicCandidate(result, licenses) {
  const geometry = result && result.geometry || {};
  const components = result && result.components || {};
  const latitude = Number(geometry.lat);
  const longitude = Number(geometry.lng);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    formatted: typeof result.formatted === "string" ? result.formatted : "",
    countryCode: countryOf(components),
    country: typeof components.country === "string" ? components.country : "",
    locality: localityOf(components),
    latitude,
    longitude,
    confidence: Number.isInteger(result.confidence) ? result.confidence : null,
    placeType: typeof components._type === "string" ? components._type : "",
    licenses: Array.isArray(licenses) ? licenses.filter((item) => item && item.name).map((item) => ({ name: String(item.name), url: String(item.url || "") })) : [],
    attribution: OSM_ATTRIBUTION,
    attributionFr: OSM_ATTRIBUTION_FR,
    permanentId: null,
    boundary: null
  };
}

function cacheKey(query, countryCode, language) {
  return [fold(query), fold(countryCode), fold(language)].join("|");
}

export function exportCache(entries) {
  return {
    version: 1,
    provider: "opencage",
    attribution: OSM_ATTRIBUTION,
    attributionFr: OSM_ATTRIBUTION_FR,
    entries: entries.map((entry) => ({
      query: entry.query,
      countryCode: entry.countryCode,
      language: entry.language,
      storedAt: entry.storedAt,
      outcome: entry.outcome,
      candidates: entry.candidates
    }))
  };
}

export function createOpenCageGeocoder(options = {}) {
  const env = options.env || {};
  const key = typeof env[OPENCAGE_SECRET] === "string" ? env[OPENCAGE_SECRET].trim() : "";
  const fetchImpl = options.fetch || globalThis.fetch;
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const now = options.now || (() => new Date().toISOString());
  const clock = options.clock || (() => Date.now());
  const budget = Number.isInteger(options.budget) ? options.budget : DEFAULT_BUDGET;
  const entries = new Map();
  for (const entry of options.cache && Array.isArray(options.cache.entries) ? options.cache.entries : []) {
    entries.set(cacheKey(entry.query, entry.countryCode, entry.language), entry);
  }
  let spent = 0;
  let lastNetworkAt = 0;

  async function request(url, attempt) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      const coded = body && body.status && Number.isInteger(body.status.code) ? body.status.code : response.status;
      if ((coded === 429 || coded >= 500) && attempt === 0) {
        await sleep(MIN_INTERVAL_MS);
        return request(url, 1);
      }
      return { status: coded, body };
    } catch (error) {
      if (error && error.name === "AbortError") return { status: 0, body: null, outcome: "delai_depasse" };
      return { status: 0, body: null, outcome: "panne", detail: redact(error && error.message, key) };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    operational: false,
    secret: OPENCAGE_SECRET,
    hasKey: key !== "",
    exportCache() {
      return exportCache([...entries.values()]);
    },
    async lookup(input = {}) {
      const usage = String(input.usage || "ponctuel");
      if (usage !== "ponctuel") return refuse("geocodage_systematique_refuse");
      const query = String(input.query || "").normalize("NFC").trim();
      if (query.length < 3 || query.length > MAX_QUERY) return refuse("requete_incomplete");
      if (!key) return refuse("cle_absente", { secret: OPENCAGE_SECRET });
      const countryCode = String(input.countryCode || "").trim().toLowerCase();
      const language = String(input.language || "").trim().toLowerCase();
      if (countryCode && !/^[a-z]{2}$/.test(countryCode)) return refuse("pays_invalide");
      if (language && !/^[a-z]{2}$/.test(language)) return refuse("langue_invalide");
      const keyName = cacheKey(query, countryCode, language);
      if (entries.has(keyName)) {
        const cached = entries.get(keyName);
        return finish(query, countryCode, language, cached.candidates, input.confirmation, true, language);
      }
      if (spent >= budget) return refuse("budget_local_atteint");
      const wait = MIN_INTERVAL_MS - (clock() - lastNetworkAt);
      if (lastNetworkAt && wait > 0) await sleep(wait);
      const params = new URLSearchParams({
        q: query,
        key,
        no_annotations: "1",
        limit: String(RESULT_LIMIT),
        abbrv: "0"
      });
      if (countryCode) params.set("countrycode", countryCode);
      if (language) params.set("language", language);
      spent += 1;
      lastNetworkAt = clock();
      const response = await request(`${OPENCAGE_ENDPOINT}?${params.toString()}`, 0);
      if (response.outcome) return refuse(response.outcome, response.detail ? { detail: response.detail } : {});
      const providerCode = response.status;
      if (providerCode === 402) return refuse("quota_fournisseur");
      if (providerCode === 401 || providerCode === 403) return refuse("acces_refuse");
      if (providerCode === 429) return refuse("limite_debit");
      if (providerCode === 400) return refuse("requete_invalide");
      if (providerCode !== 200) return refuse("reponse_inattendue");
      const reported = response.body && Number.isInteger(response.body.total_results) ? response.body.total_results : null;
      const licenses = response.body && response.body.licenses;
      const results = reported === 0 ? [] : response.body && Array.isArray(response.body.results) ? response.body.results : [];
      const candidates = results.map((item) => publicCandidate(item, licenses)).filter(Boolean).slice(0, RESULT_LIMIT);
      const stored = {
        query,
        countryCode,
        language,
        storedAt: now(),
        outcome: candidates.length === 0 ? "introuvable" : candidates.length === 1 ? "a_confirmer" : "ambigu",
        candidates
      };
      entries.set(keyName, stored);
      return finish(query, countryCode, language, candidates, input.confirmation, false, language);
    }
  };
}

function finish(query, countryCode, language, candidates, confirmation, cached) {
  const base = {
    ok: true,
    operational: false,
    provider: "opencage",
    usage: "ponctuel",
    query,
    countryCode: countryCode.toUpperCase(),
    language,
    cached,
    attribution: OSM_ATTRIBUTION,
    attributionFr: OSM_ATTRIBUTION_FR,
    candidates
  };
  if (candidates.length === 0) return { ...base, ok: false, outcome: "introuvable" };
  if (candidates.length > 1 && !confirmation) return { ...base, outcome: "ambigu" };
  const confirmed = matchConfirmation(candidates, confirmation, language);
  if (!confirmation) return { ...base, outcome: "a_confirmer" };
  if (!confirmed) return { ...base, ok: false, outcome: "confirmation_refusee" };
  return { ...base, outcome: "confirme", selected: confirmed };
}

function matchConfirmation(candidates, confirmation, language) {
  if (!confirmation || typeof confirmation !== "object") return null;
  const country = String(confirmation.countryCode || "").toUpperCase();
  const formatted = String(confirmation.formatted || "");
  const confirmedLanguage = String(confirmation.language || "").toLowerCase();
  if (!language || confirmedLanguage !== language) return null;
  if (!/^[A-Z]{2}$/.test(country) || !formatted) return null;
  return candidates.find((item) => item.countryCode === country && item.formatted === formatted) || null;
}
