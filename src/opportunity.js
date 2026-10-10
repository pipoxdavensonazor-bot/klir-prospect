var OPP_V = "opportunity_engine_v1";
var OPP_SERVICES = {
  KLIRBUILD: {label: "KlirBuild", action: "Contacter pour proposer une démonstration KlirBuild."},
  KLIRLINE: {label: "Klirline OS", action: "Proposer une démonstration Klirline OS."},
  KLIRIA: {label: "Klir IA", action: "Proposer une démonstration de Klir IA."},
  KLIRPROMO: {label: "KlirPromo", action: "Proposer un audit de présence numérique."},
  KLIRPAY: {label: "KlirPay", action: "Proposer une démonstration KlirPay."},
  KLIRMARKET: {label: "KlirMarket", action: "Proposer l'accompagnement marketplace KlirMarket."}
};
function oppCfg(){var KS = window.KlirStore;var d = {formula: {icp: 0.30, signal: 0.25, need: 0.25, service: 0.20},thresholds: {veryHigh: 90, high: 75, medium: 60},serviceMin: {strong: 70, possible: 50},signalW: {no_active_website: 25, website_inactive: 20, weak_digital_presence: 15, https_issue: 10, weak_social_presence: 10, low_content_activity: 8, weak_local_visibility: 8, hiring_signal: 15, expansion_signal: 15, new_service: 12, multiple_locations: 10, new_business: 12, construction_fit: 15, growth_signal: 12, fragmented_presence: 10},groupCap: {digital: 30, growth: 25}};if (!KS.S.oppCfg) KS.S.oppCfg = d;else {KS.S.oppCfg.formula = Object.assign({}, d.formula, KS.S.oppCfg.formula || {});KS.S.oppCfg.thresholds = Object.assign({}, d.thresholds, KS.S.oppCfg.thresholds || {});KS.S.oppCfg.serviceMin = Object.assign({}, d.serviceMin, KS.S.oppCfg.serviceMin || {});KS.S.oppCfg.signalW = Object.assign({}, d.signalW, KS.S.oppCfg.signalW || {});KS.S.oppCfg.groupCap = Object.assign({}, d.groupCap, KS.S.oppCfg.groupCap || {});}return KS.S.oppCfg;}
function oppText(p){return ((p.company_name || "") + " " + (p.description || "") + " " + (p.industry || "")).toLowerCase();}
function oppHas(p, re){return re.test(oppText(p));}
function detectSignals(p, params){var W = oppCfg().signalW;var S = [];var now = new Date().toISOString();
  function add(type, name, evidence, source, confidence, weight, group){S.push({signal_type: type, signal_name: name, evidence: evidence, source: source, detected_at: now, confidence: confidence, weight: weight, group: group});}
  var hasDom = !!(p.domain || p.website || p.domain_name);
  var ws = p.website_status || "UNKNOWN";
  if (!hasDom) add("digital_presence", "no_active_website", "Aucun domaine renseigné sur la fiche", "fiche prospect", 0.90, W.no_active_website, "digital");
  else if (ws === "AVAILABLE") add("digital_presence", "no_active_website", "Domaine potentiellement disponible (source registre/RDAP)", p.domain_source || "RDAP", 0.85, W.no_active_website, "digital");
  else if (ws === "INACTIVE" || ws === "REGISTERED_INACTIVE") add("digital_presence", "website_inactive", "Domaine enregistré mais aucun site web actif détecté", "Website Intelligence", 0.88, W.website_inactive, "digital");
  else if (ws === "UNKNOWN") add("digital_presence", "weak_digital_presence", "Présence numérique limitée : statut du site invérifiable", "Website Intelligence", 0.55, W.weak_digital_presence, "digital");
  if (p.website_https === false) add("digital_presence", "https_issue", "HTTPS non détecté sur le site", "Website Intelligence", 0.75, W.https_issue, "digital");
  if (!p.public_email) add("digital_presence", "missing_business_information", "Aucun e-mail professionnel public renseigné", "fiche prospect", 0.80, 6, "digital");
  if (!p.social_links || !Object.keys(p.social_links).length) add("marketing", "weak_social_presence", "Aucun réseau social public détecté", "fiche prospect", 0.70, W.weak_social_presence, "marketing");
  if ((p.signals || []).includes("Présence numérique active")) add("marketing", "visible_online", "Présence numérique active détectée", "fiche prospect", 0.70, 0, "marketing");
  else add("marketing", "low_content_activity", "Activité de contenu limitée détectée", "fiche prospect", 0.60, W.low_content_activity, "marketing");
  if (!hasDom || ws !== "ACTIVE") add("marketing", "weak_local_visibility", "Visibilité locale potentiellement limitée (site non actif)", "Website Intelligence", 0.60, W.weak_local_visibility, "marketing");
  if ((p.signals || []).includes("Recrutement")) add("growth", "hiring_signal", "Signal recrutement détecté", "fiche prospect", 0.70, W.hiring_signal, "growth");
  if ((p.signals || []).includes("Expansion")) add("growth", "expansion_signal", "Signal expansion détecté", "fiche prospect", 0.70, W.expansion_signal, "growth");
  if ((p.signals || []).includes("Entreprise récente")) add("growth", "new_business", "Entreprise récente", "fiche prospect", 0.75, W.new_business, "growth");
  if ((p.signals || []).includes("Nouveau site")) add("growth", "new_service", "Nouveau site / nouveau service détecté", "fiche prospect", 0.65, W.new_service, "growth");
  if ((p.employee_range === "51–200" || p.employee_range === "201–500" || p.employee_range === "500+")) add("growth", "multiple_locations", "Taille d'entreprise compatible multi-sites", "fiche prospect", 0.55, W.multiple_locations, "growth");
  var ik = p.industry_key || (params && params.industry) || "";
  if (ik === "construction" || oppHas(p, /construction|rénovation|renovation|entrepreneur|contracteur|contractor|plomberie|plumbing|électricité|electrical|toiture|roofing|maçonnerie|peinture|bâtiment|architecture|ingénierie|engineering|sous-traitant|subcontract/)) add("construction", "construction_fit", "Profil bâtiment / construction détecté", "fiche prospect", 0.90, W.construction_fit, "construction");
  if ((p.signals || []).length >= 3) add("digitalization", "fragmented_presence", "Présence publique fragmentée (plusieurs signaux)", "fiche prospect", 0.60, W.fragmented_presence, "digitalization");
  if (!hasDom || (p.signals || []).length <= 1) add("digitalization", "limited_digital_presence", "Présence numérique limitée détectée", "Website Intelligence", 0.65, 8, "digitalization");
  return S;}
function scoreIcp(p, params){var s = 0;var ind = (params && params.industry) || p.industry_key;var city = params && params.city ? params.city.city : null;
  if (!ind || ind === "all" || (p.industry_key && p.industry_key === ind)) s += 25;else if (p.industry) s += 8;
  if (city && p.city === city) s += 20;else if (p.city) s += 6;
  if (p.legal_name && p.legal_name !== p.company_name) s += 15;else if (p.company_name) s += 8;
  if (params && params.size && p.employee_range === params.size) s += 15;else if (p.employee_range) s += 8;
  if (/construction|technologie|commerce|services|immobilier|restauration|sante|finance/.test(p.industry_key || "")) s += 15;else s += 7;
  var contact = (p.phone ? 4 : 0) + (p.public_email ? 3 : 0) + (p.website ? 3 : 0);s += Math.min(10, contact + 2);
  return Math.min(100, Math.round(s));}
function scoreSignals(signals, confidence){var cfg = oppCfg();var dampen = (confidence != null && confidence < 50) ? 0.5 : 1;var byGroup = {};var total = 0;
  for (const g of signals) {var w = (cfg.signalW[g.signal_name] != null ? cfg.signalW[g.signal_name] : (g.weight || 5)) * (g.confidence >= 0.8 ? 1 : 0.7) * dampen;byGroup[g.group] = (byGroup[g.group] || 0) + w;}
  for (const k of Object.keys(byGroup)) {var cap = cfg.groupCap[k];if (cap != null) byGroup[k] = Math.min(cap, byGroup[k]);total += byGroup[k];}
  return {score: Math.min(100, Math.round(total * 2.2)), total: Math.round(total), byGroup: byGroup};}
function scoreNeeds(p, signals){var names = signals.map(g => g.signal_name);var has = n => names.includes(n);var ik = p.industry_key || "";
  var digital = 50;if (has("no_active_website")) digital = 85;else if (has("website_inactive")) digital = 80;else if (has("weak_digital_presence")) digital = 65;else if ((p.website_status || "") === "ACTIVE") digital = 20;if (p.website_https === false) digital = Math.max(digital, 60);
  var marketing = 45;if (has("weak_social_presence")) marketing += 20;if (has("low_content_activity")) marketing += 12;if (has("weak_local_visibility")) marketing += 10;if (/commerce|restauration|technologie|immobilier/.test(ik)) marketing += 10;marketing = Math.min(95, marketing);
  var management = 40;if (has("fragmented_presence")) management += 20;if (has("expansion_signal")) management += 12;if (has("multiple_locations")) management += 15;if ((p.signals || []).length >= 3) management += 8;management = Math.min(95, management);
  var automation = 35;if (has("limited_digital_presence")) automation += 15;if (has("hiring_signal")) automation += 10;if (/technologie|services|finance/.test(ik)) automation += 12;automation = Math.min(90, automation);
  var constructionSoft = 20;if (ik === "construction" || has("construction_fit")) constructionSoft = 90;else if (/immobilier/.test(ik)) constructionSoft = 45;
  var payment = 20;if (/commerce|restauration/.test(ik)) payment = 70;else if (p.website_status === "ACTIVE" && p.public_email) payment = 45;
  var overall = Math.round((digital + marketing + management + automation + constructionSoft + payment) / 6);
  return {digital: digital, marketing: marketing, management: management, automation: automation, constructionSoft: constructionSoft, payment: payment, overall: overall};}
function matchServices(p, needs, signals){var names = signals.map(g => g.signal_name);var has = n => names.includes(n);var ik = p.industry_key || "";var out = {};
  var kb = 0;if (ik === "construction" || has("construction_fit")) kb += 45;if (oppHas(p, /rénovation|renovation|contracteur|contractor|sous-traitant/)) kb += 18;if (oppHas(p, /plomberie|plumbing|électricité|electrical|toiture|roofing/)) kb += 12;if ((p.signals || []).length >= 2) kb += 8;if (needs.constructionSoft >= 70) kb += 10;if (/11–50|51–200/.test(p.employee_range || "")) kb += 5;out.KLIRBUILD = Math.min(100, kb);
  var kl = 0;if ((p.signals || []).length >= 3) kl += 20;if (has("expansion_signal")) kl += 15;if (has("multiple_locations")) kl += 15;if (has("fragmented_presence")) kl += 12;if (needs.management >= 60) kl += 18;if (/11–10|11–50|51–200|201–500/.test(p.employee_range || "")) kl += 8;out.KLIRLINE = Math.min(100, kl);
  var kia = 0;if (has("low_content_activity")) kia += 20;if (has("weak_social_presence")) kia += 12;if (needs.marketing >= 60) kia += 15;if (needs.automation >= 50) kia += 15;if (ik === "technologie") kia += 18;out.KLIRIA = Math.min(100, kia);
  var kp = 0;if (has("weak_social_presence")) kp += 22;if (has("low_content_activity")) kp += 12;if (has("weak_local_visibility")) kp += 12;if (/commerce|restauration|immobilier|services/.test(ik)) kp += 20;if (!p.website) kp += 8;out.KLIRPROMO = Math.min(100, kp);
  var ky = 0;if (/commerce|restauration/.test(ik)) ky += 35;if (p.website_status === "ACTIVE") ky += 15;if (p.public_email && p.phone) ky += 10;out.KLIRPAY = Math.min(100, ky);
  var km = 0;if (/commerce|restauration/.test(ik)) km += 30;if (p.phone && p.city) km += 15;if (p.website) km += 10;if (has("expansion_signal")) km += 8;out.KLIRMARKET = Math.min(100, km);
  return out;}
function oppPriority(score){var t = oppCfg().thresholds;if (score == null) return {level: "INSUFFICIENT", badge: "⚪ INSUFFICIENT"};if (score >= t.veryHigh) return {level: "VERY HIGH", badge: "🔥 VERY HIGH"};if (score >= t.high) return {level: "HIGH", badge: "🔥 HIGH"};if (score >= t.medium) return {level: "MEDIUM", badge: "🟠 MEDIUM"};return {level: "LOW", badge: "⚪ LOW"};}
function attachOpp(p, params){var dq = p.dq || 0;var conf = (p.conf != null ? p.conf : 60);
  p.opp_version = OPP_V;p.opp_at = new Date().toISOString().slice(0, 16).replace("T", " ");
  if (dq < 40) {p.opp_score = null;p.opp_priority = "INSUFFICIENT";p.opp_priority_badge = "⚪ INSUFFICIENT";p.opp_note = "Insufficient Data — additional verification required.";p.opp_signals = [];p.opp_services = {};p.opp_top_service = null;p.opp_confidence = "Low";return p;}
  if (window.WebIntel) window.WebIntel.ensure(p);
  var signals = detectSignals(p, params || {});
  var icp = scoreIcp(p, params || {});
  var ss = scoreSignals(signals, conf);
  var needs = scoreNeeds(p, signals);
  var svc = matchServices(p, needs, signals);
  var best = null, bestScore = -1;for (const k of Object.keys(svc)) {if (svc[k] > bestScore) {bestScore = svc[k];best = k;}}
  var f = oppCfg().formula;var opp = Math.round(icp * f.icp + ss.score * f.signal + needs.overall * f.need + bestScore * f.service);
  var pr = oppPriority(opp);
  p.opp_icp = icp;p.opp_signal_score = ss.score;p.opp_need = needs.overall;p.opp_needs = needs;p.opp_services = svc;p.opp_top_service = best;p.opp_top_service_score = bestScore;
  p.opp_score = opp;p.opp_priority = pr.level;p.opp_priority_badge = pr.badge;
  p.opp_signals = signals;p.opp_action = best ? OPP_SERVICES[best].action : "Qualifier le prospect avant toute action.";
  p.opp_confidence = conf >= 80 ? "High" : (conf >= 50 ? "Medium" : "Low");
  p.opp_why = "Correspondance " + (icp >= 70 ? "élevée" : "modérée") + " avec le profil détecté (" + (p.industry || "?") + ", " + (p.city || "?") + "). " + signals.length + " signaux publics détectés. " + (best ? OPP_SERVICES[best].label + " présente la meilleure correspondance (" + bestScore + "/100)." : "");
  return p;}
function ensureOpp(p){if (!p || p.opp_version === OPP_V) return p;try {var s = (window.KlirStore && window.KlirStore.S.searches || []).find(x => x.id === p.searchId);attachOpp(p, (s && s.params) || {});} catch (e) {}return p;}
function topServiceLabel(p){if (!p.opp_top_service) return "—";var s = OPP_SERVICES[p.opp_top_service];return (s ? s.label : p.opp_top_service) + " " + (p.opp_top_service_score || 0);}
function leadBadge(pid){try {var p = window.KlirStore.S.prospects.find(x => x.id === pid);if (!p || p.opp_score == null) return "";} catch (e) {return "";}return "🔥" + p.opp_score;}
function parseOpp(q){q = String(q || "").toLowerCase();var f = {};
  if (/klirbuild/.test(q)) f.service = "KLIRBUILD";else if (/klirpromo/.test(q)) f.service = "KLIRPROMO";else if (/klir\s*ia/.test(q)) f.service = "KLIRIA";else if (/klirpay/.test(q)) f.service = "KLIRPAY";else if (/klirmarket/.test(q)) f.service = "KLIRMARKET";else if (/klirline/.test(q)) f.service = "KLIRLINE";
  if (/potentiel|opportunit|priorit|class|best|meilleur|top/.test(q)) f.sort = "opp";
  var m = q.match(/(?:supérieur à|superieur à|>|minimum|au moins|\+)\s*(\d{2,3})/);if (m) f.minOpp = Math.min(100, parseInt(m[1]));
  if (/faible.*web|weak.*web|sans site|présence.*limitée|presence.*limitée/.test(q)) f.signal = "digital";
  if (/marketing|promo/.test(q) && !f.service) f.service = "KLIRPROMO";
  return f;}
function matchOpp(p, f){if (!f || !Object.keys(f).length) return true;ensureOpp(p);
  if (f.minOpp != null && (p.opp_score == null || p.opp_score < f.minOpp)) return false;
  if (f.priority && (p.opp_priority || "") !== f.priority) return false;
  if (f.service && p.opp_top_service !== f.service) return false;
  if (f.signal === "digital" && !((p.opp_signals || []).some(g => g.group === "digital" || g.group === "digitalization"))) return false;
  return true;}
function sortedFor(list, mode, svc){var arr = [...list];for (const p of arr) ensureOpp(p);
  var val = mode === "icp" ? (p => p.opp_icp || 0) : mode === "need" ? (p => p.opp_need || 0) : mode === "signal" ? (p => p.opp_signal_score || 0) : mode === "dq" ? (p => p.dq || 0) : mode === "rel" ? (p => p.rel || 0) : mode === "conf" ? (p => p.conf || 0) : (p => p.opp_score == null ? -1 : p.opp_score);
  if (mode === "service" && svc) arr.sort((a, b) => ((b.opp_services || {})[svc] || 0) - ((a.opp_services || {})[svc] || 0));
  else arr.sort((a, b) => val(b) - val(a));
  return arr;}
function esc(s){return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");}
function breakRows(p){var f = oppCfg().formula;return [["ICP Match × " + f.icp, Math.round((p.opp_icp || 0) * f.icp)], ["Signals × " + f.signal, Math.round((p.opp_signal_score || 0) * f.signal)], ["Need × " + f.need, Math.round((p.opp_need || 0) * f.need)], ["Service Match × " + f.service, Math.round((p.opp_top_service_score || 0) * f.service)]];}
function drawerOppHTML(p){ensureOpp(p);if (p.opp_score == null) return "<h4>🔥 OPPORTUNITY INTELLIGENCE</h4><div class=\"why\">Insufficient Data — additional verification required (Data Quality &lt; 40). Aucune information manquante n'a été inventée.</div>";
  var rows = breakRows(p);var svcs = Object.keys(p.opp_services || {}).sort((a, b) => p.opp_services[b] - p.opp_services[a]).slice(0, 4);
  var min = oppCfg().serviceMin;
  function tag(v){return v >= min.strong ? "Strong Match" : (v >= min.possible ? "Possible Match" : "Do Not Prioritize");}
  var sigs = (p.opp_signals || []).slice(0, 6).map(function(g){var w = oppCfg().signalW[g.signal_name];return "<div class=\"row\"><span>" + esc(g.signal_name) + " <small>" + esc(g.evidence) + "</small></span><small>poids " + (w != null ? w : "?") + " \u2022 " + Math.round(g.confidence * 100) + "%</small></div>";}).join("");
  return "<h4>\uD83D\uDD25 OPPORTUNITY INTELLIGENCE</h4><div class=\"why\"><b>Opportunity Score : " + p.opp_score + "/100</b> " + p.opp_priority_badge + "<br><small>" + esc(p.opp_why) + " Confiance : " + p.opp_confidence + " \u2022 " + p.opp_at + " \u2022 " + p.opp_version + "</small></div>"
    + "<h4>WHY " + p.opp_score + "?</h4>"
    + rows.map(function(r){return "<div class=\"row\"><span>" + esc(r[0]) + "</span><b>+" + r[1] + "</b></div>";}).join("")
    + "<div class=\"row\"><span><b>Total</b></span><b>" + p.opp_score + "/100</b></div>"
    + "<h4>KEY SIGNALS</h4>" + sigs
    + "<h4>RECOMMENDED SERVICE</h4><div class=\"why\">\uD83D\uDD25 <b>" + topServiceLabel(p) + "</b> \u2014 " + tag(p.opp_top_service_score || 0) + "<br><small>" + svcs.map(function(k){return esc(OPP_SERVICES[k] ? OPP_SERVICES[k].label : k) + " " + p.opp_services[k] + " (" + tag(p.opp_services[k]) + ")";}).join(" \u2022 ") + "</small><br><b>Action :</b> " + esc(p.opp_action || "") + "</div>";}
function topHTML(ids){try{var all = window.KlirStore.S.prospects.filter(function(p){return ids.indexOf(p.id) >= 0;});for (const p of all) ensureOpp(p);var scored = all.filter(function(p){return p.opp_score != null;}).sort(function(a,b){return b.opp_score - a.opp_score;});if (!scored.length) return "";var top3 = scored.slice(0, 3);var svcCount = {};for (const p of scored) {if (p.opp_top_service && (p.opp_services[p.opp_top_service] || 0) >= 70) svcCount[p.opp_top_service] = (svcCount[p.opp_top_service] || 0) + 1;}
var cards = top3.map(function(p, ix){return "<div class=\"card stat\"><span>#" + (ix + 1) + " " + esc(p.company_name) + "</span><b>" + p.opp_score + "</b><small>" + p.opp_priority_badge + " \u2022 " + esc(p.opp_top_service_label || "") + " \u2022 Q" + p.dq + "</small><br><button data-view=\"" + p.id + "\">View</button></div>";}).join("");
var svcline = Object.keys(svcCount).map(function(k){return esc(OPP_SERVICES[k] ? OPP_SERVICES[k].label : k) + " : <b>" + svcCount[k] + "</b>";}).join(" \u2022 ") || "aucune correspondance forte pour l\u2019instant";
return "<h3>\uD83D\uDD25 TOP OPPORTUNITIES</h3><div class=\"grid4\">" + cards + "</div><div class=\"card\"><small><b>SERVICE OPPORTUNITIES (match \u226570) :</b> " + svcline + "</small></div>";}catch(e){return "";}}
function dashStats(){try{var all = window.KlirStore.S.prospects.map(function(p){return ensureOpp(p);});var hi = all.filter(function(p){return p.opp_score != null && p.opp_score >= 75;}).length;var vh = all.filter(function(p){return p.opp_priority === "VERY HIGH";}).length;function cnt(s){return all.filter(function(p){return ((p.opp_services || {})[s] || 0) >= 70;}).length;}
return "<div class=\"grid4\">" + [["HIGH+", hi], ["VERY HIGH", vh], ["KlirBuild", cnt("KLIRBUILD")], ["KlirPromo", cnt("KLIRPROMO")], ["Klirline OS", cnt("KLIRLINE")], ["Klir IA", cnt("KLIRIA")]].map(function(kv){return "<div class=\"card stat\"><span>" + kv[0] + "</span><b>" + kv[1] + "</b></div>";}).join("") + "</div>";}catch(e){return "";}}
window.OppEngine = {cfg: oppCfg, attach: attachOpp, ensure: ensureOpp, parse: parseOpp, match: matchOpp, sorted: sortedFor, drawerHTML: drawerOppHTML, topHTML: topHTML, dashStats: dashStats, leadBadge: leadBadge, topServiceLabel: topServiceLabel, priority: oppPriority, version: OPP_V, services: OPP_SERVICES};
