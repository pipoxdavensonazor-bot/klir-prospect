import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { handleSearchGeocode } from "./search-geocode.mjs";

const NAMES = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEYS",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
  "OPENCAGE_API_KEY"
] as const;

function edgeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of NAMES) env[name] = Deno.env.get(name) ?? "";
  return env;
}

Deno.serve((request: Request) => handleSearchGeocode(request, {
  env: edgeEnv(),
  createClient
}));
