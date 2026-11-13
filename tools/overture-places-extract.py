"""Extrait Overture Places borné aux six centres, depuis le S3 public.

Aucun téléchargement de la planète, aucun secret, aucun appel OpenCage.
Lecture anonyme PyArrow : seuls les row groups dont l'emprise intersecte
les rectangles de 2 200 m sont lus. La release est épinglée. Les rectangles
ne sont pas les limites administratives.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

RELEASE_PIN = "2026-10-21.0"
EXTRACT_RADIUS_M = 2200
EARTH_M_PER_DEGREE = 111320
MAX_FEATURES = 15_000
INDUSTRY_FLOOR = 250
S3_PREFIX = f"overturemaps-us-west-2/release/{RELEASE_PIN}/theme=places/type=place/"
COLUMNS = [
    "id",
    "names",
    "basic_category",
    "taxonomy",
    "addresses",
    "phones",
    "emails",
    "websites",
    "sources",
    "confidence",
    "operating_status",
    "bbox",
]

CITY_CENTERS = [
    {"key": "montréal", "countryCode": "CA", "latitude": 45.5017, "longitude": -73.5673},
    {"key": "laval", "countryCode": "CA", "latitude": 45.6066, "longitude": -73.7124},
    {"key": "québec", "countryCode": "CA", "latitude": 46.8139, "longitude": -71.208},
    {"key": "toronto", "countryCode": "CA", "latitude": 43.6532, "longitude": -79.3832},
    {"key": "paris", "countryCode": "FR", "latitude": 48.8566, "longitude": 2.3522},
    {"key": "lyon", "countryCode": "FR", "latitude": 45.764, "longitude": 4.8357},
    {"key": "marseille", "countryCode": "FR", "latitude": 43.2965, "longitude": 5.3698},
]

# Aligné sur tools/overture-places-bounds.mjs — garder les deux listes identiques.
INDUSTRY_CATEGORY_TOKENS = {
    "restauration": [
        "food_and_drink", "restaurant", "casual_eatery", "cafe", "coffee_shop", "bar",
        "pub", "bakery", "fast_food_restaurant", "pizzeria", "dessert_shop",
        "ice_cream_shop", "meal_takeaway", "tea_room", "bistro", "brasserie",
    ],
    "construction": [
        "building_or_construction_service", "contractor", "general_contractor",
        "plumbing", "electrician", "roofing", "painting", "masonry_contractor",
        "flooring_contractor", "carpentry", "construction", "hvac",
    ],
    "commerce": [
        "shopping", "fashion_and_apparel_store", "grocery_store", "food_and_beverage_store",
        "electronics_store", "hardware_home_and_garden_store", "specialty_store",
        "shopping_mall", "books_music_and_video_store", "convenience_store",
        "supermarket", "flowers_and_gifts_store", "sporting_goods_store",
        "department_store",
    ],
    "immobilier": ["real_estate_service", "real_estate", "property_management"],
    "sante": [
        "health_care", "outpatient_care_facility", "dental_clinic", "dentist",
        "general_dentistry", "physician", "pharmacy", "hospital", "physical_therapy",
        "primary_care_or_general_clinic", "wellness_service",
    ],
    "technologie": ["technical_service", "software", "it_service", "computer_service", "web_service"],
    "finance": ["financial_service", "bank_or_credit_union", "insurance", "accounting", "investment_service"],
    "services": [
        "professional_service", "attorney_or_law_firm", "home_service",
        "design_service", "event_or_party_service", "legal_service",
    ],
}

ATTRIBUTION = {
    "cdla": "Community Data License Agreement – Permissive, Version 2.0. Le partage des données exige de joindre le texte de cet accord. https://cdla.dev/permissive-2-0/",
    "apache": "Apache License 2.0. Fournir une copie de la licence, conserver les mentions, signaler les fichiers modifiés et la date. https://www.apache.org/licenses/LICENSE-2.0",
    "foursquare": "Copyright 2024 Foursquare Labs, Inc. All rights reserved. Données Foursquare transformées vers le schéma Overture. Changed: 2026-03-18.",
    "cc0": "AllThePlaces, CC0 1.0.",
    "placesNote": "Overture Places (thème places) ne contient pas de données OpenStreetMap et n'est pas publié sous ODbL. Cet extrait n'est pas fusionné avec le thème Divisions.",
    "sources": [
        "https://docs.overturemaps.org/guides/places/",
        "https://docs.overturemaps.org/attribution/",
        "https://cdla.dev/permissive-2-0/",
        "https://www.apache.org/licenses/LICENSE-2.0",
    ],
}


def round6(value: float) -> float:
    return round(value * 1_000_000) / 1_000_000


def radius_bbox(city: dict, radius_m: int = EXTRACT_RADIUS_M) -> dict:
    dlat = radius_m / EARTH_M_PER_DEGREE
    dlon = radius_m / (EARTH_M_PER_DEGREE * math.cos(math.radians(city["latitude"])))
    return {
        "name": f"{city['key']}-rayon-{radius_m}m",
        "west": round6(city["longitude"] - dlon),
        "south": round6(city["latitude"] - dlat),
        "east": round6(city["longitude"] + dlon),
        "north": round6(city["latitude"] + dlat),
        "radiusM": radius_m,
        "note": (
            f"Rectangle de travail d'un rayon de {radius_m} m autour du centre "
            f"déjà utilisé pour {city['key']}. Ce n'est pas la limite administrative de la ville."
        ),
    }


def row_group_bbox(row_group) -> tuple[float, float, float, float] | None:
    stats = {}
    for index in range(row_group.num_columns):
        column = row_group.column(index)
        path = column.path_in_schema
        if path in {"bbox.xmin", "bbox.xmax", "bbox.ymin", "bbox.ymax"} and column.statistics and column.statistics.has_min_max:
            stats[path] = (column.statistics.min, column.statistics.max)
    if len(stats) < 4:
        return None
    return stats["bbox.xmin"][0], stats["bbox.ymin"][0], stats["bbox.xmax"][1], stats["bbox.ymax"][1]


def overlaps(group_bbox, bbox: dict) -> bool:
    xmin, ymin, xmax, ymax = group_bbox
    return xmax >= bbox["west"] and xmin <= bbox["east"] and ymax >= bbox["south"] and ymin <= bbox["north"]


def as_dict(value):
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    if hasattr(value, "as_py"):
        converted = value.as_py()
        return converted if isinstance(converted, dict) else {}
    return {}


def as_list(value):
    if value is None:
        return []
    if isinstance(value, list):
        return value
    if hasattr(value, "as_py"):
        converted = value.as_py()
        return converted if isinstance(converted, list) else []
    return []


def category_tokens(row: dict) -> list[str]:
    taxonomy = as_dict(row.get("taxonomy"))
    values = [row.get("basic_category") or "", taxonomy.get("primary") or ""]
    values.extend(item for item in as_list(taxonomy.get("hierarchy")) if isinstance(item, str))
    values.extend(item for item in as_list(taxonomy.get("alternates")) if isinstance(item, str))
    return [item for item in values if item]


def industry_of(row: dict) -> str:
    tokens = set(category_tokens(row))
    for industry, allowed in INDUSTRY_CATEGORY_TOKENS.items():
        if tokens.intersection(allowed):
            return industry
    return "autre"


def compact_feature(row: dict) -> dict:
    names = as_dict(row.get("names"))
    taxonomy = as_dict(row.get("taxonomy"))
    addresses = as_list(row.get("addresses"))
    address = as_dict(addresses[0] if addresses else {})
    compact_address = {}
    for key in ("freeform", "locality", "region", "postcode", "country"):
        value = address.get(key)
        if isinstance(value, str) and value.strip():
            compact_address[key] = value.strip()
    sources = []
    for source in as_list(row.get("sources")):
        item = {}
        if not isinstance(source, dict):
            continue
        for key in ("dataset", "property", "record_id", "update_time", "license"):
            value = source.get(key)
            if isinstance(value, str) and value:
                item[key] = value
        if item:
            sources.append(item)
    bbox = as_dict(row.get("bbox"))
    lon = bbox.get("xmin")
    lat = bbox.get("ymin")
    properties = {
        "names": {"primary": names.get("primary") or ""},
        "basic_category": row.get("basic_category") or "",
        "taxonomy": {
            "primary": taxonomy.get("primary") or "",
            "hierarchy": [item for item in as_list(taxonomy.get("hierarchy")) if isinstance(item, str)],
            "alternates": [item for item in as_list(taxonomy.get("alternates")) if isinstance(item, str)],
        },
        "addresses": [compact_address] if compact_address else [],
        "sources": sources,
        "contactsVerified": False,
    }
    for key in ("phones", "emails", "websites"):
        values = [item.strip() for item in as_list(row.get(key)) if isinstance(item, str) and item.strip()]
        if values:
            properties[key] = values
    if row.get("confidence") is not None:
        properties["confidence"] = row["confidence"]
    if row.get("operating_status"):
        properties["operating_status"] = row["operating_status"]
    return {
        "id": row["id"],
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": properties,
    }


def keep_row(row: dict, bbox: dict) -> str | None:
    box = as_dict(row.get("bbox"))
    lon, lat = box.get("xmin"), box.get("ymin")
    if not row.get("id") or lon is None or lat is None:
        return "geometrie"
    if not (bbox["west"] <= lon <= bbox["east"] and bbox["south"] <= lat <= bbox["north"]):
        return "hors_emprise"
    names = as_dict(row.get("names"))
    primary = names.get("primary")
    if not isinstance(primary, str) or not primary.strip():
        return "nom_absent"
    if row.get("operating_status") == "permanently_closed":
        return "ferme"
    if row.get("confidence") == 0:
        return "confidence_nulle"
    return None


def confidence_key(row: dict):
    return (-(row.get("confidence") or 0), row["id"])


def truncate_balanced(rows: list[dict], limit: int = MAX_FEATURES, floor: int = INDUSTRY_FLOOR) -> tuple[list[dict], int]:
    if len(rows) <= limit:
        return rows, 0
    ranked = sorted(rows, key=confidence_key)
    buckets: dict[str, list[dict]] = {}
    for row in ranked:
        buckets.setdefault(industry_of(row), []).append(row)
    chosen: list[dict] = []
    chosen_ids: set[str] = set()
    for industry, bucket in buckets.items():
        take = bucket[: min(len(bucket), floor)]
        for row in take:
            if row["id"] not in chosen_ids and len(chosen) < limit:
                chosen.append(row)
                chosen_ids.add(row["id"])
    for row in ranked:
        if len(chosen) >= limit:
            break
        if row["id"] not in chosen_ids:
            chosen.append(row)
            chosen_ids.add(row["id"])
    chosen.sort(key=confidence_key)
    return chosen, len(rows) - len(chosen)


def extract_city(files, city: dict, radius_m: int) -> dict:
    bbox = radius_bbox(city, radius_m)
    skipped = {"nom_absent": 0, "ferme": 0, "confidence_nulle": 0, "geometrie": 0, "hors_emprise": 0}
    kept = []
    groups_read = 0
    files_read = []
    for path, parquet_file, groups in files:
        relevant = [index for index in groups if overlaps(groups[index], bbox)]
        if not relevant:
            continue
        files_read.append(Path(path).name)
        groups_read += len(relevant)
        table = parquet_file.read_row_groups(relevant, columns=COLUMNS)
        for row in table.to_pylist():
            reason = keep_row(row, bbox)
            if reason:
                skipped[reason] += 1
                continue
            kept.append(row)
    kept, truncated = truncate_balanced(kept)
    features = [compact_feature(row) for row in kept]
    payload = {
        "key": city["key"],
        "kind": "local-extract",
        "release": RELEASE_PIN,
        "countryCode": city["countryCode"],
        "bbox": bbox,
        "features": features,
        "truncated": truncated,
        "skipped": skipped,
        "filesRead": files_read,
        "rowGroupsRead": groups_read,
        "truncation": "balanced_industry_floor" if truncated else "none",
    }
    payload["bytes"] = len(json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    return payload


def open_places_files():
    try:
        import pyarrow.parquet as pq
        from pyarrow import fs
    except ImportError as error:
        raise SystemExit("pyarrow_absent: installer pyarrow dans un venv (pip install pyarrow), sans le commettre.") from error
    filesystem = fs.S3FileSystem(anonymous=True, region="us-west-2")
    infos = filesystem.get_file_info(fs.FileSelector(S3_PREFIX, recursive=False))
    opened = []
    for info in infos:
        if not info.path.endswith(".parquet"):
            continue
        parquet_file = pq.ParquetFile(info.path, filesystem=filesystem)
        groups = {}
        for index in range(parquet_file.metadata.num_row_groups):
            group_bbox = row_group_bbox(parquet_file.metadata.row_group(index))
            if group_bbox:
                groups[index] = group_bbox
        opened.append((info.path, parquet_file, groups))
    if not opened:
        raise SystemExit("extrait_vide")
    return opened


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Extrait borné Overture Places pour les centres pris en charge.")
    parser.add_argument("--out", type=Path, required=True, help="Fichier JSON de l'instantané compact.")
    parser.add_argument("--radius-m", type=int, default=EXTRACT_RADIUS_M)
    parser.add_argument("--python-check-only", action="store_true")
    parser.add_argument("--cities", default="", help="Clés de villes séparées par des virgules (défaut : toutes).")
    args = parser.parse_args(argv)
    if args.radius_m <= 0 or args.radius_m > EXTRACT_RADIUS_M:
        raise SystemExit("emprise_refusee")
    if args.python_check_only:
        print(json.dumps({"ok": True, "release": RELEASE_PIN, "radiusM": args.radius_m, "engine": "pyarrow"}))
        return 0
    wanted = [item.strip() for item in args.cities.split(",") if item.strip()]
    known = {city["key"] for city in CITY_CENTERS}
    if any(item not in known for item in wanted):
        raise SystemExit("ville_inconnue")
    selected = [city for city in CITY_CENTERS if not wanted or city["key"] in wanted]
    files = open_places_files()
    cities = [extract_city(files, city, args.radius_m) for city in selected]
    snapshot = {
        "release": RELEASE_PIN,
        "operational": False,
        "network": False,
        "geocoder": "none",
        "coverage": "rayon_2200m_six_centres" if args.radius_m == 2200 else f"rayon_{args.radius_m}m_six_centres",
        "categoriesColumn": "taxonomy_basic_category",
        "attribution": ATTRIBUTION,
        "engine": "pyarrow-s3-anonymous",
        "cities": cities,
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    snapshot["bytes"] = len(encoded)
    args.out.write_bytes(json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode("utf-8"))
    summary = {
        "release": RELEASE_PIN,
        "path": str(args.out),
        "bytes": snapshot["bytes"],
        "engine": snapshot["engine"],
        "cities": [
            {
                "key": city["key"],
                "features": len(city["features"]),
                "bytes": city["bytes"],
                "truncated": city["truncated"],
                "skipped": city["skipped"],
                "filesRead": city["filesRead"],
                "rowGroupsRead": city["rowGroupsRead"],
                "truncation": city["truncation"],
                "bbox": city["bbox"],
            }
            for city in cities
        ],
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
