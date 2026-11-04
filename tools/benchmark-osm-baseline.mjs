// Baseline only: no Supabase session, no credit reservation, no app integration.
import vm from 'node:vm';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
const out = resolve(process.argv[2] || '../verification/overture-benchmark');
await mkdir(out, { recursive:true });
const sandbox = { console, URL, AbortController, setTimeout, clearTimeout };
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const name of ['data.js','sources.js']) vm.runInContext(await readFile(new URL('../src/'+name,import.meta.url),'utf8'),sandbox);
const cities = { montreal:'montréal', laval:'laval', quebec:'québec' };
const results=[];
for(const [city,key] of Object.entries(cities)) {
  for(const sector of ['restauration','construction','sante']) {
    const query=sandbox.KlirSources.osm.query({city:sandbox.KlirData.CITIES[key],industry:sector,area:'radius'},40);
    await writeFile(join(out,`${city}-${sector}-osm-query.txt`),query);
    const started=performance.now();
    let result={city,sector,source:'OpenStreetMap',max:40,radius_m:2200,attempts:1};
    try {
      const response=await fetch('https://overpass-api.de/api/interpreter',{method:'POST',body:'data='+encodeURIComponent(query),headers:{'Content-Type':'application/x-www-form-urlencoded','Accept':'application/json','User-Agent':'KlirProspect-benchmark/0.1 (https://klirprospect.klirline.ca)'},signal:AbortSignal.timeout(18000)});
      const text=await response.text();
      result.http_status=response.status;
      await writeFile(join(out,`${city}-${sector}-osm-response.txt`),text);
      if(!response.ok) result={...result,state:'error',error:`HTTP ${response.status}`,count:null};
      else {
        const payload=JSON.parse(text);
        if(!Array.isArray(payload.elements)) throw new Error('Invalid elements');
        result={...result,state:payload.remark?'partial':payload.elements.length?'complete':'valid_empty',count:payload.elements.length,remark:payload.remark||null};
      }
    } catch(e) {result={...result,state:'error',count:null,error:e.name+': '+e.message};}
    result.seconds=(performance.now()-started)/1000;
    results.push(result);
    await writeFile(join(out,'osm-baseline.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify(result));
    await new Promise(r=>setTimeout(r,5000));
  }
}
