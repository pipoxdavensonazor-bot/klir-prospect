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
  const OSM_FILTERS = {
    restauration: ['["amenity"~"^(restaurant|cafe|fast_food|bar|pub)$"]'],
    sante: ['["amenity"~"^(clinic|doctors|dentist|pharmacy|hospital)$"]'],
    immobilier: ['["office"="estate_agent"]'],
    finance: ['["amenity"~"^(bank|bureau_de_change)$"]', '["office"~"^(financial|insurance|accountant|tax_advisor)$"]'],
    construction: ['["craft"~"^(builder|electrician|plumber|roofer|painter|carpenter)$"]', '["office"="construction_company"]'],
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
    if (/builder|electrician|plumber|roofer|painter|carpenter|construction/.test(blob)) return "construction";
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
      last_verified: new Date().toISOString().slice(0, 10),
      signals: ["Source ouverte"]
    };
  }
  function overpassQuery(params, limit) {
    const city = params && params.city;
    const lat = Number(city && city.lat);
    const lng = Number(city && city.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw new Error("Cette ville n'a pas de coordonnées pour OpenStreetMap.");
    const industry = params.industry && OSM_FILTERS[params.industry] ? params.industry : "all";
    const radius = industry === "all" ? 1500 : 2200;
    const around = "(around:" + radius + "," + lat + "," + lng + ")";
    const body = OSM_FILTERS[industry].map(function (filter) {
      return "node[\"name\"]" + filter + around + ";";
    }).join("");
    return "[out:json][timeout:15];(" + body + ");out tags " + limit + ";";
  }
  async function askOverpass(query) {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctl = new AbortController();
      const to = setTimeout(function () { ctl.abort(); }, 18000);
      try {
        const response = await fetch("https://overpass-api.de/api/interpreter", {
          method: "POST",
          signal: ctl.signal,
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "KlirProspect/0.1 (https://klirprospect.klirline.ca)" },
          body: "data=" + encodeURIComponent(query)
        });
        if (response.status === 429 || response.status >= 500) {
          lastError = new Error("OpenStreetMap est momentanément saturé.");
        } else if (!response.ok) {
          throw new Error("OpenStreetMap a répondu " + response.status + ".");
        } else {
          return await response.json();
        }
      } catch (error) {
        lastError = error && error.name === "AbortError" ? new Error("OpenStreetMap n'a pas répondu à temps.") : error;
      } finally {
        clearTimeout(to);
      }
      await new Promise(function (resolve) { setTimeout(resolve, 1500); });
    }
    throw lastError || new Error("OpenStreetMap est indisponible.");
  }
  async function searchPlaces(params, maxN) {
    const limit = Math.min(40, Math.max(5, maxN || 20));
    const payload = await askOverpass(overpassQuery(params, limit));
    const rows = [];
    for (const element of payload.elements || []) {
      const row = mapOsmElement(element, params);
      if (row) rows.push(row);
      if (rows.length >= limit) break;
    }
    return rows;
  }
  KlirSources.osm = { lookup: osmLookup, search: searchPlaces, mapElement: mapOsmElement, query: overpassQuery };
  window.KlirSources = KlirSources;
})();
