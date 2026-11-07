function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function bearer(request) {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

export async function handleSearchJob(request, deps) {
  if (!deps || typeof deps.verifyJwt !== "function" || typeof deps.jobsEnabled !== "function") {
    return json(503, { error: "jobs_not_configured" });
  }
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "POST" && request.method !== "GET") return json(405, { error: "method_not_allowed" });

  const token = bearer(request);
  if (!token) return json(401, { error: "authentication_required" });

  let user = null;
  try {
    user = await deps.verifyJwt(token);
  } catch {
    return json(401, { error: "authentication_required" });
  }
  if (!user || !user.id) return json(401, { error: "authentication_required" });

  const enabled = await deps.jobsEnabled();
  if (enabled !== true) return json(403, { error: "jobs_disabled" });

  if (request.method === "GET") {
    const id = new URL(request.url).searchParams.get("id") || "";
    const job = await deps.readJob(user.id, id);
    if (!job) return json(404, { error: "job_not_found" });
    return json(200, job);
  }

  let body = null;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid_request" });
  }
  if (!body || typeof body !== "object") return json(400, { error: "invalid_request" });

  if (body.action === "cancel") {
    const job = await deps.cancelJob(user.id, body.jobId);
    if (!job) return json(404, { error: "job_not_found" });
    return json(200, job);
  }

  if (body.action !== "enqueue") return json(400, { error: "invalid_request" });
  if (!body.payload || body.payload.place_status !== "supported") return json(422, { error: "place_rejected" });
  if (await deps.rateLimit(user.id)) return json(429, { error: "rate_limited" });
  const queued = await deps.enqueue({
    userId: user.id,
    idempotencyKey: body.idempotencyKey,
    payload: body.payload
  });
  return json(200, queued);
}
