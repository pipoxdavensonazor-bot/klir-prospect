"""Size a disposable local SQLite copy; not a production database migration."""
import argparse
import ctypes
import gzip
import json
from pathlib import Path
import sqlite3
import sys
import time

parser=argparse.ArgumentParser()
parser.add_argument('--out',type=Path,required=True)
out=parser.parse_args().out
db=out/'regional-prototype.sqlite'
con=sqlite3.connect(db)
con.execute('create table if not exists places(id text primary key,lat real,lon real,raw_json text)')
con.execute('delete from places')
started=time.perf_counter()
count=size=0
for city in ['montreal','laval','quebec']:
    raw=(out/f'{city}.geojson').read_bytes()
    size+=len(raw)
    with gzip.open(out/f'{city}.geojson.gz','wb') as f: f.write(raw)
    for feature in json.loads(raw)['features']:
        x,y=feature['geometry']['coordinates']
        con.execute('insert or ignore into places values(?,?,?,?)',(feature['id'],y,x,json.dumps(feature,ensure_ascii=False,separators=(',',':'))))
        count+=1
con.execute('create index if not exists places_lat_lon on places(lat,lon)')
con.commit()
con.close()
elapsed=time.perf_counter()-started
peak=None
if sys.platform=='win32':
    import ctypes.wintypes as w
    class PMC(ctypes.Structure):
        _fields_=[('cb',w.DWORD),('PageFaultCount',w.DWORD)]+[(n,ctypes.c_size_t) for n in ['PeakWorkingSetSize','WorkingSetSize','QuotaPeakPagedPoolUsage','QuotaPagedPoolUsage','QuotaPeakNonPagedPoolUsage','QuotaNonPagedPoolUsage','PagefileUsage','PeakPagefileUsage']]
    m=PMC();m.cb=ctypes.sizeof(m)
    process=ctypes.windll.kernel32.GetCurrentProcess
    process.restype=w.HANDLE
    getmem=ctypes.windll.psapi.GetProcessMemoryInfo
    getmem.argtypes=[w.HANDLE,ctypes.POINTER(PMC),w.DWORD]
    if getmem(process(),ctypes.byref(m),m.cb): peak=m.PeakWorkingSetSize
result={'raw_bytes':size,'gzip_bytes':sum(x.stat().st_size for x in out.glob('*.geojson.gz')),'rows_processed':count,'sqlite_bytes':db.stat().st_size,'import_gzip_index_seconds':elapsed,'peak_working_set_bytes':peak,'note':'Local SQLite prototype, not a Postgres/D1/Worker performance estimate; existing index may be reused on subsequent runs.'}
(out/'resource-measurements.json').write_text(json.dumps(result,indent=2),encoding='utf8')
print(json.dumps(result))
