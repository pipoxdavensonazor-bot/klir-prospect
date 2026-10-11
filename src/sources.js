var KlirSources = window.KlirSources || {};
(function () {
  const API = "https://recherche-entreprises.api.gouv.fr/search";
  function timeout(ms) { return new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)); }
  async function get(url) {
    const r = await Promise.race([fetch(url), timeout(12000)]);
    if (!r.ok) throw new Error("http " + r.status);
    return r.json();
  }
  async function test() {
    try { await get(API + "?q=test&per_page=1"); return "OK — API Sirene joignable."; }
    catch (e) { return "Échec : " + e.message + " (réseau ou CORS)."; }
  }
  function empRange(tr) {
    if (!tr || tr === "NN") return "1–10";
    const n = parseInt(tr, 10);
    if (isNaN(n)) return "1–10";
    if (n <= 3) return "1–10";
    if (n <= 12) return "11–50";
    if (n <= 22) return "51–200";
    if (n <= 32) return "201–500";
    return "500+";
  }
  function nafIndustry(code) {
    if (!code) return "services";
    if (/^4[1-3]/.test(code)) return "construction";
    if (/^4[5-7]/.test(code)) return "commerce";
    if (/^5[56]/.test(code)) return "restauration";
    if (/^5[89]|^6[0-3]/.test(code)) return "technologie";
    if (/^6[4-6]/.test(code)) return "finance";
    if (/^68/.test(code)) return "immobilier";
    if (/^8[6-8]/.test(code)) return "sante";
    return "services";
  }
  function mapDoc(d, ind, cityName) {
    const s = d.siege || {};
    const name = d.nom_raison_sociale || d.nom_complet || "Entreprise";
    const ik = ind || nafIndustry(d.activite_principale);
    const IL = (window.KlirData && window.KlirData.INDUSTRIES[ik]) || { label: "Services" };
    const signals = ["Registre officiel"];
    const dc = d.date_creation || s.date_creation;
    try {
      const t = new Date(dc).getTime();
      if (!isNaN(t) && (Date.now() - t) < 730 * 864e5) signals.push("Entreprise récente");
    } catch (e) {}
    if (s.adresse) signals.push("Adresse vérifiée");
    return {
      id: d.siren ? "sz_" + d.siren : window.KlirStore.uid("sz"),
      company_name: name, legal_name: d.nom_complet || name,
      website: "", domain: "",
      industry: IL.label, industry_key: ik,
      description: "NAF " + (d.activite_principale || "—") + (d.categorie_entreprise ? " • " + d.categorie_entreprise : ""),
      address: s.adresse || "", city: s.libelle_commune || cityName || "",
      province: s.departement || "", country: "France", postal_code: s.code_postal || "",
      phone: "", public_email: "", social_links: {},
      employee_range: empRange(d.tranche_effectif_salarie || s.tranche_effectif_salarie),
      source: "Sirene (data.gouv.fr)", source_url: "https://annuaire-entreprises.data.gouv.fr/etablissement/" + (s.siret || d.siren || ""),
      last_verified: new Date().toISOString().slice(0, 10), signals: signals
    };
  }
  async function search(params, maxN) {
    const city = (params.city && params.city.city) || "";
    const sector = params.industry && params.industry !== "all" ? params.industry : "";
    const ind = window.KlirData && sector ? window.KlirData.INDUSTRIES[sector] : null;
    const kw = ind ? ind.domains[0] : "entreprise";
    const q = encodeURIComponent(kw + " " + city);
    const out = [];
    const pages = Math.min(3, Math.ceil((maxN || 40) / 20));
    for (let p = 1; p <= pages; p++) {
      const j = await get(API + "?q=" + q + "&per_page=20&page=" + p);
      for (const d of (j.results || [])) out.push(mapDoc(d, sector, city));
      if (!j.results || j.results.length < 20) break;
    }
    return out.slice(0, maxN || 40);
  }
  KlirSources.sirene = { test, search };
  let lastOsm = 0;
  async function osmLookup(q) {
    const wait = 1200 - (Date.now() - lastOsm);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    lastOsm = Date.now();
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 10000);
    try {
      const r = await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=" + encodeURIComponent(q), { signal: ctl.signal, headers: { Accept: "application/json" } });
      if (!r.ok) throw new Error("http " + r.status);
      const j = await r.json();
      if (!j || !j.length) return null;
      return { lat: j[0].lat, lng: j[0].lon, label: j[0].display_name };
    } finally { clearTimeout(to); }
  }
  const CONSTRUCTION_BASE_CRAFTS = ["builder", "electrician", "plumber", "roofer", "painter", "carpenter"];
  const CONSTRUCTION_RENOVATION_CRAFTS = ["plasterer", "tiler", "glazier", "window_construction", "insulation", "parquet_layer", "joiner", "stonemason", "scaffolder", "hvac", "floorer"];
  const CONSTRUCTION_CRAFTS = CONSTRUCTION_BASE_CRAFTS.concat(CONSTRUCTION_RENOVATION_CRAFTS);
  const MONTREAL_ISLAND_BOUNDS = { south: 45.4102, west: -73.9744, north: 45.7058, east: -73.4742 };
  const OSM_FILTERS = {
    restauration: ['["amenity"~"^(restaurant|cafe|fast_food|bar|pub)$"]'],
    sante: ['["amenity"~"^(clinic|doctors|dentist|pharmacy|hospital)$"]'],
    immobilier: ['["office"="estate_agent"]'],
    finance: ['["amenity"~"^(bank|bureau_de_change)$"]', '["office"~"^(financial|insurance|accountant|tax_advisor)$"]'],
    construction: ['["craft"~"^(' + CONSTRUCTION_CRAFTS.join("|") + ')$"]', '["office"="construction_company"]'],
    technologie: ['["office"~"^(it|telecommunication)$"]', '["shop"~"^(computer|electronics|mobile_phone)$"]'],
    commerce: ['["shop"]'],
    services: ['["office"]', '["craft"]'],
    all: ['["shop"]', '["amenity"]', '["office"]', '["craft"]']
  };
  function publishedUrl(value) {
    const raw = String(value || "").trim();
    if (!/^https?:\/\//i.test(raw)) return "";
    try {
      const url = new URL(raw);
      if (url.username || url.password) return "";
      return url.href;
    } catch (error) {
      return "";
    }
  }
  function publishedEmail(value) {
    const raw = String(value || "").trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : "";
  }
  function publishedPhone(value) {
    const raw = String(value || "").trim();
    return /[0-9]/.test(raw) && raw.length <= 40 ? raw : "";
  }
  function industryFromTags(tags, requested) {
    if (requested && requested !== "all" && window.KlirData && window.KlirData.INDUSTRIES[requested]) return requested;
    const blob = [tags.amenity, tags.shop, tags.office, tags.craft].filter(Boolean).join(" ");
    if (/restaurant|cafe|fast_food|bar|pub/.test(blob)) return "restauration";
    if (/clinic|doctors|dentist|pharmacy|hospital/.test(blob)) return "sante";
    if (/estate_agent/.test(blob)) return "immobilier";
    if (/bank|insurance|financial|accountant/.test(blob)) return "finance";
    if (CONSTRUCTION_CRAFTS.indexOf(String(tags.craft || "")) >= 0 || String(tags.office || "") === "construction_company") return "construction";
    if (/^it$|telecommunication|computer|electronics/.test(blob)) return "technologie";
    if (tags.shop) return "commerce";
    return "services";
  }
  function mapOsmElement(element, params) {
    const tags = element && element.tags ? element.tags : {};
    const name = String(tags.name || "").trim();
    if (!name || !element.id) return null;
    const city = params && params.city ? params.city : {};
    const key = industryFromTags(tags, params && params.industry);
    const row = window.KlirData && window.KlirData.INDUSTRIES[key];
    const website = publishedUrl(tags.website || tags["contact:website"] || tags.url);
    let domain = "";
    try { domain = website ? new URL(website).hostname.replace(/^www\./, "") : ""; } catch (error) { domain = ""; }
    const street = [tags["addr:housenumber"], tags["addr:street"]].filter(Boolean).join(" ");
    return {
      id: "osm_" + (element.type || "node") + "_" + element.id,
      company_name: name,
      legal_name: name,
      website: website,
      domain: domain,
      industry: row ? row.label : key,
      industry_key: key,
      description: [tags.amenity || tags.shop || tags.office || tags.craft || "", city.city || ""].filter(Boolean).join(" — "),
      address: street,
      city: tags["addr:city"] || city.city || "",
      province: city.province || "",
      country: city.country || "",
      postal_code: tags["addr:postcode"] || "",
      phone: publishedPhone(tags.phone || tags["contact:phone"]),
      public_email: publishedEmail(tags.email || tags["contact:email"]),
      social_links: {},
      employee_range: "",
      source: "OpenStreetMap",
      source_url: "https://www.openstreetmap.org/" + (element.type || "node") + "/" + element.id,
      last_verified: "",
      signals: ["Source ouverte"]
    };
  }
  function foldedCity(params) {
    const name = params && params.city ? String(params.city.city || "") : "";
    return name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }
  function resolveArea(params) {
    const requested = params && params.area === "montreal_island" ? "montreal_island" : "radius";
    if (requested === "montreal_island" && foldedCity(params) === "montreal") {
      return { requested: requested, used: "montreal_island", bounds: MONTREAL_ISLAND_BOUNDS };
    }
    return { requested: requested, used: "radius", bounds: null };
  }
  function overpassQuery(params, limit) {
    const city = params && params.city;
    const lat = Number(city && city.lat);
    const lng = Number(city && city.lng);
    const industry = params.industry && OSM_FILTERS[params.industry] ? params.industry : "all";
    const area = resolveArea(params);
    let clause;
    if (area.used === "montreal_island") {
      const bounds = area.bounds;
      clause = "(" + bounds.south + "," + bounds.west + "," + bounds.north + "," + bounds.east + ")";
    } else {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("Cette ville n'a pas de coordonnées pour OpenStreetMap.");
      const radius = industry === "all" ? 1500 : 2200;
      const around = "(around:" + radius + "," + lat + "," + lng + ")";
      clause = around;
    }
    const types = industry === "construction" ? ["node", "way", "relation"] : ["node"];
    const body = OSM_FILTERS[industry].map(function (filter) {
      return types.map(function (type) {
        return type + "[\"name\"]" + filter + clause + ";";
      }).join("");
    }).join("");
    return "[out:json][timeout:15];(" + body + ");out tags " + limit + ";";
  }
  function overpassCoverage(payload) {
    const raw = payload && payload.remark;
    const remark = raw == null ? "" : String(raw).trim().slice(0, 500);
    if (remark) return { status: "partial", remark: remark };
    return { status: "complete", remark: "" };
  }
  function publishedToken(kind, value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    if (kind === "phone") return raw.replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
    if (kind === "email") return raw.toLowerCase();
    if (kind === "domain") return raw.toLowerCase().replace(/^www\./, "");
    return raw.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim();
  }
  function publishedName(row) {
    return publishedToken("text", row && row.company_name).replace(/\b(inc|ltee|sarl|sas|llc|corp)\b/g, "").replace(/\s+/g, " ").trim();
  }
  function identityPairs(row) {
    return [
      publishedToken("phone", row && row.phone),
      publishedToken("email", row && row.public_email),
      publishedToken("domain", row && (row.domain || row.website)),
      publishedToken("text", row && row.address)
    ];
  }
  function publishedConflict(a, b) {
    const left = identityPairs(a);
    const right = identityPairs(b);
    return left.some(function (value, index) { return value && right[index] && value !== right[index]; });
  }
  function samePublishedBusiness(a, b) {
    const name = publishedName(a);
    if (!name || name !== publishedName(b) || publishedConflict(a, b)) return false;
    const left = identityPairs(a);
    const right = identityPairs(b);
    return left.some(function (value, index) { return value && value === right[index]; });
  }
  function rememberPublished(row, idKey) {
    row.osm_ids = row.osm_ids || [];
    if (idKey && row.osm_ids.indexOf(idKey) < 0) row.osm_ids.push(idKey);
    row.field_sources = row.field_sources || {};
    ["phone", "public_email", "website", "domain", "address", "postal_code"].forEach(function (field) {
      if (row[field] && !row.field_sources[field]) row.field_sources[field] = idKey;
    });
  }
  function absorbPublished(keep, extra, idKey) {
    ["phone", "public_email", "website", "domain", "address", "postal_code"].forEach(function (field) {
      if (!keep[field] && extra[field]) {
        keep[field] = extra[field];
        keep.field_sources[field] = idKey;
      }
    });
    rememberPublished(keep, idKey);
  }
  function overpassRetryDelay(response) {
    const fallback = 8000;
    const cap = 30000;
    const header = response && response.headers && response.headers.get ? response.headers.get("Retry-After") : "";
    if (!header) return fallback;
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(Math.round(seconds * 1000), cap);
    const when = Date.parse(header);
    if (!Number.isNaN(when)) return Math.min(Math.max(0, when - Date.now()), cap);
    return fallback;
  }
  function overpassLog(status, attempt, durationMs) {
    console.info("[overpass] " + JSON.stringify({ status: status, attempt: attempt, durationMs: durationMs }));
  }
  async function askOverpass(query) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const started = Date.now();
      const ctl = new AbortController();
      const to = setTimeout(function () { ctl.abort(); }, 18000);
      let retryable = false;
      let delay = 8000;
      try {
        const response = await fetch("https://overpass-api.de/api/interpreter", {
          method: "POST",
          signal: ctl.signal,
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "KlirProspect/0.1 (https://klirprospect.klirline.ca)" },
          body: "data=" + encodeURIComponent(query)
        });
        const durationMs = Date.now() - started;
        overpassLog(response.status, attempt + 1, durationMs);
        if (response.status === 429 || response.status >= 500) {
          retryable = true;
          delay = overpassRetryDelay(response);
          const code = response.status === 429 ? "429" : String(response.status);
          lastError = new Error("Recherche échouée : OpenStreetMap a répondu " + code + ".");
        } else if (!response.ok) {
          throw new Error("Recherche échouée : OpenStreetMap a répondu " + response.status + ".");
        } else {
          try {
            return await response.json();
          } catch (parseError) {
            throw new Error("Recherche échouée : réponse OpenStreetMap invalide.");
          }
        }
      } catch (error) {
        if (error && error.message && error.message.indexOf("Recherche échouée") === 0) throw error;
        overpassLog(0, attempt + 1, Date.now() - started);
        lastError = new Error(error && error.name === "AbortError" ? "Recherche échouée : OpenStreetMap n'a pas répondu à temps." : "Recherche échouée : OpenStreetMap est indisponible.");
        retryable = true;
      } finally {
        clearTimeout(to);
      }
      if (!retryable || attempt === 1) break;
      await new Promise(function (resolve) { setTimeout(resolve, delay); });
    }
    throw lastError || new Error("Recherche échouée : OpenStreetMap est indisponible.");
  }
  async function searchPlaces(params, maxN) {
    const limit = Math.min(40, Math.max(5, maxN || 20));
    const payload = await askOverpass(overpassQuery(params, limit));
    const area = resolveArea(params);
    const coverage = overpassCoverage(payload);
    coverage.area = area.used;
    coverage.areaRequested = area.requested;
    coverage.areaFallback = area.requested === "montreal_island" && area.used !== "montreal_island";
    const rows = [];
    const byOsmId = new Map();
    for (const element of payload.elements || []) {
      if (!element || element.id == null) continue;
      const idKey = (element.type || "node") + "/" + element.id;
      const row = mapOsmElement(element, params);
      if (!row) continue;
      rememberPublished(row, idKey);
      const prior = byOsmId.get(idKey);
      if (prior) {
        absorbPublished(prior, row, idKey);
        continue;
      }
      const twin = rows.find(function (existing) { return samePublishedBusiness(existing, row); });
      if (twin) {
        absorbPublished(twin, row, idKey);
        byOsmId.set(idKey, twin);
        continue;
      }
      byOsmId.set(idKey, row);
      rows.push(row);
      if (rows.length >= limit) break;
    }
    rows.osmCoverage = coverage;
    return rows;
  }
  KlirSources.osm = {
    lookup: osmLookup,
    search: searchPlaces,
    mapElement: mapOsmElement,
    query: overpassQuery,
    constructionCrafts: CONSTRUCTION_CRAFTS,
    renovationCrafts: CONSTRUCTION_RENOVATION_CRAFTS,
    areas: { montreal_island: MONTREAL_ISLAND_BOUNDS }
  };
  window.KlirSources = KlirSources;
})();
