export const TEST_SUPABASE_URL = "https://pwakjxjjxswdjsapsbxn.supabase.co";
export const PROD_SUPABASE_URL = "https://cbklwmjudobqwbkbxqgy.supabase.co";

export function serverDiagnosticAllowed(config) {
  const url = String(config && config.supabaseUrl || "").trim().replace(/\/+$/, "");
  if (!url || url === PROD_SUPABASE_URL) return false;
  return config.environment === "preview" && url === TEST_SUPABASE_URL;
}

const ERROR_CODES = new Set(["autorisation_refusee", "authentication_required", "fournisseur_absent", "role_trop_large"]);

export function publicDiagnosticBody(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.error === "string" && ERROR_CODES.has(value.error)) return { error: value.error };
  return {
    connected: value.connected === true,
    role: value.role === "klir_job_runner" ? "klir_job_runner" : "",
    jobsEnabled: value.jobsEnabled === false,
    billing: value.billing === "refuse" ? "refuse" : "",
    provider: value.provider === "absent" ? "absent" : "",
    executed: value.executed === false,
    scheduler: value.scheduler === "off" ? "off" : ""
  };
}

const EXPECTED = {
  connected: true,
  role: "klir_job_runner",
  jobsEnabled: false,
  billing: "refuse",
  provider: "absent",
  executed: false,
  scheduler: "off"
};

export function interpretServerDiagnostic(result) {
  const data = result && result.data && typeof result.data === "object" ? result.data : null;
  const code = data && typeof data.error === "string" ? data.error : "";
  const status = Number(result && result.status) || 0;
  if (status === 401 || code === "authentication_required") return { ok: false, outcome: "session_expiree" };
  if (code === "autorisation_refusee") return { ok: false, outcome: "compte_non_admin" };
  if (code === "fournisseur_absent") return { ok: false, outcome: "fournisseur_absent" };
  if (code === "role_trop_large") return { ok: false, outcome: "role_trop_large" };
  if (result && result.error && !data) return { ok: false, outcome: status >= 500 ? "panne" : "reponse_inattendue" };
  if (!data) return { ok: false, outcome: "reponse_inattendue" };
  const summary = {
    connected: data.connected === true,
    role: data.role === EXPECTED.role ? EXPECTED.role : "",
    jobsEnabled: data.jobsEnabled === false,
    billing: data.billing === EXPECTED.billing ? EXPECTED.billing : "",
    provider: data.provider === EXPECTED.provider ? EXPECTED.provider : "",
    executed: data.executed === false,
    scheduler: data.scheduler === EXPECTED.scheduler ? EXPECTED.scheduler : ""
  };
  const ready = summary.connected && summary.role && summary.jobsEnabled && summary.billing && summary.provider && summary.executed && summary.scheduler;
  if (!ready) return { ok: false, outcome: "reponse_inattendue" };
  return {
    ok: true,
    outcome: "connecte",
    summary: {
      connected: true,
      role: EXPECTED.role,
      jobsEnabled: false,
      billing: EXPECTED.billing,
      provider: EXPECTED.provider,
      executed: false,
      scheduler: EXPECTED.scheduler
    }
  };
}

export function createServerDiagnostic(deps) {
  let inFlight = false;
  return async function diagnose() {
    if (!serverDiagnosticAllowed(deps.config())) return { ok: false, outcome: "environnement_refuse" };
    const session = deps.session();
    if (!session || !session.user) return { ok: false, outcome: "session_requise" };
    if (inFlight) return { ok: false, outcome: "deja_en_cours" };
    inFlight = true;
    try {
      const admin = await deps.isAdmin();
      if (admin !== true) return { ok: false, outcome: "compte_non_admin" };
      let result;
      try {
        result = await deps.invoke();
      } catch {
        return { ok: false, outcome: "panne" };
      }
      return interpretServerDiagnostic(result);
    } finally {
      inFlight = false;
    }
  };
}

// Cycle admin du runner Test. Même garde que le diagnostic : prévisualisation
// du projet Test, session ouverte, compte admin. Le corps envoyé est toujours
// exactement { action: "cycle" } : la page ne choisit jamais de job.
export const CYCLE_BODY = Object.freeze({ action: "cycle" });

function cleanJob(row) {
  if (!row || typeof row !== "object") return null;
  return {
    id: typeof row.id === "string" ? row.id.slice(0, 36) : "",
    status: typeof row.status === "string" ? row.status.slice(0, 20) : "",
    ledger_status: typeof row.ledger_status === "string" ? row.ledger_status.slice(0, 20) : null
  };
}

export function publicCycleBody(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.error === "string") return { error: /^[a-z0-9_]{1,60}$/.test(value.error) ? value.error : "erreur" };
  const out = {};
  for (const key of ["connected", "operational", "contactsVerified", "executed"]) {
    if (typeof value[key] === "boolean") out[key] = value[key];
  }
  for (const key of ["role", "provider", "coverage", "scheduler", "mode"]) {
    if (typeof value[key] === "string") out[key] = value[key].slice(0, 40);
  }
  if (Number.isInteger(value.expired)) out.expired = value.expired;
  if (Array.isArray(value.jobs)) out.jobs = value.jobs.slice(0, 8).map(cleanJob).filter(Boolean);
  return out;
}

export function createServerCycle(deps) {
  let inFlight = false;
  return async function cycle() {
    if (!serverDiagnosticAllowed(deps.config())) return { ok: false, outcome: "environnement_refuse" };
    const session = deps.session();
    if (!session || !session.user) return { ok: false, outcome: "session_requise" };
    if (inFlight) return { ok: false, outcome: "deja_en_cours" };
    inFlight = true;
    try {
      const admin = await deps.isAdmin();
      if (admin !== true) return { ok: false, outcome: "compte_non_admin" };
      let result;
      try {
        result = await deps.invoke({ ...CYCLE_BODY });
      } catch {
        return { ok: false, outcome: "panne" };
      }
      const status = Number(result && result.status) || (result && result.error ? 0 : 200);
      const body = publicCycleBody(result && result.data);
      return { ok: !(result && result.error) && !!body && !body.error, outcome: "reponse", status, body };
    } finally {
      inFlight = false;
    }
  };
}
