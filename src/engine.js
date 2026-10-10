function normStr(s){return (s||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"").replace(/[^a-z0-9]+/g," ").replace(/\b(inc|ltée|ltee|sarl|sas|llc|corp|entreprise|montreal|quebec)\b/g,"").trim().replace(/\s+/g," ");}
function normPhone(p){return (p||"").replace(/\D/g,"").replace(/^1(?=\d{10}$)/,"");}
function normEmail(e){return (e||"").toLowerCase().trim();}
function normDomain(d){return (d||"").toLowerCase().replace(/^https?:\/\//,"").replace(/^www\./,"").split("/")[0].trim();}
function fingerprint(p){return [normStr(p.company_name),normDomain(p.domain||p.website),normPhone(p.phone)].join("|");}
function industryLabel(key){
  if(!key||key==="all")return "Tous les secteurs";
  const row=KlirData.INDUSTRIES[key];
  return row?row.label:String(key);
}
function industryKeys(params){
  const key=params&&params.industry;
  if(key&&key!=="all"&&KlirData.INDUSTRIES[key])return [key];
  return Object.keys(KlirData.INDUSTRIES);
}
function parseQuery(q){
  q=(q||""); const low=q.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");
  const allAsked=/tous les (domaines|secteurs|industries)|toutes les (industries|activites)|tous secteurs|multi[- ]secteurs/.test(low);
  let industry="all", score=0;
  if(!allAsked){
    for(const [k,v] of Object.entries(KlirData.INDUSTRIES)){let s=0;const label=(v.label||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");if(label&&low.includes(label))s+=3;for(const kw of v.keywords){if(low.includes(kw.normalize("NFD").replace(/[\u0300-\u036f]/g,"")))s++;}if(s>score){score=s;industry=k;}}
    if(!score)industry="all";
  }
  let cityKey="default"; for(const k of Object.keys(KlirData.CITIES)){if(k!=="default"&&low.includes(k))cityKey=k;}
  let qty=50; const m=q.match(/(\d{2,4})\s*(entreprises?|prospects?|boites|companies)?/i); if(m)qty=Math.min(500,Math.max(10,parseInt(m[1])));
  let size=null; if(/1-10|tpe|artisan/i.test(q))size="1–10"; else if(/11-50|pme/i.test(q))size="11–50";
  return {industry, cityKey, city:KlirData.CITIES[cityKey], quantity:qty, size, raw:q};
}
function seededRand(seed){let s=seed;return()=>{s=(s*1103515245+12345)%2147483648;return s/2147483648;};}
function genProspects(params, qty){
  const rnd=seededRand([...params.raw].reduce((a,c)=>a+c.charCodeAt(0),7)+qty*13);
  const keys=industryKeys(params), city=params.city;
  const out=[]; const suffix=["Inc.","Ltée","& Associés","","Groupe","Services"];
  for(let i=0;i<qty*1.35;i++){
    const industry=keys[i%keys.length];
    const ind=KlirData.INDUSTRIES[industry];
    const a=KlirData.NAME_A[Math.floor(rnd()*KlirData.NAME_A.length)];
    const arr=KlirData.NAME_B[industry]||["Services"];
    const b=arr[Math.floor(rnd()*arr.length)];
    let name=`${a} ${b}`; if(rnd()<0.25)name=`${b} ${city.city}`; if(rnd()<0.15)name+=` ${suffix[Math.floor(rnd()*suffix.length)]}`;
    name=name.replace(/\s+/g," ").trim();
    const domBase=normStr(name).replace(/ /g,"")||"entreprise";
    const dom=domBase.slice(0,18)+(rnd()<0.5?".com":".ca");
    const hasWeb=rnd()>0.18, hasPhone=rnd()>0.12, hasEmail=rnd()>0.35;
    const phone=`${Array.isArray(city.phones)?city.phones[Math.floor(rnd()*city.phones.length)]:city.phones}-${String(Math.floor(rnd()*800+200))}-${String(Math.floor(rnd()*9000+1000))}`;
    out.push({
      id:"p_"+Date.now().toString(36)+"_"+i,
      company_name:name, legal_name:name,
      website:hasWeb?`https://www.${dom}`:"", domain:hasWeb?dom:"",
      industry:ind.label, industry_key:industry,
      description:`${ind.services[Math.floor(rnd()*ind.services.length)]} — ${city.city}.`,
      address:`${Math.floor(rnd()*900+100)} ${KlirData.STREETS[Math.floor(rnd()*KlirData.STREETS.length)]}`,
      city:city.city, province:city.province, country:city.country,
      postal_code:city.postal[Math.floor(rnd()*city.postal.length)]+` ${Math.floor(rnd()*9)}${"ABCEHJ"[Math.floor(rnd()*6)]}${Math.floor(rnd()*9)}`,
      phone:hasPhone?phone:"", public_email:hasEmail?`info@${dom}`:"",
      social_links:rnd()>0.6?{facebook:`fb.com/${domBase.slice(0,12)}`}:{},
      employee_range:params.size||["1–10","11–50","11–50","51–200"][Math.floor(rnd()*4)],
      source:["Annuaire public","Registre entreprises","Web public","Maps"][Math.floor(rnd()*4)],
      source_url:hasWeb?`https://www.${dom}`:"",
      last_verified:new Date().toISOString().slice(0,10),
      signals:(()=>{const s=[];if(rnd()>0.7)s.push("Nouveau site");if(rnd()>0.7)s.push("Recrutement");if(rnd()>0.75)s.push("Expansion");if(rnd()>0.6)s.push("Présence numérique active");if(rnd()>0.8)s.push("Entreprise récente");return s;})()
    });
  }
  return out;
}
function dedup(list){
  const seen=new Map(), unique=[], dups=[];
  for(const p of list){const f=fingerprint(p); if(seen.has(f)){dups.push({kept:seen.get(f), dup:p});} else {seen.set(f,p); unique.push(p);}}
  const byNameCity=new Map(); for(const p of unique){ const k=normStr(p.company_name)+"|"+normStr(p.city); if(byNameCity.has(k)){ dups.push({kept:byNameCity.get(k),dup:p}); } else byNameCity.set(k,p); } const byEmail=new Map(); for(const p of unique){ if(!p.public_email) continue; const e=normEmail(p.public_email); if(byEmail.has(e)){ dups.push({kept:byEmail.get(e),dup:p,level:"exact"}); } else byEmail.set(e,p); } const byPhone=new Map();
  for(const p of unique){if(!p.phone)continue;const n=normPhone(p.phone);if(byPhone.has(n)){dups.push({kept:byPhone.get(n),dup:p});}else byPhone.set(n,p);}
  const dupIds=new Set(dups.map(d=>d.dup.id));
  return {unique:unique.filter(p=>!dupIds.has(p.id)), dups};
}
function scoreProspect(p, params, W){
  W=W||{industry:25,location:15,signals:15,size:10};
  let dq=0; if(p.website)dq+=20; if(p.phone)dq+=20; if(p.public_email)dq+=20; if(p.address)dq+=15; if(p.industry)dq+=15; dq+=10;
  let rel=30; if(!params.industry||params.industry==="all"||p.industry_key===params.industry)rel+=W.industry; if(normStr(p.city)===normStr(params.city.city))rel+=W.location; rel+=Math.min(W.signals,p.signals.length*4);
  if(params.size&&p.employee_range===params.size)rel+=W.size;
  rel=Math.min(99,rel); dq=Math.min(100,dq);
  const conf=Math.round((dq*0.4+rel*0.6));
  const intent=intentOf({signals:p.signals});
  const opp=Math.round(rel*0.45+dq*0.2+conf*0.15+intent*0.2);
  return {data_quality_score:dq, commercial_relevance_score:rel, confidence_score:conf, intent_score:intent, opportunity_score:opp};
}
function icpFit(p, icp){
  if(!icp)return null; let s=0,max=0;
  const chk=(cond,w)=>{max+=w;if(cond)s+=w;};
  chk(!icp.industry||icp.industry==="all"||p.industry_key===icp.industry,30); chk(normStr(p.city)===normStr(icp.city||"montreal"),20);
  chk(!icp.size||p.employee_range===icp.size,15); chk(p.website?true:false,10);
  chk((icp.signals||[]).some(sg=>p.signals.includes(sg)),15); chk(p.public_email?true:false,10);
  return Math.round(s);
}
const INTENT_W={"Entreprise récente":30,"Recrutement":20,"Expansion":20,"Nouveau site":15,"Présence numérique active":10,"Activité récente":10};
function intentOf(p){ if(p&&p.intent!=null) return p.intent; let s=5; for(const sg of ((p&&p.signals)||[])) s+=INTENT_W[sg]||5; return Math.min(99,s); }
function oppOf(p){ if(p&&p.opp!=null) return p.opp; const dq=(p&&p.dq)||0,rel=(p&&p.rel)||0,conf=(p&&p.conf)||Math.round(dq*0.4+rel*0.6); return Math.round(rel*0.45+dq*0.2+conf*0.15+intentOf(p)*0.2); }
function ensureScores(p){ if(p.intent==null)p.intent=intentOf(p); if(p.opp==null)p.opp=oppOf(p); if(p.conf==null)p.conf=Math.round((p.dq||0)*0.4+(p.rel||0)*0.6); return p; }
var WATERFALL=["directory","registre","maps","web"];
function enrichWaterfall(p, active){
  const chain=WATERFALL.filter(k=>active[k]); const filled=[]; const prov=p.enrichedFrom||{};
  const tryFill=(field,val,src)=>{if(!p[field]&&val){p[field]=val;filled.push(field);prov[field]=src;}};
  const rnd=()=>window.KlirSecurity.random();
  for(const src of chain){
    if(src==="registre"){tryFill("legal_name",p.company_name+" "+(p.province==="QC"?"Inc.":"SARL"),src);}
    if(src==="maps"){tryFill("address",p.address||100+Math.floor(rnd()*800)+" rue Sainte-Catherine O",src);tryFill("phone",p.phone||"514-555-0100",src);}
    if(src==="web"){tryFill("website",p.website||("https://www."+normStr(p.company_name).replace(/ /g,"").slice(0,16)+".ca"),src);tryFill("description",p.description||(p.industry+" — "+p.city+"."),src);if(!p.signals.includes("Présence numérique active")&&rnd()>0.5){p.signals.push("Présence numérique active");filled.push("signals");prov.signals=src;}}
    if(src==="directory"){tryFill("public_email",p.public_email||("info@"+normDomain(p.website||"entreprise.ca")),src);}
  }
  p.enrichedFrom=prov;
  return {filled, chain};
}
window.KlirEngine={normStr,normPhone,normDomain,fingerprint,parseQuery,genProspects,dedup,scoreProspect,aiAnalysis,icpFit,intentOf,oppOf,ensureScores,enrichWaterfall,WATERFALL,industryLabel,industryKeys};
function aiAnalysis(p, params){
  const fit=!params.industry||params.industry==="all"||p.industry_key===params.industry?"son secteur correspond au profil recherché":"son secteur est proche du profil recherché";
  return `Cette entreprise semble correspondre au profil recherché en raison de ${fit} et de sa localisation (${p.city}). ${p.signals.length?"Signaux détectés : "+p.signals.join(", ")+".":""} Score de pertinence à considérer comme une estimation, pas une garantie.`;
}
window.KlirEngine={normStr,normPhone,normDomain,fingerprint,parseQuery,genProspects,dedup,scoreProspect,aiAnalysis,icpFit,intentOf,oppOf,ensureScores,enrichWaterfall,WATERFALL,industryLabel,industryKeys};
