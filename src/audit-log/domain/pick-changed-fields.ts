/**
 * Narrows an object down to just the given keys — used to build the
 * `before`/`after` pair for an audit log entry from a full config/entity
 * object, so the log shows only what actually changed rather than every
 * field on the row.
 */
export function pickChangedFields<T extends object, K extends keyof T>(
  obj: T,
  keys: K[],
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    result[key] = obj[key];
  }
  return result;
}
