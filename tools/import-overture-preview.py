"""Offline importer. Requires the existing test-only secret in a local file, never logs it.
No production host, no dependency on the application, preserves complete original features.
"""
import argparse
import csv
import importlib.util
import json
from pathlib import Path
import time
import urllib.request

spec=importlib.util.spec_from_file_location('benchmark',Path(__file__).with_name('benchmark-overture.py'))
benchmark=importlib.util.module_from_spec(spec)
spec.loader.exec_module(benchmark)
parser=argparse.ArgumentParser()
parser.add_argument('--catalogue',type=Path,required=True)
parser.add_argument('--credentials',type=Path,required=True)
parser.add_argument('--prepare-only',action='store_true')
args=parser.parse_args()
config=json.loads(args.credentials.read_text('utf8')) if not args.prepare_only else None
if config and config['url']!='https://pwakjxjjxswdjsapsbxn.supabase.co':
    raise SystemExit('Only the dedicated test project is allowed')

def rpc(name,payload):
    headers={'apikey':config['key'],'Content-Type':'application/json'}
    if config['key'].startswith('eyJ'): headers['Authorization']='Bearer '+config['key']
    req=urllib.request.Request(config['url']+'/rest/v1/rpc/'+name,data=json.dumps(payload,ensure_ascii=False).encode(),headers=headers,method='POST')
    with urllib.request.urlopen(req,timeout=30) as response:
        return json.loads(response.read())

started=time.perf_counter()
metrics={'release':benchmark.RELEASE,'cities':[]}
if config: metrics['before']=rpc('overture_admin',{'p_action':'metrics'})
for city in benchmark.CITIES:
    source=args.catalogue/(city+'.geojson')
    data=json.loads(source.read_text('utf8'))
    rows=[]
    for feature in data['features']:
        p=feature['properties']
        sectors=[s for s in benchmark.SECTORS if benchmark.category_match(p,s)]
        if p.get('operating_status')=='permanently_closed' or p.get('confidence')==0 or not (p.get('names') or {}).get('primary'):
            sectors=[]
        rows.append({'original':feature,'sectors':sectors,'duplicate_key':json.dumps(benchmark.duplicate_key(feature),ensure_ascii=False)})
    prepared=args.catalogue/(city+'-import.json')
    prepared.write_text(json.dumps(rows,ensure_ascii=False),encoding='utf8')
    with (args.catalogue/(city+'-import.csv')).open('w',encoding='utf8',newline='') as file:
        writer=csv.writer(file)
        writer.writerow(['release','city','id','lat','lon','sectors','duplicate_key','original'])
        for row in rows:
            f=row['original']; lon,lat=f['geometry']['coordinates'][:2]
            writer.writerow([benchmark.RELEASE,city,f['id'],lat,lon,'{'+','.join(row['sectors'])+'}',row['duplicate_key'],json.dumps(f,ensure_ascii=False)])
    # Alternative for the authorized SQL Editor; no privileged key extraction.
    for offset in range(0,len(rows),2000):
        statements=[]
        for start in range(offset,min(offset+2000,len(rows)),200):
            payload=json.dumps(rows[start:min(start+200,offset+2000)],ensure_ascii=False).replace("'","''")
            statements.append("select public.overture_import('%s','%s','%s'::jsonb);"%(city,benchmark.RELEASE,payload))
        (args.catalogue/f'{city}-import-{offset//2000:02}.sql').write_text('\n'.join(statements),encoding='utf8')
    city_start=time.perf_counter()
    inserted=0
    if config:
        for offset in range(0,len(rows),200):
            inserted+=rpc('overture_import',{'p_city':city,'p_release':benchmark.RELEASE,'p_rows':rows[offset:offset+200]})
    metrics['cities'].append({'city':city,'rows':len(rows),'inserted':inserted,'seconds':time.perf_counter()-city_start})
    print(city,len(rows),'prepared' if args.prepare_only else 'imported',flush=True)
if config: metrics['after']=rpc('overture_admin',{'p_action':'finalize'})
metrics['total_seconds']=time.perf_counter()-started
(args.catalogue/'hosted-import.json').write_text(json.dumps(metrics,indent=2),encoding='utf8')
print(json.dumps(metrics,indent=2))
