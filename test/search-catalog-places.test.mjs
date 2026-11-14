import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { INDUSTRY_CATEGORY_TOKENS, radiusBbox, CITY_CENTERS } from "../tools/overture-places-bounds.mjs";
import { RELEASE_PIN } from "../tools/overture-places-import.mjs";
import { catalogRowsFromSnapshot, snapshotGuard } from "../tools/overture-places-load-test.mjs";
import { CATALOG_LOOKUP_SQL, createCatalogQueryProvider } from "../supabase/functions/_shared/search-job-overture-pilot.mjs";

const catalogSql = await readFile(new URL("../supabase/migrations/20261113120000_search_catalog_places.sql", import.meta.url), "utf8");
const snapshotSql = await readFile(new URL("../supabase/migrations/20261108163000_search_pilot_snapshot.sql", import.meta.url), "utf8");
const loadTool = await readFile(new URL("../tools/overture-places-load-test.mjs", import.meta.url), "utf8");
const contactsSql = (await readFile(new URL("../supabase/migrations/20261114020000_web_opportunity_contacts.sql", import.meta.url), "utf8")).split("-- Fiches de résultats du propriétaire")[0];
const runnerSql = await readFile(new URL("../supabase/functions/_shared/search-job-runner-edge.mjs", import.meta.url), "utf8");

const stub = `
create schema if not exists private;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'klir_job_api') then create role klir_job_api nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'klir_job_runner') then create role klir_job_runner nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'klir_job_connect_test') then create role klir_job_connect_test nologin noinherit; end if;
end
$$;
grant usage on schema private to klir_job_runner;
`;

function feature(id, name, lon, lat, tokens, locality = "Laval") {
  return {
    id,
    type: "Feature",
    geometry: { type: "Point", coordinates: [lon, lat] },
    properties: {
      names: { primary: name },
      basic_category: tokens[0],
      taxonomy: { primary: tokens[0], hierarchy: tokens, alternates: [] },
      addresses: [{ locality, country: "CA" }],
      sources: [{ dataset: "meta", license: "CDLA-Permissive-2.0" }]
    }
  };
}

function lavalSnapshot(features) {
  const city = CITY_CENTERS.find((item) => item.key === "laval");
  return {
    release: RELEASE_PIN,
    coverage: "rayon_2200m_six_centres",
    cities: ["montréal", "laval", "québec", "toronto", "paris", "lyon"].map((key) => ({
      key,
      kind: "local-extract",
      release: RELEASE_PIN,
      bbox: radiusBbox(CITY_CENTERS.find((item) => item.key === key)),
      features: key === "laval" ? features : [
        feature(`${key}-probe`, "Sonde", CITY_CENTERS.find((item) => item.key === key).longitude, CITY_CENTERS.find((item) => item.key === key).latitude, ["cafe"])
      ]
    }))
  };
}

async function database() {
  const db = new PGlite();
  await db.exec(stub);
  await db.exec(snapshotSql);
  await db.exec(catalogSql);
  await db.exec(contactsSql);
  return db;
}

test("la migration force le RLS, n'accorde rien à anon, et borne la lecture du runner", () => {
  assert.match(catalogSql, /create table if not exists private\.search_catalog_places/);
  assert.match(catalogSql, /enable row level security/);
  assert.match(catalogSql, /force row level security/);
  assert.match(catalogSql, /revoke all on table private\.search_catalog_places/);
  assert.match(catalogSql, /grant execute on function private\.search_catalog_lookup\(text, text, integer\) to klir_job_runner/);
  assert.doesNotMatch(catalogSql, /jobs_enabled\s*=\s*true/);
  assert.doesNotMatch(catalogSql, /grant (select|insert|update|delete) on table private\.search_catalog_places to (anon|authenticated|public)/i);
  assert.doesNotMatch(catalogSql, /grant execute on function public\.(reserve_usage|settle_usage)/i);
  assert.match(catalogSql, /limit v_limit/);
  assert.match(loadTool, /insert into private\.search_catalog_places/);
  assert.doesNotMatch(loadTool, /update private\.search_pilot_snapshot set document/);
  assert.match(runnerSql, /createCatalogQueryProvider/);
  assert.doesNotMatch(runnerSql, /pilot_snapshot\(\)/);
  assert.match(CATALOG_LOOKUP_SQL, /private\.search_catalog_lookup_contacts\(\$1, \$2, \$3\)/);
  assert.match(contactsSql, /grant execute on function private\.search_catalog_lookup_contacts\(text, text, integer\) to klir_job_runner/);
  assert.match(contactsSql, /force row level security/);
});

test("les jetons de secteur du SQL restent alignés sur le module JS", () => {
  for (const [industry, tokens] of Object.entries(INDUSTRY_CATEGORY_TOKENS)) {
    const block = catalogSql.split(`when '${industry}' then`)[1];
    assert.ok(block, industry);
    for (const token of tokens) {
      assert.match(block.split("::text[]")[0], new RegExp(`'${token}'`));
    }
  }
});

test("une table vide se rabat sur l'instantané sonde, sans agrégat, avec LIMIT", async () => {
  const db = await database();
  const city = CITY_CENTERS.find((item) => item.key === "laval");
  const snapshot = lavalSnapshot([
    feature("food-1", "Café Testé", city.longitude, city.latitude, ["cafe", "food_and_drink"]),
    feature("shop-1", "Boutique Test", city.longitude, city.latitude, ["fashion_and_apparel_store", "shopping"]),
    feature("build-1", "Toiture", city.longitude, city.latitude, ["building_or_construction_service"])
  ]);
  await db.query(
    "insert into private.search_pilot_snapshot (singleton, document) values (true, $1::jsonb)",
    [JSON.stringify(snapshot)]
  );
  const empty = await db.query("select count(*)::int as n from private.search_catalog_places");
  assert.equal(empty.rows[0].n, 0);
  const food = await db.query("select * from private.search_catalog_lookup($1, $2, $3)", ["laval", "restauration", 10]);
  assert.equal(food.rows.length, 1);
  assert.equal(food.rows[0].name, "Café Testé");
  const all = await db.query("select * from private.search_catalog_lookup($1, $2, $3)", ["laval", "all", 10]);
  assert.equal(all.rows.length, 3);
  const unknown = await db.query("select * from private.search_catalog_lookup($1, $2, $3)", ["laval", "secteur-inconnu", 10]);
  assert.equal(unknown.rows.length, 0);
  const capped = await db.query("select * from private.search_catalog_lookup($1, $2, $3)", ["laval", "all", 2]);
  assert.equal(capped.rows.length, 2);
  const zero = await db.query("select * from private.search_catalog_lookup($1, $2, $3)", ["laval", "all", 0]);
  assert.equal(zero.rows.length, 0);
  const refused = await db.query("select * from private.search_catalog_lookup($1, $2, $3)", ["ottawa", "all", 10]);
  assert.equal(refused.rows.length, 0);
});

test("la table remplie est lue à la place de l'instantané, avec un plafond de 40", async () => {
  const db = await database();
  const city = CITY_CENTERS.find((item) => item.key === "laval");
  const features = Array.from({ length: 45 }, (_, index) => feature(
    `laval-${String(index).padStart(3, "0")}`,
    index % 2 ? `Café ${index}` : `Boutique ${index}`,
    city.longitude,
    city.latitude,
    index % 2 ? ["cafe", "food_and_drink"] : ["fashion_and_apparel_store", "shopping"]
  ));
  const snapshot = lavalSnapshot(features);
  snapshotGuard(snapshot, 1000);
  const prepared = catalogRowsFromSnapshot(snapshot);
  const laval = prepared.cities.find((item) => item.key === "laval");
  assert.equal(laval.features, 45);
  for (const row of prepared.rows.filter((item) => item.city_key === "laval")) {
    await db.query(
      `insert into private.search_catalog_places (
         city_key, id, name, basic_category, category_tokens, locality, country,
         latitude, longitude, sources, licenses, release
       ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)`,
      [
        row.city_key, row.id, row.name, row.basic_category, row.category_tokens,
        row.locality, row.country, row.latitude, row.longitude,
        JSON.stringify(row.sources), row.licenses, row.release
      ]
    );
  }
  const count = await db.query("select count(*)::int as n from private.search_catalog_places where city_key = 'laval'");
  assert.equal(count.rows[0].n, 45);
  const food = await db.query("select * from private.search_catalog_lookup($1, $2, $3)", ["laval", "restauration", 10]);
  assert.equal(food.rows.length, 10);
  const all = await db.query("select * from private.search_catalog_lookup($1, $2, $3)", ["laval", "all", 100]);
  assert.equal(all.rows.length, 40);
  const provider = createCatalogQueryProvider(async (text, params) => {
    assert.equal(text, CATALOG_LOOKUP_SQL);
    return db.query(text, params);
  });
  await db.query("insert into private.search_catalog_contacts(city_key,id,website,phone) values ('laval','laval-001','https://www.facebook.com/cafe1','+1 450 555 0101'),('laval','laval-003',null,'+1 450 555 0103')");
  await assert.rejects(db.query("insert into private.search_catalog_contacts(city_key,id,website) values ('laval','laval-005','javascript:alert(1)')"), /website_chk/);
  await assert.rejects(db.query("insert into private.search_catalog_contacts(city_key,id,website) values ('laval','absent','https://a.example')"), /place_fk/);
  const ran = await provider.run({ place_status: "supported", cityKey: "laval", industry: "restauration", quantity: 10 });
  assert.equal(ran.count, 10);
  const byId = Object.fromEntries(ran.records.map((r) => [r.gersId, r]));
  assert.equal(byId["laval-001"].website, "https://www.facebook.com/cafe1");
  assert.equal(byId["laval-001"].phone, "+1 450 555 0101");
  assert.equal(byId["laval-003"].website, "");
  assert.equal(byId["laval-007"].phone, "");
  assert.ok(ran.records.every((r) => r.contactFields === true));
  assert.equal(ran.contactsVerified, false);
  assert.equal(ran.network, undefined);
  assert.equal(provider.network, false);
  await assert.rejects(
    provider.run({ place_status: "supported", cityKey: "ottawa", quantity: 10 }),
    /place_rejected/
  );
});

test("anon et authenticated n'ont aucun droit sur la table ni sur la fonction", async () => {
  const db = await database();
  await db.query(
    `insert into private.search_catalog_places (
       city_key, id, name, basic_category, category_tokens, locality, country,
       latitude, longitude, sources, licenses, release
     ) values ('laval','x','Café','cafe',array['cafe'],'Laval','CA',45.6,-73.7,'[]'::jsonb,array['CDLA-Permissive-2.0'],'2026-10-21.0')`
  );
  for (const role of ["anon", "authenticated"]) {
    await db.exec("reset role");
    await db.exec(`set role ${role}`);
    await assert.rejects(db.query("select * from private.search_catalog_places"), /permission denied/i);
    await assert.rejects(db.query("select * from private.search_catalog_lookup('laval','all',10)"), /permission denied/i);
  }
  await db.exec("reset role");
});
