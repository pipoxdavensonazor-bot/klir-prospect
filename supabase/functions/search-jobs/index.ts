import { handleSearchJob } from "../_shared/search-job-http.mjs";

// Porte fermée. jobsEnabled est fixé à false dans ce fichier : un déploiement
// de la fonction ne lance pas la file et ne règle aucun crédit.
// Le runtime local qui enchaîne JWT, base, file et règlement est
// tools/search-job-runtime.mjs. Il ne démarre que si SEARCH_JOBS_LOCAL=1
// et il ne remplace pas cette entrée.
Deno.serve((request: Request) => handleSearchJob(request, {
  jobsEnabled: async () => false,
  verifyJwt: async () => null,
  rateLimit: async () => false,
  readJob: async () => null,
  cancelJob: async () => null,
  enqueue: async () => {
    throw new Error("search_jobs_not_wired");
  }
}));
