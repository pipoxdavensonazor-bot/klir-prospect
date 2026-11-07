// Adaptateur de session. getUser a la forme de supabase.auth.getUser(jwt) :
// { data: { user }, error }. Ce module ne lit aucune clé et n'ouvre aucun client.
export function createGetUserVerifier(getUser) {
  if (typeof getUser !== "function") {
    const error = new Error("getUser_required");
    error.code = "getUser_required";
    throw error;
  }
  return async function verifyJwt(token) {
    if (!token || typeof token !== "string") return null;
    let result;
    try {
      result = await getUser(token);
    } catch {
      return null;
    }
    if (!result || result.error || !result.data || !result.data.user || !result.data.user.id) return null;
    return { id: String(result.data.user.id) };
  };
}
