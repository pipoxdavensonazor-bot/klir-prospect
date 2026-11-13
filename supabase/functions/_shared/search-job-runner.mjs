export const SEARCH_JOB_LIMITS = Object.freeze({
  maxAttempts: 3,
  progressMax: 100,
  breakerThreshold: 3,
  breakerCooldownMs: 30000
});

function coded(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function boundedProgress(value, max) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.min(max, Math.floor(number));
}

export function createSearchJobRunner(adapter, options = {}) {
  if (!adapter || typeof adapter.run !== "function") throw coded("adapter_required");
  const limits = { ...SEARCH_JOB_LIMITS, ...(options.limits || {}) };
  const now = options.now || (() => Date.now());
  const jobs = new Map();
  let consecutiveFailures = 0;
  let circuitOpenedAt = null;

  function circuitState() {
    if (circuitOpenedAt == null) return "closed";
    if (now() - circuitOpenedAt >= limits.breakerCooldownMs) return "half_open";
    return "open";
  }

  function rememberSuccess() {
    consecutiveFailures = 0;
    circuitOpenedAt = null;
  }

  function rememberFailure() {
    consecutiveFailures += 1;
    if (consecutiveFailures >= limits.breakerThreshold) circuitOpenedAt = now();
  }

  function enqueue(input) {
    const userId = input && input.userId;
    const idempotencyKey = input && input.idempotencyKey;
    const payload = input && input.payload;
    if (!userId) throw coded("authentication_required");
    if (!idempotencyKey || String(idempotencyKey).length < 8) throw coded("idempotency_key_invalide");
    if (!payload || payload.place_status !== "supported") throw coded("place_rejected");
    const id = userId + ":" + idempotencyKey;
    const existing = jobs.get(id);
    if (existing) return { job: existing, created: false };
    if (circuitState() === "open") throw coded("circuit_open");
    const job = {
      id,
      userId,
      idempotencyKey,
      status: "queued",
      attempt: 0,
      progress: 0,
      payload,
      cancelRequested: false,
      lastError: ""
    };
    jobs.set(id, job);
    return { job, created: true };
  }

  function findOwn(userId, jobId) {
    const job = jobs.get(jobId);
    if (!job || job.userId !== userId) return null;
    return job;
  }

  function cancel(userId, jobId) {
    const job = findOwn(userId, jobId);
    if (!job) return null;
    job.cancelRequested = true;
    if (job.status === "queued" || job.status === "running") job.status = "cancelled";
    return job;
  }

  async function run(job) {
    if (!job || job.status === "cancelled" || job.status === "succeeded") return job;
    if (circuitState() === "open") {
      job.status = "failed";
      job.lastError = "circuit_open";
      return job;
    }
    while (job.attempt < limits.maxAttempts && !job.cancelRequested && job.status !== "succeeded") {
      job.attempt += 1;
      job.status = "running";
      job.progress = boundedProgress((job.attempt / limits.maxAttempts) * limits.progressMax, limits.progressMax);
      try {
        const result = await adapter.run(job.payload, {
          attempt: job.attempt,
          isCancelled: () => job.cancelRequested === true
        });
        if (job.cancelRequested) {
          job.status = "cancelled";
          return job;
        }
        job.status = "succeeded";
        job.progress = limits.progressMax;
        job.result = result;
        rememberSuccess();
        return job;
      } catch (error) {
        if (job.cancelRequested) {
          job.status = "cancelled";
          return job;
        }
        job.lastError = error && error.code ? error.code : "provider_failed";
        rememberFailure();
        if (error && error.retryable === false) break;
        if (circuitState() === "open") break;
      }
    }
    if (job.cancelRequested) job.status = "cancelled";
    else job.status = "failed";
    job.progress = boundedProgress(job.progress, limits.progressMax);
    return job;
  }

  return { enqueue, run, cancel, findOwn, circuitState, limits };
}
