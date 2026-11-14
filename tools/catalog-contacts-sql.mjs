// Prépare les lots SQL de private.search_catalog_contacts (site et téléphone publiés)
// à partir des extractions Overture 2026-10-21.0 déjà utilisées pour le catalogue.
// Usage : node tools/catalog-contacts-sql.mjs <sortie> <extraction.json>...
// Aucun réseau. Insertion seulement si le lieu existe déjà dans le catalogue.
import { mkdir, readFile, writeFile } from "node:fs/promises";

export const CONTACTS_BATCH = 2500;
const WEBSITE = /^https?:\/\//i;

export function firstWebsite(values) {
  for (const value of Array.isArray(values) ? values : []) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text && text.length <= 300 && WEBSITE.test(text)) return text;
  }
  return null;
}

export function firstPhone(values) {
  for (const value of Array.isArray(values) ? values : []) {
    const text = typeof value === "string" ? value.trim() : "";
    if (text && text.length <= 40) return text;
  }
  return null;
}

export function contactRows(document) {
  const cities = Array.isArray(document && document.cities) ? document.cities : [];
  const rows = [];
  for (const city of cities) {
    for (const feature of Array.isArray(city.features) ? city.features : []) {
      const props = feature && feature.properties || {};
      const website = firstWebsite(props.websites);
      const phone = firstPhone(props.phones);
      if (!feature.id || (!website && !phone)) continue;
      rows.push({ city_key: city.key, id: String(feature.id), website, phone });
    }
  }
  return rows;
}

const q = (value) => value == null ? "null" : "'" + String(value).replace(/'/g, "''") + "'";

export function contactBatchSql(rows) {
  const values = rows.map((r) => `(${q(r.city_key)},${q(r.id)},${q(r.website)},${q(r.phone)})`).join(",\n");
  return `insert into private.search_catalog_contacts (city_key, id, website, phone)
select v.city_key, v.id, v.website, v.phone
from (values\n${values}\n) as v(city_key, id, website, phone)
join private.search_catalog_places p on p.city_key = v.city_key and p.id = v.id
on conflict (city_key, id) do nothing;`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [out, ...inputs] = process.argv.slice(2);
  if (!out || !inputs.length) throw new Error("usage: sortie extraction.json...");
  await mkdir(out, { recursive: true });
  let all = [];
  for (const input of inputs) all = all.concat(contactRows(JSON.parse(await readFile(input, "utf8"))));
  let n = 0;
  for (let i = 0; i < all.length; i += CONTACTS_BATCH) {
    n += 1;
    await writeFile(`${out}/contacts-${String(n).padStart(3, "0")}.sql`, contactBatchSql(all.slice(i, i + CONTACTS_BATCH)));
  }
  console.log(JSON.stringify({ rows: all.length, batches: n, websites: all.filter((r) => r.website).length, phones: all.filter((r) => r.phone).length }));
}
