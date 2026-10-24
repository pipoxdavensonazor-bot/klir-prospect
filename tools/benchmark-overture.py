"""Offline, fixed-release experiment. Never imported by the application/build.
Run using the isolated overturemaps environment; raw files stay outside the repo.
"""
import argparse
import collections
import hashlib
import importlib.metadata
import json
import math
from pathlib import Path
import statistics
import subprocess
import sys
import time
import unicodedata
from datetime import datetime, timezone

RELEASE = '2026-10-21.0'
CITIES = {'montreal': (45.5017, -73.5673), 'laval': (45.6066, -73.7124), 'quebec': (46.8139, -71.208)}
RADIUS_M = 2200
# Explicit crosswalk for this experiment, not a claim of taxonomy equivalence.
SECTORS = {
    'restauration': {'restaurant', 'cafe', 'coffee_shop', 'fast_food_restaurant', 'bar', 'pub'},
    'construction': {'building_or_construction_service', 'contractor', 'general_contractor', 'plumbing', 'electrician', 'roofing', 'painting', 'masonry_contractor', 'flooring_contractor', 'carpentry'},
    'sante': {'outpatient_care_facility', 'dental_clinic', 'dentist', 'general_dentistry', 'physician', 'pharmacy', 'hospital', 'physical_therapy', 'primary_care_or_general_clinic'}
}

def write(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')

def distance(lat, lon, point):
    y, x = point[1], point[0]
    a = math.sin(math.radians(y-lat)/2)**2 + math.cos(math.radians(lat))*math.cos(math.radians(y))*math.sin(math.radians(x-lon)/2)**2
    return 6371008.8 * 2 * math.asin(min(1, math.sqrt(a)))

def fold(value):
    return ''.join(c for c in unicodedata.normalize('NFKD', value.lower()) if c.isalnum())

def category_match(p, sector):
    taxonomy = p.get('taxonomy') or {}
    categories = {p.get('basic_category'), taxonomy.get('primary'), *(taxonomy.get('hierarchy') or [])}
    return bool(categories & SECTORS[sector])

def duplicate_key(f):
    p = f['properties']
    address = (p.get('addresses') or [{}])[0]
    # Conservative exact address+name. A domain alone never merges branches.
    name = fold((p.get('names') or {}).get('primary') or '')
    street = fold(address.get('freeform') or '')
    postcode = fold(address.get('postcode') or '')
    return (name, street, postcode) if name and street else ('id', f.get('id'))

def select(features, city, sector):
    lat, lon = CITIES[city]
    candidates = []
    for f in features:
        p, g = f.get('properties', {}), f.get('geometry', {})
        if g.get('type') != 'Point' or not category_match(p, sector):
            continue
        if p.get('operating_status') == 'permanently_closed' or p.get('confidence') == 0:
            continue
        if not (p.get('names') or {}).get('primary'):
            continue
        metres = distance(lat, lon, g['coordinates'])
        if metres <= RADIUS_M:
            candidates.append((metres, f.get('id', ''), f))
    candidates.sort(key=lambda x: (x[0], x[1]))
    unique, seen, duplicates = [], set(), []
    for metres, _, f in candidates:
        key = duplicate_key(f)
        if key in seen:
            duplicates.append(f.get('id'))
            continue
        seen.add(key)
        unique.append(f)
    return unique[:40], len(candidates), duplicates

def download(out, repeats):
    logs = []
    exe = Path(sys.executable).parent / ('overturemaps.exe' if sys.platform == 'win32' else 'overturemaps')
    for city, (lat, lon) in CITIES.items():
        # Slightly oversized bounding square, followed by exact radius filtering.
        dy, dx = 2210 / 111195, 2210 / (111195 * math.cos(math.radians(lat)))
        bbox = f'{lon-dx},{lat-dy},{lon+dx},{lat+dy}'
        for repeat in range(repeats):
            temp = out / f'{city}-download-{repeat+1}.geojson'
            cmd = [str(exe), 'download', '--release', RELEASE, '--bbox='+bbox, '--type', 'place', '-f', 'geojson', '-o', str(temp), '--connect_timeout', '15', '--request_timeout', '30']
            start = time.perf_counter()
            status, error = 'complete', None
            try:
                run = subprocess.run(cmd, capture_output=True, timeout=180)
                (out / f'{city}-download-{repeat+1}.log').write_bytes(run.stdout + run.stderr)
                if run.returncode:
                    status, error = 'error', f'exit {run.returncode}'
                else:
                    data = json.loads(temp.read_text(encoding='utf-8'))
                    if data.get('type') != 'FeatureCollection' or not isinstance(data.get('features'), list):
                        raise ValueError('invalid FeatureCollection')
                    # Retain a complete snapshot only. All source fields preserved.
                    (out / f'{city}.geojson').write_bytes(temp.read_bytes())
            except Exception as exc:
                status, error = 'error', f'{type(exc).__name__}: {exc}'
            row = {'city': city, 'repeat': repeat+1, 'status': status, 'error': error, 'seconds': time.perf_counter()-start, 'bbox': bbox, 'release': RELEASE}
            logs.append(row)
            write(out / 'downloads.json', logs)
            print(json.dumps(row), flush=True)
            # Error files are not interpreted as empty or used for the benchmark.

def benchmark(out, repeats):
    results, samples, manifest = [], [], []
    for city in CITIES:
        path = out / f'{city}.geojson'
        if not path.exists():
            for sector in SECTORS:
                results.append({'city': city, 'sector': sector, 'state': 'error', 'reason': 'No complete city snapshot', 'count': None})
            continue
        raw = path.read_bytes()
        start = time.perf_counter()
        data = json.loads(raw)
        parse_ms = (time.perf_counter()-start)*1000
        features = data['features']
        fields = collections.Counter(k for f in features for k in f['properties'])
        licences = collections.Counter(s.get('license') or 'UNSPECIFIED' for f in features for s in f['properties'].get('sources', []))
        manifest.append({'city': city, 'release': RELEASE, 'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw), 'raw_count': len(features), 'parse_ms': parse_ms, 'actual_properties': dict(fields), 'source_licenses': dict(licences)})
        for sector in SECTORS:
            times = []
            for repeat in range(repeats):
                start = time.perf_counter()
                selected, pool, duplicates = select(features, city, sector)
                times.append((time.perf_counter()-start)*1000)
            # Raw samples carry the entire original feature, not a lossy mapping.
            write(out / f'{city}-{sector}-selected.json', selected)
            ids = [f.get('id') for f in selected]
            row = {'city': city, 'sector': sector, 'state': 'complete' if selected else 'valid_empty', 'count': len(selected), 'candidate_count': pool, 'duplicate_candidates': len(duplicates), 'duplicate_ids': duplicates, 'website_present': sum(bool(f['properties'].get('websites')) for f in selected), 'phone_present': sum(bool(f['properties'].get('phones')) for f in selected), 'email_present': sum(bool(f['properties'].get('emails')) for f in selected), 'confidence_below_0_8': sum((f['properties'].get('confidence') or 0)<0.8 for f in selected), 'durations_ms': times, 'median_ms': statistics.median(times), 'min_ms': min(times), 'max_ms': max(times), 'ids': ids, 'new_useful_vs_osm': None, 'manual_relevance': 'see separate manual-review.json, no population extrapolation'}
            results.append(row)
            for f in selected[:2]:
                samples.append({'city':city, 'sector':sector, 'feature':f, 'manual_result':None, 'evidence_url':None})
    write(out / 'manifest.json', {'release': RELEASE, 'created_utc':datetime.now(timezone.utc).isoformat(), 'radius_m': RADIUS_M, 'centres':CITIES, 'maximum':40, 'crosswalk':{k:sorted(v) for k,v in SECTORS.items()}, 'python':sys.version, 'overturemaps_version':importlib.metadata.version('overturemaps'), 'snapshots':manifest})
    write(out / 'results.json', results)
    write(out / 'manual-sample.json', samples)
    print(json.dumps([{k:v for k,v in row.items() if k not in ('ids','duplicate_ids','durations_ms')} for row in results],ensure_ascii=False,indent=2))

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('mode', choices=['download','measure'])
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--repeats', type=int, default=5)
    args = parser.parse_args()
    args.out.mkdir(parents=True,exist_ok=True)
    if not 1 <= args.repeats <= 10:
        parser.error('repeats must be between 1 and 10')
    (download if args.mode == 'download' else benchmark)(args.out,args.repeats)
