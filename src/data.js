var INDUSTRIES = {
  "construction": {label:"Construction / Rénovation", keywords:["renovation","rénovation","construction","contracteur","plomberie","électricité","toiture","peinture","maçonnerie","roofing","plumbing"], services:["Rénovation résidentielle","Rénovation commerciale","Toiture","Plomberie","Électricité","Agrandissement"], domains:["construction","renovation","toiture","plomberie"]},
  "restauration": {label:"Restaurants / Food", keywords:["restaurant","café","cafe","bistro","brasserie","traiteur","boulangerie","pizzeria","food"], services:["Service en salle","Traiteur","Livraison","Brunch"], domains:[" resto","bistro","cuisine"]},
  "immobilier": {label:"Immobilier", keywords:["immobilier","courtier","agence immobilière","real estate","condo","gestion locative"], services:["Courtage","Gestion locative","Évaluation"], domains:["immobilier","courtage"]},
  "sante": {label:"Santé", keywords:["santé","sante","clinique","dentiste","physio","médical","vet","dentaire"], services:["Clinique","Soins","Consultation"], domains:["clinique","sante"]},
  "technologie": {label:"Technologie", keywords:["tech","logiciel","saas","startup","agence web","informatique","développement","digital","marketing"], services:["Développement web","SaaS","Marketing digital","IT"], domains:["tech","web","digital","studio"]},
  "commerce": {label:"Commerce / Retail", keywords:["boutique","magasin","commerce","retail","épicerie","fleuriste","salon","coiffure","garage","auto"], services:["Vente au détail","Services","Entretien"], domains:["boutique","auto","salon"]},
  "finance": {label:"Finance / Assurance", keywords:["finance","comptable","assurance","banque","investissement","fiscaliste"], services:["Comptabilité","Assurance","Conseil"], domains:["finance","comptable"]},
  "services": {label:"Services professionnels", keywords:["avocat","notaire","consultant","agence","nettoyage","paysagement","déménagement","juridique"], services:["Conseil","Nettoyage","Entretien","Juridique"], domains:["services","conseil","groupe"]}
};
var CITIES = {
  "montréal": {city:"Montréal", locality:"Montréal", province:"QC", region:"Québec", country:"Canada", countryCode:"CA", postal:["H2X","H3A","H2W","H4B"], phones:["514","438"], lat:45.5017, lng:-73.5673},
  "laval": {city:"Laval", locality:"Laval", province:"QC", region:"Québec", country:"Canada", countryCode:"CA", postal:["H7N","H7T"], phones:["450"," Laval".trim()], lat:45.6066, lng:-73.7124},
  "québec": {city:"Québec", locality:"Québec", province:"QC", region:"Québec", country:"Canada", countryCode:"CA", postal:["G1K","G1R"], phones:["418","581"], lat:46.8139, lng:-71.208},
  "toronto": {city:"Toronto", locality:"Toronto", province:"ON", region:"Ontario", country:"Canada", countryCode:"CA", postal:["M5V","M4B"], phones:["416","647"], lat:43.6532, lng:-79.3832},
  "paris": {city:"Paris", locality:"Paris", province:"Île-de-France", region:"Île-de-France", country:"France", countryCode:"FR", postal:["75001","75011"], phones:["01"], lat:48.8566, lng:2.3522},
  "lyon": {city:"Lyon", locality:"Lyon", province:"Auvergne-Rhône-Alpes", region:"Auvergne-Rhône-Alpes", country:"France", countryCode:"FR", postal:["69001","69002"], phones:["04"], lat:45.764, lng:4.8357},
  "default": {city:"Montréal", province:"QC", country:"Canada", postal:["H2X","H3A"], phones:["514","438"], lat:45.5017, lng:-73.5673, supported:false}
};
var SUPPORTED_CITY_KEYS = ["montréal","laval","québec","toronto","paris","lyon"];
var SECTOR_TAXONOMY = Object.freeze({version:"sectors-2026-11", source:"KlirData.INDUSTRIES"});
var SEARCH_SCOPE = Object.freeze({
  radiusAllM: 1500,
  radiusSectorM: 2200,
  queryTimeoutSec: 15,
  requestTimeoutMs: 18000,
  retryAfterCapMs: 30000,
  montrealIsland: Object.freeze({south:45.4102, west:-73.9744, north:45.7058, east:-73.4742}),
  coverageLabel: "Montréal, Laval, Québec, Toronto, Paris et Lyon"
});
var NAME_A = ["Nord","Klir","Pro","Expert","Premier","Atelier","Groupe","Alliance","Nova","Élite","Summit","Azur","Vantage","Onyx","Boréal"];
var NAME_B = {"construction":["Rénovation","Construction","Toiture","Plomberie","Bâtiment"],"restauration":["Bistro"," saveurs".trim(),"Cuisine","Brasserie","Café"],"immobilier":["Courtage","Habitat","Propriétés","Immobilier"],"sante":["Clinique","Santé","Dentaire","Physio"],"technologie":["Web","Digital","Logiciels","Studio","Tech"],"commerce":["Boutique","Auto","Salon","Marché"],"finance":["Comptable","Assurance","Finance","Fiscalité"],"services":["Services","Conseil","Nettoyage","Juridique"]};
var STREETS = ["rue Sainte-Catherine O","bd Saint-Laurent","av. du Parc","rue Notre-Dame E","bd René-Lévesque","rue Sherbrooke O","av. Papineau","rue Masson"];
window.KlirData = {INDUSTRIES, CITIES, NAME_A, NAME_B, STREETS, SUPPORTED_CITY_KEYS, SEARCH_SCOPE, SECTOR_TAXONOMY};
