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
const SEARCH_LIMITS=Object.freeze({min:10,max:40,defaultQuantity:40});
const COVERAGE_NOTE="Périmètre actuel : Montréal, Laval, Québec, Toronto, Paris et Lyon. Pas une couverture mondiale.";
const PARIS_OTHER=[
  {id:"paris-texas", label:"Paris, Texas, États-Unis", names:["texas"], codes:["tx"]},
  {id:"paris-ontario", label:"Paris, Ontario, Canada", names:["ontario"], codes:["on"]},
  {id:"paris-kentucky", label:"Paris, Kentucky, États-Unis", names:["kentucky"], codes:["ky"]},
  {id:"paris-tennessee", label:"Paris, Tennessee, États-Unis", names:["tennessee"], codes:["tn"]},
  {id:"paris-illinois", label:"Paris, Illinois, États-Unis", names:["illinois"], codes:["il"]},
  {id:"paris-idaho", label:"Paris, Idaho, États-Unis", names:["idaho"], codes:["id"]},
  {id:"paris-arkansas", label:"Paris, Arkansas, États-Unis", names:["arkansas"], codes:["ar"]},
  {id:"paris-maine", label:"Paris, Maine, États-Unis", names:["maine"], codes:["me"]}
];
const UNSUPPORTED_PLACES=[
  {id:"tokyo", folded:["tokyo"], exact:["東京","トウキョウ"]},
  {id:"sao-paulo", folded:["sao paulo"], exact:[]},
  {id:"casablanca", folded:["casablanca"], exact:["الدار البيضاء"]}
];
function supportedCityKeys(){return (KlirData.SUPPORTED_CITY_KEYS||[]).slice();}
function supportedCity(key){
  if(!supportedCityKeys().includes(key))return null;
  const city=KlirData.CITIES[key];
  return city&&city.supported!==false?city:null;
}
function supportedCityKeyByName(name){
  const wanted=foldText(name);
  if(!wanted)return null;
  return supportedCityKeys().find(key=>foldText(key)===wanted||foldText(KlirData.CITIES[key].city)===wanted)||null;
}
function foldText(value){return String(value||"").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g,"");}
function foldMap(value){
  const chars=Array.from(String(value||""));
  let folded="";
  const starts=[];
  chars.forEach((ch,index)=>{
    const piece=foldText(ch);
    for(let i=0;i<piece.length;i++)starts.push(index);
    folded+=piece;
  });
  return {chars,folded,starts};
}
function originalSlice(map,start,end){
  const from=start<=0?0:(map.starts[start]??map.chars.length);
  const to=end>=map.starts.length?map.chars.length:(map.starts[end]??map.chars.length);
  return map.chars.slice(from,to).join("");
}
function findFolded(folded,needle){
  const hits=[];
  const escaped=needle.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const re=new RegExp("(^|[^a-z0-9])("+escaped+")(?![a-z0-9])","g");
  let match;
  while((match=re.exec(folded))){
    const start=match.index+match[1].length;
    hits.push({start,end:start+match[2].length});
    if(!match[0].length)re.lastIndex++;
  }
  return hits;
}
function parisQualifier(folded,end){
  const window=folded.slice(end,end+28);
  const named=window.match(/^\s*,?\s*(texas|ontario|kentucky|tennessee|illinois|idaho|arkansas|maine|france|ile-de-france|ile de france)\b/);
  if(named)return named[1];
  const coded=window.match(/^\s*,\s*(tx|on|ky|tn|il|id|ar|me)\b/)||window.match(/^\s+(tx|on|ky|tn|il|id|ar|me)(?=\s*$|[\s]*[,.;])/);
  return coded?coded[1]:"";
}
function placeCandidate(cityKey){
  const city=supportedCity(cityKey);
  return {id:cityKey,cityKey,status:"supported",label:city.city+", "+city.province+", "+city.country};
}
function blockedPlace(status,display,candidates){
  const shown=String(display||"");
  const title={unsupported:"Lieu non pris en charge",ambiguous:"Lieu ambigu",not_found:"Lieu introuvable",absent:"Lieu absent"}[status]||"Lieu non recherché";
  let message;
  if(status==="unsupported")message="« "+shown+" » est reconnu, mais n'est pas pris en charge. "+COVERAGE_NOTE+" Aucune autre ville n'est recherchée. La ville affichée dans la liste n'est pas interrogée. Aucun crédit n'est réservé.";
  else if(status==="ambiguous")message="Plusieurs lieux correspondent : "+(candidates||[]).map(item=>item.label).join(" ; ")+". Confirmez un seul lieu. Aucune recherche n'est lancée et aucun crédit n'est réservé tant que le choix n'est pas confirmé. La ville affichée dans la liste n'est pas interrogée. "+COVERAGE_NOTE;
  else if(status==="absent")message="Aucun lieu n'est indiqué. Choisissez une des six villes prises en charge. "+COVERAGE_NOTE+" Aucune autre ville n'est recherchée. Aucun crédit n'est réservé.";
  else message=(shown?"« "+shown+" » n'a pas été reconnu. ":"Ce lieu n'a pas été reconnu. ")+"Choisissez Montréal, Laval, Québec, Toronto, Paris ou Lyon. "+COVERAGE_NOTE+" Aucune autre ville n'est recherchée. La ville affichée dans la liste n'est pas interrogée. Aucun crédit n'est réservé.";
  return {status,display:shown,title,message,candidates:candidates||[],cityKey:null};
}
function scopeFor(cityKey,industry,area){
  const limits=KlirData.SEARCH_SCOPE||{radiusAllM:1500,radiusSectorM:2200,montrealIsland:null};
  const island=area==="montreal_island"&&cityKey==="montréal";
  return {
    area:island?"montreal_island":"radius",
    radiusM:island?null:(industry==="all"?limits.radiusAllM:limits.radiusSectorM),
    bounds:island?limits.montrealIsland:null
  };
}
function describePlace(params){
  const place=params&&params.place||{};
  if(!params||place.status!=="supported"||!params.city)return place.message||"";
  const city=params.city;
  const scope=scopeFor(params.cityKey,params.industry,params.area);
  const area=scope.area==="montreal_island"&&scope.bounds
    ?"emprise de l'île de Montréal ("+scope.bounds.south+", "+scope.bounds.west+" → "+scope.bounds.north+", "+scope.bounds.east+")"
    :(scope.radiusM===1500?"rayon de 1,5 km":"rayon de 2,2 km");
  const note=params.cityKey==="paris"?" Les autres Paris (Texas, Ontario et autres homonymes) ne sont pas recherchés.":"";
  return industryLabel(params.industry)+" · "+city.city+", "+city.province+", "+city.country+" · centre "+city.lat+", "+city.lng+" · "+params.quantity+" résultats maximum · "+area+"."+note+" "+COVERAGE_NOTE+" Le nombre demandé n'est pas garanti.";
}
function collectPlaceHits(raw){
  const map=foldMap(raw);
  const hits=[];
  for(const key of supportedCityKeys()){
    const needle=foldText(key);
    for(const span of findFolded(map.folded,needle)){
      if(key==="paris"){
        const qualifier=parisQualifier(map.folded,span.end);
        const other=PARIS_OTHER.find(item=>item.names.includes(qualifier)||item.codes.includes(qualifier));
        if(other){
          const display=originalSlice(map,span.start,span.end)+" "+qualifier;
          hits.push({kind:"homonym",cityKey:key,id:other.id,label:other.label,display,start:span.start,end:span.end});
          continue;
        }
      }
      hits.push({kind:"catalog",cityKey:key,id:key,label:placeCandidate(key).label,display:originalSlice(map,span.start,span.end),start:span.start,end:span.end});
    }
  }
  for(const place of UNSUPPORTED_PLACES){
    for(const needle of place.folded){
      for(const span of findFolded(map.folded,needle)){
        hits.push({kind:"unsupported",id:place.id,label:originalSlice(map,span.start,span.end),display:originalSlice(map,span.start,span.end),start:span.start,end:span.end});
      }
    }
    for(const exact of place.exact){
      let from=0;
      while(raw.indexOf(exact,from)>=0){
        const at=raw.indexOf(exact,from);
        hits.push({kind:"unsupported",id:place.id,label:exact,display:exact,start:at,end:at+exact.length,exact:true});
        from=at+exact.length;
      }
    }
  }
  hits.sort((a,b)=>a.start-b.start||b.end-a.end);
  const kept=[];
  for(const hit of hits){
    if(kept.some(prev=>hit.start<prev.end&&hit.end>prev.start))continue;
    kept.push(hit);
  }
  return kept;
}
function trailingPlace(raw){
  const match=String(raw||"").match(/(?:^|[\s,;(])(?:autour de|around|near|vers|dans|aux|au|en|in|à|a)\s+([^,.;\n]{2,80})\s*$/iu);
  return match?match[1].trim():"";
}
function resolvePlace(raw){
  const hits=collectPlaceHits(raw);
  if(!hits.length){
    const named=trailingPlace(raw);
    return named?blockedPlace("not_found",named):blockedPlace("absent","");
  }
  if(hits.length>1||hits[0].kind==="homonym"){
    const candidates=[];
    for(const hit of hits){
      if(hit.kind==="homonym"){
        candidates.push(placeCandidate(hit.cityKey),{id:hit.id,cityKey:null,status:"unsupported",label:hit.label});
      }else if(hit.kind==="catalog")candidates.push(placeCandidate(hit.cityKey));
      else candidates.push({id:hit.id,cityKey:null,status:"unsupported",label:hit.display});
    }
    const unique=[];
    for(const candidate of candidates){
      if(!unique.some(item=>item.id===candidate.id&&item.label===candidate.label))unique.push(candidate);
    }
    return blockedPlace("ambiguous",hits.map(hit=>hit.display).join(" · "),unique);
  }
  const hit=hits[0];
  if(hit.kind==="unsupported")return blockedPlace("unsupported",hit.display);
  return {status:"supported",display:hit.display,title:"Lieu pris en charge",message:"",candidates:[placeCandidate(hit.cityKey)],cityKey:hit.cityKey};
}
function normalizeSearchParams(params,overrides={}){
  const next={...params,...overrides};
  const quantity=Number(next.quantity);
  next.quantity=Number.isFinite(quantity)&&quantity>0
    ?Math.min(SEARCH_LIMITS.max,Math.max(SEARCH_LIMITS.min,Math.floor(quantity)))
    :SEARCH_LIMITS.defaultQuantity;
  if(!KlirData.INDUSTRIES[next.industry])next.industry="all";
  const keyProvided=Object.prototype.hasOwnProperty.call(overrides,"cityKey");
  const key=keyProvided?overrides.cityKey:next.cityKey;
  const city=supportedCity(key);
  next.cityKey=city?key:null;
  next.city=city;
  if(!next.place||typeof next.place!=="object")next.place=city?{status:"supported",cityKey:key,display:city.city,title:"Lieu pris en charge",message:"",candidates:[placeCandidate(key)]}:blockedPlace("not_found","");
  if(!city&&next.place.status==="supported")next.place=blockedPlace("not_found",next.place.display||"");
  next.area=next.area==="montreal_island"&&next.cityKey==="montréal"?"montreal_island":"radius";
  next.size=["1–10","11–50","51–200","201–500","500+"].includes(next.size)?next.size:null;
  if(next.place.status==="supported"&&city)next.place={...next.place,status:"supported",cityKey:next.cityKey,message:""};
  return next;
}
function attachControls(parsed,explicit){
  return {
    industry:explicit.industry!=null?explicit.industry:parsed.industry,
    quantity:explicit.quantity!=null?explicit.quantity:parsed.quantity,
    size:Object.prototype.hasOwnProperty.call(explicit,"size")?explicit.size:parsed.size,
    area:explicit.area||parsed.area,
    raw:parsed.raw
  };
}
function withSupportedCity(parsed,controls,cityKey){
  const next=normalizeSearchParams({...parsed,...controls,place:{...parsed.place,status:"supported",cityKey}},{cityKey});
  next.place.message="";
  return next;
}
function withBlockedPlace(parsed,controls,place){
  const next=normalizeSearchParams({...parsed,...controls,place},{cityKey:null});
  next.place=place;
  next.cityKey=null;
  next.city=null;
  return next;
}
function applyExplicitPlace(parsed,explicit){
  const source=parsed&&parsed.place?parsed:parseQuery(parsed&&parsed.raw||"");
  const controls=attachControls(source,explicit||{});
  const place=source.place;
  if(place.status==="unsupported"||place.status==="not_found")return withBlockedPlace(source,controls,place);
  if(place.status==="ambiguous"){
    const confirmation=explicit&&explicit.placeConfirmation;
    const chosen=(place.candidates||[]).find(item=>item.cityKey===confirmation||item.id===confirmation);
    if(!chosen)return withBlockedPlace(source,controls,place);
    if(chosen.status!=="supported")return withBlockedPlace(source,controls,blockedPlace("unsupported",chosen.label));
    return withSupportedCity(source,controls,chosen.cityKey);
  }
  if(place.status==="supported"&&supportedCity(explicit&&explicit.cityKey))return withSupportedCity(source,controls,explicit.cityKey);
  if(place.status==="supported")return withSupportedCity(source,controls,place.cityKey);
  if(supportedCity(explicit&&explicit.cityKey))return withSupportedCity({...source,place:{status:"supported",cityKey:explicit.cityKey,display:supportedCity(explicit.cityKey).city,title:"Lieu pris en charge",message:"",candidates:[placeCandidate(explicit.cityKey)]}},controls,explicit.cityKey);
  return withBlockedPlace(source,controls,blockedPlace("not_found",""));
}
function parseQuery(q){
  q=(q||""); const low=foldText(q);
  const allAsked=/tous les (domaines|secteurs|industries)|toutes les (industries|activites)|tous secteurs|multi[- ]secteurs/.test(low);
  let industry="all", score=0;
  if(!allAsked){
    for(const [k,v] of Object.entries(KlirData.INDUSTRIES)){let s=0;const label=foldText(v.label||"");if(label&&low.includes(label))s+=3;for(const kw of v.keywords){if(low.includes(foldText(kw)))s++;}if(s>score){score=s;industry=k;}}
    if(!score)industry="all";
  }
  const place=resolvePlace(q);
  let qty=SEARCH_LIMITS.defaultQuantity;
  // A quantity must describe prospects, not a year or a company-size range.
  const m=low.match(/(?:^|[^\d–-])(\d+)\s*(?:entreprises?|prospects?|boites?|companies|restaurants?|cliniques?|artisans?)\b/)
    ||low.match(/^\s*(\d+)(?!\d|\s*[–-]\s*\d)(?:\s|$)/);
  if(m)qty=Number(m[1]);
  let size=null; if(/1-10|tpe|artisan/i.test(q))size="1–10"; else if(/11-50|pme/i.test(q))size="11–50";
  return normalizeSearchParams({industry,cityKey:place.cityKey,quantity:qty,size,raw:q,place});
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
function identityPairs(p){
  return [normPhone(p.phone),normEmail(p.public_email),normDomain(p.domain||p.website),normStr(p.address)];
}
function identitiesConflict(a,b){
  const left=identityPairs(a), right=identityPairs(b);
  return left.some((value,index)=>value&&right[index]&&value!==right[index]);
}
function identitiesCorroborate(a,b){
  if(normStr(a.company_name)!==normStr(b.company_name)||identitiesConflict(a,b))return false;
  const left=identityPairs(a), right=identityPairs(b);
  return left.some((value,index)=>value&&value===right[index]);
}
function dedup(list){
  const seen=new Map(), unique=[], dups=[];
  for(const p of list){
    const phone=normPhone(p.phone), domain=normDomain(p.domain||p.website);
    const f=fingerprint(p);
    if((phone||domain)&&seen.has(f)){dups.push({kept:seen.get(f),dup:p});continue;}
    if(phone||domain)seen.set(f,p);
    unique.push(p);
  }
  const byNameCity=new Map();
  for(const p of unique){
    const k=normStr(p.company_name)+"|"+normStr(p.city);
    const group=byNameCity.get(k)||[];
    const twin=group.find(prev=>identitiesCorroborate(prev,p));
    if(twin)dups.push({kept:twin,dup:p});
    else group.push(p);
    byNameCity.set(k,group);
  }
  const byEmail=new Map();
  for(const p of unique){
    if(!p.public_email)continue;
    const e=normEmail(p.public_email);
    if(byEmail.has(e)){const kept=byEmail.get(e);if(!identitiesConflict(kept,p))dups.push({kept,dup:p,level:"exact"});}
    else byEmail.set(e,p);
  }
  const byPhone=new Map();
  for(const p of unique){
    if(!p.phone)continue;
    const n=normPhone(p.phone);
    if(byPhone.has(n)){const kept=byPhone.get(n);if(!identitiesConflict(kept,p))dups.push({kept,dup:p});}
    else byPhone.set(n,p);
  }
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
  chk(!icp.industry||icp.industry==="all"||p.industry_key===icp.industry,30); chk(!!icp.city&&normStr(p.city)===normStr(icp.city),20);
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
  for(const src of chain){
    if(src==="registre"&&p.legal_name){tryFill("legal_name",p.legal_name,src);}
    if(src==="maps"&&p.address){tryFill("address",p.address,src);}
    if(src==="web"&&p.website){tryFill("website",p.website,src);}
    if(src==="directory"&&p.public_email){tryFill("public_email",p.public_email,src);}
  }
  p.enrichedFrom=prov;
  return {filled, chain};
}
window.KlirEngine={SEARCH_LIMITS,COVERAGE_NOTE,normalizeSearchParams,applyExplicitPlace,resolvePlace,describePlace,supportedCity,supportedCityKeys,supportedCityKeyByName,normStr,normPhone,normDomain,fingerprint,parseQuery,genProspects,dedup,identitiesConflict,identitiesCorroborate,scoreProspect,aiAnalysis,icpFit,intentOf,oppOf,ensureScores,enrichWaterfall,WATERFALL,industryLabel,industryKeys};
function aiAnalysis(p, params){
  const fit=!params.industry||params.industry==="all"||p.industry_key===params.industry?"son secteur correspond au profil recherché":"son secteur est proche du profil recherché";
  return `Cette entreprise semble correspondre au profil recherché en raison de ${fit} et de sa localisation (${p.city}). ${p.signals.length?"Signaux détectés : "+p.signals.join(", ")+".":""} Score de pertinence à considérer comme une estimation, pas une garantie.`;
}
window.KlirEngine={SEARCH_LIMITS,COVERAGE_NOTE,normalizeSearchParams,applyExplicitPlace,resolvePlace,describePlace,supportedCity,supportedCityKeys,supportedCityKeyByName,normStr,normPhone,normDomain,fingerprint,parseQuery,genProspects,dedup,identitiesConflict,identitiesCorroborate,scoreProspect,aiAnalysis,icpFit,intentOf,oppOf,ensureScores,enrichWaterfall,WATERFALL,industryLabel,industryKeys};
