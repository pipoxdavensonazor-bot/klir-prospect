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
    const ind = window.KlirData ? window.KlirData.INDUSTRIES[params.industry] : null;
    const kw = ind ? ind.domains[0] : "entreprise";
    const q = encodeURIComponent(kw + " " + city);
    const out = [];
    const pages = Math.min(3, Math.ceil((maxN || 40) / 20));
    for (let p = 1; p <= pages; p++) {
      const j = await get(API + "?q=" + q + "&per_page=20&page=" + p);
      for (const d of (j.results || [])) out.push(mapDoc(d, params.industry, city));
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
  KlirSources.osm = { lookup: osmLookup };
  window.KlirSources = KlirSources;
})();
