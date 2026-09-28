// Read only the active account's general usage query. Other features (such as
// image generation) share this prefix, and inactive accounts can stay cached.
export function findUsageQuery(client) {
  const queries = client.getQueryCache()?.getAll?.() ?? [];
  const active = queries.filter((query) => {
    const key = query.queryKey;
    if (!Array.isArray(key) || key[0] !== "rate-limit-status") return false;
    if (key.length !== 1 && key.length !== 3) return false;
    if (key.length === 3 && (
      key[1] === "image-generation" ||
      !key.slice(1).every((value) => typeof value === "string" && value.length > 0)
    )) return false;
    return query.isActive?.() === true;
  });
  // Multiple active account scopes are ambiguous; do not pick by freshness.
  const scoped = active.filter((query) => query.queryKey.length === 3);
  if (scoped.length > 0) return scoped.length === 1 ? scoped[0] : null;
  return active.length === 1 ? active[0] : null;
}

export function getResetCreditsQueryKey(usageQuery) {
  return ["rate-limit-reset-credits", ...usageQuery.queryKey.slice(1)];
}
