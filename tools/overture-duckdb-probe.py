#!/usr/bin/env python3
"""Sonde DuckDB bornée des six centres. N'écrit pas de planète ni de clé."""

import hashlib
import json
import subprocess
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "test" / "fixtures" / "overture-places-six-centers.json"
WEBMAIL = {"yahoo.com", "gmail.com", "hotmail.com", "outlook.com", "icloud.com", "live.com"}


def probes():
    raw = subprocess.check_output(
        ["node", "--input-type=module", "-e",
         "import { CITY_PROBES, probeBbox, RELEASE_PIN, PROBE_LIMIT } from './tools/overture-city-probes.mjs';"
         "console.log(JSON.stringify({release:RELEASE_PIN,limit:PROBE_LIMIT,cities:CITY_PROBES.map(city=>({...city,bbox:probeBbox(city)}))}))"],
        cwd=ROOT,
        text=True,
    )
    return json.loads(raw)


def partition_url(release, partition):
    index = int(partition.removeprefix("part-"))
    url = f"https://stac.overturemaps.org/{release}/places/place/{index:05d}/{index:05d}.json"
    with urllib.request.urlopen(url, timeout=20) as response:
        item = json.loads(response.read(200_000))
    href = item["assets"]["aws"]["href"]
    size = int(item["assets"]["aws"].get("file:size") or 0)
    return href, size


def rows_for(url, bbox, limit):
    import duckdb
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs; SET http_timeout=25;")
    query = """
      SELECT id,
             names.primary AS name,
             basic_category,
             taxonomy.primary AS taxonomy_primary,
             taxonomy.hierarchy AS taxonomy_hierarchy,
             bbox.xmin AS lon,
             bbox.ymin AS lat,
             addresses,
             phones,
             emails,
             websites,
             sources
      FROM read_parquet(?)
      WHERE bbox.xmin BETWEEN ? AND ?
        AND bbox.ymin BETWEEN ? AND ?
      LIMIT ?
    """
    table = con.execute(query, [url, bbox["west"], bbox["east"], bbox["south"], bbox["north"], limit]).fetchall()
    columns = ["id", "name", "basic", "primary", "hierarchy", "lon", "lat", "addresses", "phones", "emails", "websites", "sources"]
    return [dict(zip(columns, row)) for row in table]


def clean(value):
    if isinstance(value, (bytes, bytearray)):
        return None
    if isinstance(value, list):
        return [clean(item) for item in value]
    if isinstance(value, dict):
        return {key: clean(item) for key, item in value.items()}
    return value


def feature(row):
    emails = []
    omitted = 0
    for email in clean(row["emails"]) or []:
        domain = email.split("@")[-1].lower() if isinstance(email, str) and "@" in email else ""
        if domain in WEBMAIL:
            omitted += 1
            continue
        if isinstance(email, str):
            emails.append(email)
    sources = []
    for source in clean(row["sources"]) or []:
        if not isinstance(source, dict):
            continue
        sources.append({
            "dataset": source.get("dataset") or "",
            "property": source.get("property") or "",
            "record_id": source.get("record_id") or "",
            "update_time": source.get("update_time") or "",
            "license": source.get("license") or "",
        })
    addresses = []
    for address in clean(row["addresses"]) or []:
        if isinstance(address, dict):
            addresses.append({
                "locality": address.get("locality") or "",
                "country": address.get("country") or "",
                "freeform": address.get("freeform") or "",
            })
    return {
        "type": "Feature",
        "id": row["id"],
        "geometry": {"type": "Point", "coordinates": [row["lon"], row["lat"]]},
        "properties": {
            "names": {"primary": row["name"]},
            "basic_category": row["basic"] if isinstance(row["basic"], str) else "",
            "taxonomy": {
                "primary": row["primary"] if isinstance(row["primary"], str) else "",
                "hierarchy": row["hierarchy"] if isinstance(row["hierarchy"], list) else [],
            },
            "addresses": addresses,
            "phones": [item for item in (clean(row["phones"]) or []) if isinstance(item, str)],
            "emails": emails,
            "websites": [item for item in (clean(row["websites"]) or []) if isinstance(item, str)],
            "sources": sources,
        },
    }, omitted


def main():
    spec = probes()
    cities = []
    for city in spec["cities"]:
        href, size = partition_url(spec["release"], city["partition"])
        found = rows_for(href, city["bbox"], spec["limit"])
        features = []
        omitted = 0
        for row in found:
            item, skipped = feature(row)
            features.append(item)
            omitted += skipped
        cities.append({
            "key": city["key"],
            "countryCode": city["countryCode"],
            "partition": city["partition"],
            "partitionBytes": size,
            "kind": "local-extract",
            "release": spec["release"],
            "bbox": city["bbox"],
            "emailsOmittedFromRepo": omitted,
            "features": features,
        })
        print(city["key"], len(features), "omitted", omitted, "partition", size)
    payload = {
        "release": spec["release"],
        "operational": False,
        "geocoder": None,
        "categoriesColumn": False,
        "cities": cities,
    }
    raw = json.dumps(payload, ensure_ascii=False, indent=2).encode()
    payload["bytes"] = len(raw)
    raw = json.dumps(payload, ensure_ascii=False, indent=2).encode()
    if len(raw) > 1_048_576:
        raise SystemExit("extrait_trop_grand")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_bytes(raw)
    print("wrote", OUT, len(raw), hashlib.sha256(raw).hexdigest())


if __name__ == "__main__":
    main()
