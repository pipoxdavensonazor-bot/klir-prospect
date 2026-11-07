// Port de stockage. query(sql, params) est injecté : PGlite en test, client
// serveur plus tard. Le navigateur n'est pas un client de ce module.
export function createSearchJobStore(query) {
  if (typeof query !== "function") {
    const error = new Error("query_required");
    error.code = "query_required";
    throw error;
  }
  return {
    async enqueue(idempotencyKey, payload) {
      const result = await query(
        "select public.enqueue_search_job($1, $2::jsonb) as row",
        [idempotencyKey, JSON.stringify(payload)]
      );
      return result.rows[0].row;
    },
    async readOwn() {
      const result = await query("select id, user_id, status, attempt, progress from public.search_jobs");
      return result.rows;
    },
    async cancel(jobId) {
      const result = await query("select public.cancel_search_job($1::uuid) as row", [jobId]);
      return result.rows[0].row;
    }
  };
}

// Le consommateur de file n'écrit pas un succès de crédit. Il observe l'adaptateur
// et rend un constat. La persistance du règlement est le lot C.
export async function consumeSearchJob({ job, adapter }) {
  if (!job || !job.userId) {
    const error = new Error("authentication_required");
    error.code = "authentication_required";
    throw error;
  }
  if (!adapter || typeof adapter.run !== "function") {
    const error = new Error("adapter_required");
    error.code = "adapter_required";
    throw error;
  }
  if (job.status === "cancelled" || job.cancelRequested) {
    return { status: "cancelled", attempt: job.attempt || 0, progress: job.progress || 0, observed: null };
  }
  let attempt = job.attempt || 0;
  let lastError = "";
  const maxAttempts = 3;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const observed = await adapter.run(job.payload, {
        attempt,
        isCancelled: () => job.cancelRequested === true
      });
      if (job.cancelRequested) return { status: "cancelled", attempt, progress: Math.min(100, attempt * 30), observed: null };
      const count = observed && Number.isFinite(observed.count) ? observed.count : 0;
      const outcome = count > 0 ? "complete" : "empty";
      return { status: "observed", outcome, attempt, progress: 100, observed, count };
    } catch (error) {
      if (job.cancelRequested) return { status: "cancelled", attempt, progress: Math.min(100, attempt * 30), observed: null };
      lastError = error && error.code ? error.code : "provider_failed";
      if (error && error.retryable === false) break;
    }
  }
  return { status: "failed", attempt, progress: Math.min(100, attempt * 30), lastError, observed: null };
}
