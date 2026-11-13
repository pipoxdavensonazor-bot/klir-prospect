import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { handleSearchJobRequest } from "../_shared/search-job-edge.mjs";

const NAMES = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEYS",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY"
] as const;

function edgeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of NAMES) env[name] = Deno.env.get(name) ?? "";
  return env;
}

Deno.serve((request: Request) => handleSearchJobRequest(request, {
  env: edgeEnv(),
  createClient
}));
