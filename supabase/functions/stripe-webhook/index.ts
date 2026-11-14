// Déployer avec verify_jwt = false : Stripe n'envoie pas de JWT Supabase.
// L'authenticité vient de la signature Stripe, vérifiée dans la base.
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { handleStripeBillingWebhook, publicKeyFrom } from "./handler.mjs";

const env: Record<string, string> = {};
for (const name of ["SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEYS", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"]) {
  env[name] = Deno.env.get(name) ?? "";
}
const client = createClient(env.SUPABASE_URL, publicKeyFrom(env), {
  auth: { autoRefreshToken: false, persistSession: false }
});

Deno.serve((request: Request) => handleStripeBillingWebhook(request, {
  ingest: (raw: string, signature: string) => client.rpc("stripe_webhook_ingest", { p_raw: raw, p_signature: signature })
}));
