// Frontière serveur. query exécute le SQL transactionnel. Aucune clé,
// aucun appel fournisseur, aucun allumage du drapeau.
export function createSearchJobLedger(query) {
  if (typeof query !== "function") {
    const error = new Error("query_required");
    error.code = "query_required";
    throw error;
  }
  return {
    async record(jobId, outcome, count) {
      const result = await query(
        "select private.record_search_collection($1::uuid, $2, $3) as row",
        [jobId, outcome, count]
      );
      return result.rows[0].row;
    },
    async reconcile(jobId) {
      const result = await query(
        "select private.reconcile_search_job($1::uuid) as row",
        [jobId]
      );
      return result.rows[0].row;
    }
  };
}
