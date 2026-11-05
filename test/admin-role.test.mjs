import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const root = new URL("../supabase/migrations/", import.meta.url);
const createSql = await readFile(new URL("20261006004359_create_profiles_and_rls.sql", root), "utf8");
const adminSql = await readFile(new URL("20261105014500_admin_role.sql", root), "utf8");
const appSource = await readFile(new URL("../src/app.js", import.meta.url), "utf8");
const authSource = await readFile(new URL("../src/auth.js", import.meta.url), "utf8");

const contact = "11111111-1111-4111-8111-111111111111";
const other = "22222222-2222-4222-8222-222222222222";

function stub(withEmail) {
  return `
create schema if not exists auth;
create table if not exists auth.users (
  id uuid primary key,
  ${withEmail ? "email text," : ""}
  raw_user_meta_data jsonb
);
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
end
$$;
grant usage on schema public to anon, authenticated;
grant usage on schema auth to anon, authenticated;
`;
}

test("la migration ne donne aucun droit d'écriture et ne lit pas les métadonnées", () => {
  assert.match(adminSql, /security definer/i);
  assert.match(adminSql, /set search_path = ''/);
  assert.match(adminSql, /\nstable\n/);
  assert.match(adminSql, /contact@klirline\.ca/);
  assert.match(adminSql, /grant execute on function public\.is_admin\(\) to authenticated/);
  assert.match(adminSql, /revoke all on table private\.admins from public, anon, authenticated/);
  assert.doesNotMatch(adminSql, /grant\s+(insert|update|delete|all|select)/i);
  assert.doesNotMatch(adminSql, /add column\s+(role|is_admin)|profiles\.role|raw_user_meta_data|app_metadata/i);
  assert.match(authSource, /rpc\(\s*"is_admin"\s*\)/);
  assert.match(authSource, /admin: currentAdmin === true/);
  assert.doesNotMatch(authSource, /app_metadata|raw_user_meta_data/);
  assert.match(appSource, /page==="admin"&&!isAdminSession\(\)/);
  assert.doesNotMatch(appSource, /\["team","api","admin"\]/);
});

test("seul le compte promu est admin, et le client ne peut pas s'inscrire", async () => {
  const db = new PGlite();
  try {
    await db.exec(stub(true));
    await db.exec(`
      insert into auth.users (id, email, raw_user_meta_data) values
      ('${contact}', '  Contact@Klirline.ca ', '{}'),
      ('${other}', 'contact@klirline.ca.example', '{}')
    `);
    await db.exec(createSql);
    await db.exec(adminSql);
    await db.exec(adminSql);

    const rows = await db.query("select user_id from private.admins order by user_id");
    assert.deepEqual(rows.rows.map((row) => row.user_id), [contact]);

    const definition = await db.query(`
      select prosecdef, provolatile, proconfig
      from pg_proc
      join pg_namespace on pg_namespace.oid = pg_proc.pronamespace
      where nspname = 'public' and proname = 'is_admin'
    `);
    assert.equal(definition.rows[0].prosecdef, true);
    assert.equal(definition.rows[0].provolatile, "s");
    assert.match((definition.rows[0].proconfig || []).join(","), /search_path=/);

    const privileges = await db.query(`
      select has_function_privilege('authenticated', 'public.is_admin()', 'execute') as authenticated,
             has_function_privilege('anon', 'public.is_admin()', 'execute') as anon
    `);
    assert.equal(privileges.rows[0].authenticated, true);
    assert.equal(privileges.rows[0].anon, false);

    const policies = await db.query("select polname from pg_policy where polrelid = 'private.admins'::regclass");
    assert.equal(policies.rows.length, 0);
    const roleColumn = await db.query(`
      select column_name from information_schema.columns
      where table_schema = 'public' and table_name = 'profiles' and column_name in ('role', 'is_admin')
    `);
    assert.equal(roleColumn.rows.length, 0);

    await db.exec(`select set_config('request.jwt.claim.sub', '${other}', false)`);
    await db.exec("set role authenticated");
    for (const statement of [
      `insert into private.admins (user_id) values ('${other}')`,
      "update private.admins set created_at = now()",
      "delete from private.admins",
      "select * from private.admins"
    ]) {
      await assert.rejects(db.exec(statement), /permission denied/i);
    }
    const denied = await db.query("select public.is_admin() as value");
    assert.equal(denied.rows[0].value, false);
    await assert.rejects(db.query("select public.is_admin($1)", [contact]), /is_admin/);

    await db.exec("reset role");
    await db.exec(`select set_config('request.jwt.claim.sub', '${contact}', false)`);
    await db.exec("set role authenticated");
    const allowed = await db.query("select public.is_admin() as value");
    assert.equal(allowed.rows[0].value, true);

    await db.exec("reset role");
    await db.exec(`delete from auth.users where id = '${contact}'`);
    const gone = await db.query("select count(*)::int as n from private.admins");
    assert.equal(gone.rows[0].n, 0);
  } finally {
    await db.close();
  }
});

test("la migration reste valide quand auth.users n'a pas de colonne email", async () => {
  const db = new PGlite();
  try {
    await db.exec(stub(false));
    await db.exec(`insert into auth.users (id, raw_user_meta_data) values ('${other}', '{}')`);
    await db.exec(createSql);
    await db.exec(adminSql);
    const rows = await db.query("select count(*)::int as n from private.admins");
    assert.equal(rows.rows[0].n, 0);
    await db.exec(`select set_config('request.jwt.claim.sub', '${other}', false)`);
    await db.exec("set role authenticated");
    const flag = await db.query("select public.is_admin() as value");
    assert.equal(flag.rows[0].value, false);
  } finally {
    await db.close();
  }
});

function routerSandbox(hash, { admin = false, demo = false, user = { id: "fixture", email: "fixture@example.invalid" } } = {}) {
  const sandbox = {
    location: { hash },
    authState: { user, admin, passwordRecovery: false },
    rendered: null,
    App: { innerHTML: "" },
    document: {
      getElementById() { return null; },
      querySelectorAll() { return []; }
    },
    bind() {},
    KS: { S: { user, demo, notifications: [], org: { name: "Espace" }, credits: { balance: 0 } } }
  };
  sandbox.window = {
    KlirStore: sandbox.KS,
    KlirAuth: { state: () => ({ pending: null, callbackError: null }) }
  };
  sandbox.shell = (body, active) => {
    sandbox.rendered = active;
    sandbox.body = body;
    return body;
  };
  sandbox.vAdmin = () => "vue-admin";
  sandbox.vSettings = () => "vue-reglages";
  sandbox.vLanding = () => { sandbox.rendered = "landing"; };
  sandbox.vAuth = () => { sandbox.rendered = "login"; };
  sandbox.vRecoverySessionRequired = () => { sandbox.rendered = "session-required"; };
  sandbox.vAuthError = () => { sandbox.rendered = "error"; };
  sandbox.vResetPassword = () => { sandbox.rendered = "reset"; };
  sandbox.vAuthCallback = () => { sandbox.rendered = "confirm"; };
  vm.createContext(sandbox);
  vm.runInContext(appSource.slice(appSource.indexOf("function nav("), appSource.indexOf('window.addEventListener("hashchange"')), sandbox);
  vm.runInContext(appSource.slice(appSource.indexOf("function isAdminSession()"), appSource.indexOf("function shell(")), sandbox);
  vm.runInContext(appSource.slice(appSource.indexOf("function render(){"), appSource.indexOf("function vProfile(")), sandbox);
  sandbox.render();
  return sandbox;
}

test("la vue admin reste fermée sans le rôle et ouverte avec lui", () => {
  const closed = routerSandbox("#/admin", { admin: false });
  assert.equal(closed.location.hash, "#/settings");
  assert.equal(closed.rendered, "settings");
  assert.equal(closed.body, "vue-reglages");

  const demo = routerSandbox("#/admin", { admin: true, demo: true });
  assert.equal(demo.location.hash, "#/settings");
  assert.equal(demo.rendered, "settings");

  const open = routerSandbox("#/admin", { admin: true, demo: false });
  assert.equal(open.location.hash, "#/admin");
  assert.equal(open.rendered, "admin");
  assert.equal(open.body, "vue-admin");

  const team = routerSandbox("#/team", { admin: true, demo: false });
  assert.equal(team.location.hash, "#/settings");
  assert.equal(team.rendered, "settings");

  const api = routerSandbox("#/api", { admin: true, demo: false });
  assert.equal(api.location.hash, "#/settings");
});

test("le menu n'affiche Administration que pour une session admin", () => {
  function menu(admin, demo) {
    const sandbox = {
      authState: { user: { id: "fixture" }, admin },
      syncFailureBanner: () => "",
      hx: (value) => String(value ?? ""),
      KS: {
        S: {
          demo,
          notifications: [],
          org: { name: "Espace" },
          user: { email: "fixture@example.invalid" },
          credits: { balance: 3 }
        }
      }
    };
    vm.createContext(sandbox);
    vm.runInContext(appSource.slice(appSource.indexOf("function isAdminSession()"), appSource.indexOf("function render(){")), sandbox);
    return sandbox.shell("corps", admin && !demo ? "admin" : "settings");
  }
  assert.match(menu(true, false), /href="#\/admin"/);
  assert.match(menu(true, false), /Administration/);
  assert.doesNotMatch(menu(false, false), /href="#\/admin"/);
  assert.doesNotMatch(menu(true, true), /href="#\/admin"/);
});
