// Reprise des recherches de la file serveur après un rechargement.
// Lecture seule : search_jobs et search_job_places, filtrées par la RLS propriétaire.
// Aucun appel de réservation, de règlement ni de débit : le serveur a déjà réglé le job.

export const SERVER_JOB_TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
export const SERVER_JOB_ACTIVE = new Set(["queued", "running"]);
export const SERVER_JOB_RECENT_LIMIT = 20;
export const SERVER_JOB_PLACES_LIMIT = 40;
export const SERVER_JOB_POLL_MS = 2000;
export const SERVER_JOB_POLL_LIMIT = 60;

const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function cleanPayload(payload) {
  const source = payload && typeof payload === "object" ? payload : {};
  const quantity = Number(source.quantity);
  return {
    cityKey: String(source.cityKey || ""),
    industry: String(source.industry || "all"),
    quantity: Number.isInteger(quantity) ? quantity : 10
  };
}

function cleanJob(row) {
  if (!row || typeof row !== "object" || !JOB_ID.test(String(row.id || ""))) return null;
  return {
    id: String(row.id),
    status: String(row.status || ""),
    ledger_status: row.ledger_status == null ? null : String(row.ledger_status),
    result_count: Number.isInteger(row.result_count) ? row.result_count : null,
    idempotency_key: String(row.idempotency_key || ""),
    created_at: row.created_at || null,
    payload: cleanPayload(row.payload)
  };
}

// Fiches d'un job, dans l'ordre affiché à la fin d'une recherche.
export async function readServerJobPlaces(supabase, jobId) {
  const listed = await supabase
    .from("search_job_places")
    .select("id, name, basic_category, release, contacts_verified, created_at, website, phone, contact_fields, email, email_source, email_found_at, email_checked_at")
    .eq("job_id", jobId)
    .order("created_at", { ascending: true })
    .order("name", { ascending: true })
    .limit(SERVER_JOB_PLACES_LIMIT);
  if (listed.error) return { ok: false, places: [] };
  return { ok: true, places: Array.isArray(listed.data) ? listed.data : [] };
}

// Jobs récents du compte à rattacher à l'historique :
// - succeeded absent de l'historique et non supprimé par l'utilisateur, avec ses fiches ;
// - queued/running, à suivre.
export async function listRecoverableServerJobs(supabase, options = {}) {
  const known = new Set((options.knownSearchIds || []).map(String));
  const removed = new Set((options.removedSearchIds || []).map(String));
  const listed = await supabase
    .from("search_jobs")
    .select("id, status, ledger_status, result_count, idempotency_key, created_at, payload")
    .order("created_at", { ascending: false })
    .limit(SERVER_JOB_RECENT_LIMIT);
  if (listed.error) return { ok: false, completed: [], active: [], terminal: [] };
  const rows = (Array.isArray(listed.data) ? listed.data : []).map(cleanJob).filter(Boolean);
  const completed = [];
  const active = [];
  for (const job of rows) {
    const searchId = "job_" + job.id;
    if (known.has(searchId) || removed.has(searchId)) continue;
    if (SERVER_JOB_ACTIVE.has(job.status)) {
      active.push(job);
      continue;
    }
    if (job.status !== "succeeded") continue;
    const read = await readServerJobPlaces(supabase, job.id);
    if (!read.ok || !read.places.length) continue;
    completed.push({ job, places: read.places });
  }
  return { ok: true, completed, active, terminal: rows.filter((job) => SERVER_JOB_TERMINAL.has(job.status)) };
}

// Attend la fin d'un job déjà en file (aucune nouvelle mise en file).
export async function awaitServerJob(readStatus, job, options = {}) {
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const limit = Number.isInteger(options.limit) ? options.limit : SERVER_JOB_POLL_LIMIT;
  let current = job;
  for (let index = 0; index < limit && !SERVER_JOB_TERMINAL.has(current.status); index += 1) {
    await sleep(SERVER_JOB_POLL_MS);
    const polled = await readStatus(current.id);
    if (polled && typeof polled.status === "string") current = { ...current, ...polled };
  }
  return current;
}
