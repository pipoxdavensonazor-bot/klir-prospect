import { createSearchJobLedger } from "./search-job-ledger.mjs";

// Fournisseur local. Aucun réseau. simulateFailures et simulateCount ne sont
// honorés que par ce module, appelé par le runtime local.
export function createLocalSimulatedProvider() {
  return {
    async run(payload, context) {
      if (!payload || payload.place_status !== "supported") {
        const error = new Error("place_rejected");
        error.code = "place_rejected";
        error.retryable = false;
        throw error;
      }
      const failures = Number(payload.simulateFailures || 0);
      const attempt = Number(context && context.attempt) || 0;
      if (Number.isFinite(failures) && failures > 0 && attempt <= failures) {
        const error = new Error("provider_failed");
        error.code = "provider_failed";
        error.retryable = true;
        throw error;
      }
      const count = payload.simulateCount == null ? 1 : Number(payload.simulateCount);
      if (!Number.isInteger(count) || count < 0) {
        const error = new Error("provider_failed");
        error.code = "provider_failed";
        error.retryable = false;
        throw error;
      }
      return { count, source: "simulated-local" };
    }
  };
}

function asJobs(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  }
  return [];
}

async function finishJob(query, ledger, adapter, job) {
  if (job.collection_outcome) {
    const reconciled = await ledger.reconcile(job.id);
    return { id: job.id, status: reconciled.status, ledger_status: reconciled.ledger_status, attempt: job.attempt };
  }
  try {
    const observed = await adapter.run(job.payload, { attempt: job.attempt, isCancelled: () => false });
    const count = Number(observed && observed.count) || 0;
    const outcome = count > 0 ? "complete" : "empty";
    const records = Array.isArray(observed && observed.records) ? observed.records.slice(0, 40) : [];
    if (outcome === "complete" && records.length) {
      await query("select private.record_search_places($1::uuid, $2::jsonb) as row", [
        job.id,
        JSON.stringify(records.map((row) => ({
          name: row && row.name ? String(row.name).slice(0, 160) : "",
          basicCategory: row && row.basicCategory ? String(row.basicCategory).slice(0, 80) : "",
          release: row && row.release ? String(row.release).slice(0, 40) : ""
        })))
      ]);
    }
    await ledger.record(job.id, outcome, outcome === "complete" ? count : 0);
    const reconciled = await ledger.reconcile(job.id);
    return { id: job.id, status: reconciled.status, ledger_status: reconciled.ledger_status, attempt: job.attempt };
  } catch (error) {
    const message = String(error && error.message || "");
    if (/job_clos|deja_regle/.test(message)) return { id: job.id, status: "closed", attempt: job.attempt };
    if (error && error.retryable === true && Number(job.attempt) < 3) {
      await query("select private.release_search_job_claim($1::uuid) as row", [job.id]);
      return { id: job.id, status: "retry", attempt: job.attempt };
    }
    try {
      await ledger.record(job.id, "failed", 0);
      const reconciled = await ledger.reconcile(job.id);
      return { id: job.id, status: reconciled.status, ledger_status: reconciled.ledger_status, attempt: job.attempt };
    } catch (second) {
      if (/job_clos|deja_regle/.test(String(second && second.message || ""))) {
        return { id: job.id, status: "closed", attempt: job.attempt };
      }
      throw second;
    }
  }
}

export async function runWorkerCycle(query, adapter, options = {}) {
  if (typeof query !== "function") {
    const error = new Error("query_required");
    error.code = "query_required";
    throw error;
  }
  if (!adapter || typeof adapter.run !== "function") {
    const error = new Error("adapter_required");
    error.code = "adapter_required";
    throw error;
  }
  const ledger = createSearchJobLedger(query);
  const expired = await query("select private.expire_due_search_jobs() as row");
  const targetJobId = options && options.targetJobId ? String(options.targetJobId) : "";
  const claimed = targetJobId
    ? await query("select private.claim_authorized_test_job($1::uuid) as row", [targetJobId])
    : await query("select private.claim_search_jobs(1) as row");
  const jobs = asJobs(claimed.rows[0] && claimed.rows[0].row);
  const results = [];
  for (const job of jobs) results.push(await finishJob(query, ledger, adapter, job));
  const expiredRow = expired.rows[0] ? expired.rows[0].row : { expired: 0 };
  return {
    expired: expiredRow && expiredRow.expired ? expiredRow.expired : 0,
    results
  };
}
