import { createClient } from "npm:@supabase/supabase-js@2.117.2";

const jsonHeaders = { "content-type": "application/json; charset=utf-8" };

function response(status: number, body: Record<string, unknown>, origin = "") {
  const headers: Record<string, string> = { ...jsonHeaders };
  if (origin) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "origin";
  }
  return new Response(JSON.stringify(body), { status, headers });
}

Deno.serve(async (request) => {
  const allowedOrigin = Deno.env.get("ALLOWED_ORIGIN") ?? "";
  const origin = request.headers.get("origin") ?? "";
  if (origin && origin !== allowedOrigin) return response(403, { error: "origin_not_allowed" });

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": allowedOrigin,
        "access-control-allow-headers": "authorization, apikey, content-type",
        "access-control-allow-methods": "POST",
        vary: "origin"
      }
    });
  }
  if (request.method !== "POST") return response(405, { error: "method_not_allowed" }, origin);

  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  if (!token) return response(401, { error: "authentication_required" }, origin);

  let body: { confirmation?: string };
  try {
    body = await request.json();
  } catch {
    return response(400, { error: "invalid_request" }, origin);
  }
  if (body.confirmation !== "SUPPRIMER") {
    return response(400, { error: "confirmation_required" }, origin);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRole) return response(503, { error: "service_unavailable" }, origin);

  const admin = createClient(url, serviceRole, {
    auth: { autoRefreshToken: false, persistSession: false }
  });
  const { data: { user }, error: userError } = await admin.auth.getUser(token);
  if (userError || !user) return response(401, { error: "authentication_required" }, origin);

  let payload: { iat?: number };
  try {
    const encoded = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    payload = JSON.parse(atob(encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=")));
  } catch {
    return response(401, { error: "authentication_required" }, origin);
  }
  const issuedAt = Number(payload.iat || 0) * 1000;
  if (!issuedAt || Date.now() - issuedAt > 10 * 60 * 1000) {
    return response(403, { error: "recent_authentication_required" }, origin);
  }

  const { error: signOutError } = await admin.auth.admin.signOut(token, "global");
  if (signOutError) return response(502, { error: "session_revocation_failed" }, origin);

  const { error: deleteError } = await admin.auth.admin.deleteUser(user.id);
  if (deleteError) return response(502, { error: "account_deletion_failed" }, origin);

  return response(200, { deleted: true }, origin);
});
