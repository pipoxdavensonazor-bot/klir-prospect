/* KlirProspect — Tarifs, abonnement et conditions de vente (brouillon).
   Le navigateur n'envoie ni prix ni crédits : il ouvre seulement le lien de
   paiement Stripe fourni par le serveur (billing_status) et y ajoute
   l'identifiant du compte. Les crédits arrivent par le webhook signé. */
(function () {
  "use strict";

  // Application Android (TWA Google Play) : aucun achat ni lien de paiement
  // dans l'app (règles Google Play) ; les paiements se font sur le site.
  // Détection : référent android-app:// de notre package ou ?source=twa
  // (URL de démarrage de l'app). Mémorisé dans sessionStorage seulement :
  // Chrome partage le localStorage avec l'app, le site resterait sinon masqué.
  var ANDROID_APP_KEY = "klir_android_app";
  var ANDROID_APP_REFERRER = "android-app://ca.klirline.klirprospect";
  var ANDROID_APP_NOTE = "La gestion de l’abonnement se fait sur le site klirprospect.klirline.ca.";
  function detectAndroidApp() {
    try {
      var ref = String(document.referrer || "");
      var fromParam = /(?:^|[?&])source=twa(?:&|$)/.test(String(location.search || ""));
      if (ref.indexOf(ANDROID_APP_REFERRER) === 0 || fromParam) sessionStorage.setItem(ANDROID_APP_KEY, "1");
      return sessionStorage.getItem(ANDROID_APP_KEY) === "1";
    } catch (e) { return false; }
  }
  var androidApp = detectAndroidApp();
  function inAndroidApp() { return androidApp; }
  function androidNote() { return '<div class="card" role="note" id="kpAndroidNote"><p>' + h(ANDROID_APP_NOTE) + "</p></div>"; }

  function h(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  var TIERS = [
    {
      key: "gratuit", name: "Gratuit", month: 0, year: 0, credits: "50 crédits par mois",
      extra: "+ 200 crédits offerts à l'inscription",
      users: "1 utilisateur",
      features: ["Recherche de commerces locaux et score d'opportunité", "Signaux opportunité web (sans site, réseau social seulement, sans HTTPS, sans téléphone)", "Courriels publics extraits des sites web : 1 crédit par courriel trouvé (remboursé sinon)", "CRM limité à 100 fiches", "Export CSV", "Solde remonté à 50 crédits chaque mois (sans report)"],
      soon: []
    },
    {
      key: "starter", name: "Starter", month: 19, year: 180, credits: "600 crédits par mois",
      extra: "Report des crédits non utilisés, jusqu'à 2 fois l'allocation",
      users: "1 utilisateur",
      features: ["Tout Gratuit, dont les signaux opportunité web et les courriels publics (1 crédit par courriel trouvé)", "CRM illimité", "Export CSV illimité", "État des sites web (HTTP, HTTPS, DNS, SSL)", "50 messages IA par mois"],
      soon: []
    },
    {
      key: "pro", name: "Pro", month: 39, year: 372, credits: "2 000 crédits par mois",
      extra: "Report des crédits non utilisés, jusqu'à 2 fois l'allocation",
      users: "2 utilisateurs (à venir)", popular: true,
      features: ["Tout Starter"],
      soon: ["Vérification des courriels", "Alertes de nouvelles entreprises", "Listes d'exclusion", "Zapier ou webhook"]
    },
    {
      key: "equipe", name: "Équipe", month: 89, year: 852, credits: "6 000 crédits par mois, partagés",
      extra: "Report des crédits non utilisés, jusqu'à 2 fois l'allocation",
      users: "5 utilisateurs inclus, puis 12 $ par utilisateur (à venir)",
      features: ["Tout Pro", "Soutien prioritaire en français"],
      soon: ["API", "Rôles", "Rapports d'équipe"]
    }
  ];
  var PACKS = [
    { offer: "pack_500", credits: "500 crédits", price: 10 },
    { offer: "pack_2000", credits: "2 000 crédits", price: 39 }
  ];
  var TIER_NAMES = { gratuit: "Gratuit", starter: "Starter", pro: "Pro", equipe: "Équipe" };

  var state = { interval: "month", status: null, plan: null, loading: false, error: "" };

  function money(n) {
    return n === 0 ? "0 $" : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ") + " $";
  }
  function perMonthOfYear(t) { return Math.round(t.year / 12); }

  function auth() { return window.KlirAuth || null; }
  function signedUser() {
    var a = auth();
    var s = a && a.state ? a.state() : null;
    return s && s.user ? s.user : null;
  }

  function checkoutUrl(offerKey) {
    if (inAndroidApp()) return "";
    var st = state.status;
    var user = signedUser();
    if (!st || !st.checkout_enabled || !user || !Array.isArray(st.offers)) return "";
    var o = st.offers.find(function (x) { return x && x.offer === offerKey; });
    if (!o || !/^https:\/\/buy\.stripe\.com\/[A-Za-z0-9_]+$/.test(o.url || "")) return "";
    var params = "client_reference_id=" + encodeURIComponent(user.id);
    if (user.email) params += "&prefilled_email=" + encodeURIComponent(user.email);
    params += "&locale=fr-CA";
    return o.url + "?" + params;
  }

  function portalUrl() {
    if (inAndroidApp()) return "";
    var st = state.status;
    var user = signedUser();
    if (!st || !st.portal_url || !/^https:\/\/billing\.stripe\.com\/p\/login\/[A-Za-z0-9_]+$/.test(st.portal_url)) return "";
    return st.portal_url + (user && user.email ? "?prefilled_email=" + encodeURIComponent(user.email) : "");
  }

  async function refresh() {
    var a = auth();
    if (!a || typeof a.billingStatus !== "function" || !signedUser()) { state.status = null; return null; }
    state.loading = true;
    var result = await a.billingStatus();
    state.loading = false;
    if (result && result.ok) { state.status = result.status; state.error = ""; }
    else { state.error = (result && result.message) || "Lecture de l'abonnement impossible."; }
    await refreshPlan();
    return state.status;
  }

  // Limites du forfait lues sur le serveur (plan_status) ; le serveur les applique.
  async function refreshPlan() {
    var a = auth();
    if (!a || typeof a.planStatus !== "function" || !signedUser()) { state.plan = null; return null; }
    var result = await a.planStatus();
    state.plan = result && result.ok ? result.plan : null;
    return state.plan;
  }

  // Nombre de fiches CRM encore ajoutables (Infinity si illimité ou inconnu).
  function crmRoom(current) {
    var p = state.plan;
    if (!p || !p.crm || p.crm.max == null) return Infinity;
    return Math.max(0, Number(p.crm.max) - Number(current || 0));
  }
  var CRM_LIMIT_MSG = inAndroidApp()
    ? "Le forfait Gratuit inclut 100 fiches CRM. Vos fiches existantes sont conservées."
    : "Le forfait Gratuit inclut 100 fiches CRM. Vos fiches existantes sont conservées ; passez à Starter pour en ajouter.";

  function limitsBlock() {
    var p = state.plan;
    if (!p) return "";
    var row = function (label, used, max, unit) {
      var value = max == null ? used + " " + unit + " (illimité)" : max === 0 ? "Non inclus" : used + " / " + max + " " + unit;
      return '<div class="row"><span>' + h(label) + "</span><b>" + h(value) + "</b></div>";
    };
    var lots = (p.pack_lots || []).map(function (l) {
      return '<div class="row"><span>Pack : ' + h(l.remaining) + " crédits restants sur " + h(l.credits) + "</span><b>Expire le " + h(dateFr(l.expires_at)) + "</b></div>";
    }).join("");
    return '<section class="card"><h2>Limites du forfait</h2>' +
      row("Utilisateurs", p.seats.used, p.seats.max, "") +
      row("Fiches CRM", p.crm.used, p.crm.max, "fiches") +
      row("Messages IA ce mois-ci", p.ai.used, p.ai.max, "messages") + lots +
      "<p><small>Au-delà d'une limite, rien n'est supprimé : seules les nouvelles additions sont bloquées. Les crédits de packs expirent 12 mois après l'achat et sont utilisés en premier.</small></p></section>";
  }

  function testBanner() {
    if (inAndroidApp()) return "";
    var st = state.status;
    if (st && st.checkout_enabled && st.mode === "test") {
      return '<div class="card demoB" role="note"><b>Mode test Stripe.</b> Aucun vrai paiement : utilisez la carte de test 4242 4242 4242 4242.</div>';
    }
    return "";
  }

  function tierButton(t) {
    if (inAndroidApp()) {
      if (t.key !== "gratuit") return "";
      var u = signedUser();
      return u ? '<span class="pill">Inclus avec votre compte</span>' : '<a class="cta" href="#/register">Créer un compte gratuit</a>';
    }
    var user = signedUser();
    if (t.key === "gratuit") {
      return user ? '<span class="pill">Inclus avec votre compte</span>' : '<a class="cta" href="#/register">Créer un compte gratuit</a>';
    }
    if (!user) return '<a class="cta" href="#/register">Créer un compte pour choisir</a>';
    var st = state.status;
    if (st && st.tier && st.tier !== "gratuit") {
      var portal = portalUrl();
      if (st.tier === t.key) return '<span class="pill">Forfait actuel</span>';
      return portal ? '<a class="ghost" href="' + h(portal) + '" rel="noopener">Changer via Gérer mon abonnement</a>' : "";
    }
    var url = checkoutUrl(t.key + "_" + state.interval);
    if (!url) return '<button type="button" class="ghost" disabled>Paiement bientôt disponible</button>';
    return '<a class="cta" href="' + h(url) + '" rel="noopener">Choisir ' + h(t.name) + "</a>";
  }

  function tierCard(t) {
    var price = state.interval === "year" && t.year ? money(perMonthOfYear(t)) + " / mois" : money(t.month) + " / mois";
    var sub = state.interval === "year" && t.year ? "soit " + money(t.year) + " par an. Aucune taxe facturée (petit fournisseur)" : (t.month ? "Aucune taxe facturée (petit fournisseur)" : "sans carte de crédit");
    var list = t.features.map(function (f) { return "<li>" + h(f) + "</li>"; }).join("") +
      t.soon.map(function (f) { return '<li>' + h(f) + ' <span class="pill kp-soon">à venir</span></li>'; }).join("");
    return '<section class="card kp-tier' + (t.popular ? " kp-popular" : "") + '">' +
      (t.popular ? '<span class="pill kp-badge">Le plus choisi</span>' : "") +
      "<h2>" + h(t.name) + '</h2><p class="kp-price">' + h(price) + '</p><p><small>' + h(sub) + "</small></p>" +
      "<p><b>" + h(t.credits) + "</b><br><small>" + h(t.extra) + "</small></p><p><small>" + h(t.users) + "</small></p>" +
      "<ul>" + list + "</ul>" + '<div class="kp-act">' + tierButton(t) + "</div></section>";
  }

  function packsBlock(inApp) {
    if (inAndroidApp()) return "";
    var st = state.status;
    var paid = st && st.tier && st.tier !== "gratuit";
    var rows = PACKS.map(function (p) {
      var url = paid ? checkoutUrl(p.offer) : "";
      var action = url ? '<a class="cta" href="' + h(url) + '" rel="noopener">Acheter</a>'
        : '<button type="button" class="ghost" disabled>' + (paid ? "Paiement bientôt disponible" : "Réservé aux forfaits payants") + "</button>";
      return '<div class="row"><span><b>' + h(p.credits) + "</b> — " + h(money(p.price)) + " — Aucune taxe facturée (petit fournisseur)</span>" + action + "</div>";
    }).join("");
    return '<section class="card"><h2>Packs de crédits</h2><p><small>En plus d\'un forfait payant. Valides 12 mois. Non remboursables.</small></p>' + rows +
      (inApp ? "" : "") + "</section>";
  }

  function creditRules() {
    return '<section class="card"><h2>Comment les crédits sont utilisés</h2><ul>' +
      "<li>Recherche : 5 crédits + 1 crédit par tranche de 10 fiches demandées (40 fiches au plus, soit 9 crédits).</li>" +
      "<li>Une recherche vide, partielle ou en erreur ne coûte rien. L'export CSV est gratuit.</li>" +
      "<li>Courriel public : 1 crédit par courriel trouvé sur le site de l'entreprise, remboursé si aucun courriel n'est trouvé (25 fiches au plus par lot).</li>" +
      "<li>Signaux opportunité web : inclus, sans crédit.</li>" +
      "<li>Garde-fou anti-abus : 30 recherches par heure et 200 par jour par compte.</li>" +
      "<li>Les forfaits payants reportent les crédits non utilisés, jusqu'à 2 fois l'allocation mensuelle.</li>" +
      "</ul><p><small>Montants en dollars canadiens. Aucune taxe facturée (petit fournisseur) : Klirline Inc. n'est pas inscrite à la TPS/TVQ ; le prix affiché est le prix payé. Annulation à tout moment, effective à la fin de la période payée. " +
      'Voir les <a href="#/conditions">conditions de vente</a>.</small></p></section>';
  }

  function landNav() {
    return '<nav class="land-nav" aria-label="Navigation principale"><a class="land-brand" href="#/landing"><img src="icons/logo.png" alt="KLIRProspect" width="960" height="253"></a>' +
      '<div class="land-actions"><a href="#/tarifs">Tarifs</a>' + (signedUser() ? '<a href="#/abonnement">Mon abonnement</a><a class="cta" href="#/dashboard">Application</a>'
        : '<a href="#/login">Connexion</a><a class="cta" href="#/register">Inscription</a>') + "</div></nav>";
  }

  function pricingBody() {
    var toggle = '<div class="rowb kp-toggle" role="group" aria-label="Période de facturation">' +
      '<button type="button" class="' + (state.interval === "month" ? "cta" : "ghost") + '" data-kp-interval="month" aria-pressed="' + (state.interval === "month") + '">Mensuel</button>' +
      '<button type="button" class="' + (state.interval === "year" ? "cta" : "ghost") + '" data-kp-interval="year" aria-pressed="' + (state.interval === "year") + '">Annuel (environ 20 % de rabais)</button></div>';
    return '<h1>Tarifs</h1><p>Des commerces locaux à prospecter, un CRM intégré, en français et en dollars canadiens. Sans engagement.</p>' +
      (inAndroidApp() ? androidNote() : "") + testBanner() + toggle + '<div class="kp-tiers">' + TIERS.map(tierCard).join("") + "</div>" + packsBlock(false) + creditRules();
  }

  function bindPricing(root, rerender) {
    root.querySelectorAll("[data-kp-interval]").forEach(function (b) {
      b.addEventListener("click", function () { state.interval = b.getAttribute("data-kp-interval") === "year" ? "year" : "month"; rerender(); });
    });
  }

  function viewTarifs(app) {
    var draw = function () {
      app.innerHTML = '<div class="land">' + landNav() + '<main class="kp-wrap">' + pricingBody() + "</main></div>";
      bindPricing(app, draw);
    };
    draw();
    if (signedUser()) refresh().then(function () { if (/^#\/tarifs/.test(location.hash)) draw(); });
  }

  function dateFr(value) {
    if (!value) return "";
    var d = new Date(value);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleDateString("fr-CA", { year: "numeric", month: "long", day: "numeric", timeZone: "America/Toronto" });
  }

  function accountBody() {
    var st = state.status;
    if (state.error) return '<h1>Mon abonnement</h1><div class="card" role="alert">' + h(state.error) + "</div>";
    if (!st) return '<h1>Mon abonnement</h1><div class="card">Chargement…</div>';
    var name = TIER_NAMES[st.tier] || "Gratuit";
    var lines = ['<div class="row"><span>Forfait</span><b>' + h(name) + (st.offer && /_year$/.test(st.offer) ? " (annuel)" : st.tier !== "gratuit" ? " (mensuel)" : "") + "</b></div>",
      '<div class="row"><span>Solde</span><b>' + h(st.balance == null ? "—" : st.balance) + " crédits</b></div>",
      '<div class="row"><span>Crédits par mois</span><b>' + h(st.monthly_credits || 50) + "</b></div>"];
    if (st.tier === "gratuit" && st.next_refill_at) lines.push('<div class="row"><span>Prochaine recharge (jusqu\'à 50)</span><b>' + h(dateFr(st.next_refill_at)) + "</b></div>");
    if (st.tier !== "gratuit" && st.current_period_end) {
      lines.push('<div class="row"><span>' + (st.cancel_at_period_end ? "Se termine le" : "Prochain renouvellement") + "</span><b>" + h(dateFr(st.current_period_end)) + "</b></div>");
    }
    if (st.status === "past_due") lines.push('<div class="row" role="alert"><span>Paiement en retard : mettez à jour votre carte.</span></div>');
    var portal = portalUrl();
    var actions = inAndroidApp() ? "<p>" + h(ANDROID_APP_NOTE) + "</p>" : st.tier !== "gratuit"
      ? (portal ? '<a class="cta" href="' + h(portal) + '" rel="noopener">Gérer mon abonnement</a>' : '<button type="button" class="ghost" disabled>Gestion bientôt disponible</button>') + ' <a class="ghost" href="#/tarifs">Voir les forfaits</a>'
      : '<a class="cta" href="#/tarifs">Choisir un forfait</a>';
    var success = /paiement=reussi/.test(location.search) ? '<div class="card demoB" role="status">Paiement reçu par Stripe. Les crédits apparaissent dès la confirmation, en général en quelques secondes. Rechargez la page au besoin.</div>' : "";
    return "<h1>Mon abonnement</h1>" + success + testBanner() + '<section class="card">' + lines.join("") + '<div class="rowb" style="margin-top:12px">' + actions + "</div>" +
      (inAndroidApp() ? "" : '<p><small>« Gérer mon abonnement » ouvre l\'espace client Stripe : factures, carte, changement de forfait et annulation (effective à la fin de la période payée). Connexion par un code envoyé à votre courriel.</small></p>') + "</section>" +
      limitsBlock() + (st.tier !== "gratuit" ? packsBlock(true) : "");
  }

  function viewAbonnement(container) {
    container.innerHTML = accountBody();
    refresh().then(function () { var el = document.getElementById("kpAbonnement"); if (el) el.innerHTML = accountBody(); });
  }

  var TERMS_SUMMARY = [
    "Vendeur : Klirline Inc., entreprise incorporée, numéro d'entreprise (NE) 777880576RC0001. Pour nous joindre : contact@klirline.ca.",
    "Prix en dollars canadiens. Aucune TPS ni TVQ n'est facturée : Klirline Inc. est un petit fournisseur, non inscrit aux fichiers de la TPS/TVQ. Le prix affiché est le prix payé.",
    "Si l'inscription aux taxes devient obligatoire, les prix pourront être ajustés pour ajouter les taxes applicables, avec un préavis par courriel avant tout renouvellement concerné.",
    "Abonnements mensuels ou annuels renouvelés automatiquement jusqu'à l'annulation.",
    "Annulation à tout moment depuis « Gérer mon abonnement » : effective à la fin de la période déjà payée, sans frais.",
    "Changement de forfait : une hausse prend effet tout de suite (montant au prorata) ; une baisse s'applique au renouvellement ou sous forme de crédit Stripe.",
    "Crédits : non remboursables et sans valeur monétaire, sous réserve des droits prévus par la Loi sur la protection du consommateur du Québec et des lois applicables.",
    "Les crédits déjà versés restent au compte après une annulation ou un retour au forfait Gratuit.",
    "Fonctions marquées « à venir » : non incluses tant qu'elles ne sont pas publiées.",
    "Paiement traité par Stripe ; KlirProspect ne voit ni ne conserve votre numéro de carte."
  ];

  function viewConditions(app) {
    app.innerHTML = '<div class="land">' + landNav() + '<main class="kp-wrap card"><p class="pill kp-soon">Version préliminaire — en cours de validation</p>' +
      "<h1>Conditions de vente — résumé</h1><ul>" + TERMS_SUMMARY.map(function (t) { return "<li>" + h(t) + "</li>"; }).join("") + "</ul>" +
      "</main></div>";
  }

  window.KlirBilling = {
    TIERS: TIERS, PACKS: PACKS, state: state, inAndroidApp: inAndroidApp, ANDROID_APP_NOTE: ANDROID_APP_NOTE, refresh: refresh, checkoutUrl: checkoutUrl, portalUrl: portalUrl,
    viewTarifs: viewTarifs, refreshPlan: refreshPlan, crmRoom: crmRoom, CRM_LIMIT_MSG: CRM_LIMIT_MSG, limitsBlock: limitsBlock, viewAbonnement: viewAbonnement, viewConditions: viewConditions, TERMS_SUMMARY: TERMS_SUMMARY,
    accountShell: function () { return '<div id="kpAbonnement">' + accountBody() + "</div>"; },
    pricingBody: pricingBody, accountBody: accountBody
  };
})();
