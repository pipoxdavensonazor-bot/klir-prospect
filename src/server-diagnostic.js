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
