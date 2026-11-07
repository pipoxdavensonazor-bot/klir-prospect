import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import postgres from "npm:postgres@3.4.7";
import { bindRunnerPostgres, handleRunnerDiagnostic } from "../_shared/search-job-runner-edge.mjs";

const NAMES = [
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEYS",
  "SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_ANON_KEY",
  "KLIR_JOB_DB_HOST",
  "KLIR_JOB_DB_PORT",
  "KLIR_JOB_DB_NAME",
  "KLIR_JOB_DB_USER",
  "KLIR_JOB_DB_PASSWORD"
] as const;

function edgeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of NAMES) env[name] = Deno.env.get(name) ?? "";
  return env;
}

Deno.serve((request: Request) => handleRunnerDiagnostic(request, {
  env: edgeEnv(),
  createClient,
  connect: bindRunnerPostgres(postgres)
}));
