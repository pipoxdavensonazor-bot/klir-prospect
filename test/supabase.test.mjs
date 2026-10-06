import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const migration = await readFile(
  new URL("../supabase/migrations/20261006004359_create_profiles_and_rls.sql", import.meta.url),
  "utf8"
);
const authClient = await readFile(new URL("../src/auth.js", import.meta.url), "utf8");
const deleteAccount = await readFile(
  new URL("../supabase/functions/delete-account/index.ts", import.meta.url),
  "utf8"
);

test("active RLS et limite chaque table au propriétaire", () => {
  assert.match(migration, /alter table public\.profiles enable row level security/i);
  assert.match(migration, /alter table public\.workspace_states enable row level security/i);
  assert.match(migration, /using \(\(select auth\.uid\(\)\) = id\)/i);
  assert.match(migration, /with check \(\(select auth\.uid\(\)\) = user_id\)/i);
  assert.match(migration, /references auth\.users\(id\) on delete cascade/i);
});

test("ne prend aucune décision d’autorisation depuis user_metadata", () => {
  assert.doesNotMatch(migration, /raw_user_meta_data[\s\S]*create policy/i);
  assert.doesNotMatch(authClient, /service[_-]?role/i);
});

test("conserve les sessions dans l’onglet et utilise PKCE", () => {
  assert.match(authClient, /sessionStorage/);
  assert.doesNotMatch(authClient, /localStorage/);
  assert.match(authClient, /flowType:\s*"pkce"/);
  assert.match(authClient, /storageKey:\s*"klir-auth"/);
  assert.match(authClient, /signOut\(\{\s*scope:\s*"global"\s*\}\)/);
  assert.match(authClient, /verifyOtp\(\{ token_hash: pending\.tokenHash, type: pending\.type \}\)/);
  assert.match(authClient, /signInWithPassword\(\{ email: currentUser\.email, password \}\)/);
  assert.doesNotMatch(authClient, /demo_migrated_at:\s*new Date/);
});

test("la suppression exige identité, confirmation et révocation globale", () => {
  assert.match(deleteAccount, /getUser\(token\)/);
  assert.match(deleteAccount, /confirmation !== "SUPPRIMER"/);
  assert.match(deleteAccount, /admin\.signOut\(token, "global"\)/);
  assert.match(deleteAccount, /admin\.deleteUser\(user\.id\)/);
  assert.doesNotMatch(deleteAccount, /SUPABASE_SERVICE_ROLE_KEY["']?\s*[:=]\s*["'][^"']+/);
});
