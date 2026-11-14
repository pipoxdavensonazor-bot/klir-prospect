import { createClient } from "npm:@supabase/supabase-js@2.117.2";
import { handleEmailFinder, runBatch } from "../_shared/email-finder.mjs";

// Origines du site autorisées (production et prévisualisations connues).
const ORIGINS = new Set([
  "https://klirprospect.klirline.ca",
  "https://cursor-test-server-diagnostic-2f07.klirprospect.klirline.ca",
  "https://cursor-search-pilot-ui-2f07.klirprospect.klirline.ca",
  "https://cursor-search-targeted-claim-2f07.klirprospect.klirline.ca"
]);

function cors(origin: string): Record<string, string> {
  if (!ORIGINS.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    vary: "origin"
  };
}

function reply(status: number, body: unknown, origin: string) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors(origin) }
  });
}

Deno.serve(async (request: Request) => {
  const origin = request.headers.get("origin") ?? "";
  if (origin && !ORIGINS.has(origin)) return reply(403, { error: "origin_not_allowed" }, "");
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origin) });
  if (request.method !== "POST") return reply(405, { error: "method_not_allowed" }, origin);

  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return reply(401, { error: "session_requise" }, origin);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRole) return reply(503, { error: "service_indisponible" }, origin);
  const admin = createClient(url, serviceRole, { auth: { autoRefreshToken: false, persistSession: false } });
  const { data: { user }, error } = await admin.auth.getUser(token);
  if (error || !user) return reply(401, { error: "session_requise" }, origin);

  let body: unknown;
  try { body = await request.json(); } catch { return reply(400, { error: "selection_invalide" }, origin); }

  const rpc = async (name: string, args: Record<string, unknown>) => {
    const { data, error: rpcError } = await admin.rpc(name, args);
    if (rpcError) throw new Error(rpcError.message || "rpc");
    return data;
  };
  const out = await handleEmailFinder({
    userId: user.id,
    body,
    begin: (u: string, receipt: string, refs: unknown) => rpc("email_finder_begin", { p_user: u, p_receipt: receipt, p_refs: refs }),
    finish: (u: string, receipt: string, results: unknown) => rpc("email_finder_finish", { p_user: u, p_receipt: receipt, p_results: results }),
    randomBytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)),
    extract: (targets: { id: string; website: string }[]) => runBatch(targets)
  });
  return reply(out.status, out.body, origin);
});
