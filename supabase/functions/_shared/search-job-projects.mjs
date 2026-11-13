// Liste blanche explicite des projets Supabase autorisés à servir la file de recherche.
// Chaque projet a son URL exacte, son environnement KLIR_ENV attendu, son rôle de
// connexion runner (LOGIN, membre NOINHERIT de klir_job_runner) et ses hôtes pooler.
// Tout autre projet est refusé.

export const TEST_PROJECT_REF = "pwakjxjjxswdjsapsbxn";
export const PROD_PROJECT_REF = "cbklwmjudobqwbkbxqgy";

const POOLER_CA_CENTRAL_1 = Object.freeze([
  "aws-1-ca-central-1.pooler.supabase.com",
  "aws-0-ca-central-1.pooler.supabase.com"
]);

export const ALLOWED_PROJECTS = Object.freeze({
  [TEST_PROJECT_REF]: Object.freeze({
    ref: TEST_PROJECT_REF,
    target: "test",
    url: `https://${TEST_PROJECT_REF}.supabase.co`,
    env: "preview",
    connectRole: "klir_job_connect_test",
    poolerHosts: POOLER_CA_CENTRAL_1
  }),
  [PROD_PROJECT_REF]: Object.freeze({
    ref: PROD_PROJECT_REF,
    target: "production",
    url: `https://${PROD_PROJECT_REF}.supabase.co`,
    env: "production",
    connectRole: "klir_job_runner_prod",
    poolerHosts: POOLER_CA_CENTRAL_1
  })
});

function reject(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

// Projet servi, lu uniquement depuis SUPABASE_URL (posé par la plateforme).
export function resolveProject(env = {}) {
  const url = String(env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
  if (!url) throw reject("configuration_absente");
  const project = Object.values(ALLOWED_PROJECTS).find((candidate) => candidate.url === url);
  if (!project) throw reject("projet_refuse");
  return project;
}

// Identité runner complète : projet autorisé, environnement, hôte, utilisateur, port, base.
export function assertProjectRunnerIdentity(env = {}) {
  const project = resolveProject(env);
  if (String(env.KLIR_ENV || "") !== project.env) throw reject("environnement_refuse");
  const host = String(env.KLIR_JOB_DB_HOST || "").trim().toLowerCase();
  if (!project.poolerHosts.includes(host)) throw reject("hote_pooler_refuse");
  const user = String(env.KLIR_JOB_DB_USER || "").trim();
  if (user !== `${project.connectRole}.${project.ref}`) throw reject("role_connexion_refuse");
  if (String(env.KLIR_JOB_DB_PORT || "").trim() !== "6543") throw reject("port_non_transaction");
  if (String(env.KLIR_JOB_DB_NAME || "").trim() !== "postgres") throw reject("base_refusee");
  return project;
}
