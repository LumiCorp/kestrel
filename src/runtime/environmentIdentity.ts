export const SESSION_ENVIRONMENT_IDENTITY_CONFLICT_CODE =
  "SESSION_ENVIRONMENT_IDENTITY_CONFLICT";
export const SESSION_ENVIRONMENT_IDENTITY_UNSUPPORTED_CODE =
  "SESSION_ENVIRONMENT_IDENTITY_UNSUPPORTED";

export type SessionEnvironmentIdentityFailureCode =
  | typeof SESSION_ENVIRONMENT_IDENTITY_CONFLICT_CODE
  | typeof SESSION_ENVIRONMENT_IDENTITY_UNSUPPORTED_CODE;

export function isSessionEnvironmentIdentityFailureCode(
  value: unknown,
): value is SessionEnvironmentIdentityFailureCode {
  return value === SESSION_ENVIRONMENT_IDENTITY_CONFLICT_CODE
    || value === SESSION_ENVIRONMENT_IDENTITY_UNSUPPORTED_CODE;
}

export function snapshotEnvironmentIdentityDetails(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ;
  }
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (_key, nested: unknown) => {
      if (typeof nested === "bigint") {
        return nested.toString();
      }
      if (typeof nested === "object" && nested !== null) {
        if (seen.has(nested)) {
          return ;
        }
        seen.add(nested);
      }
      return nested;
    });
    if (serialized === undefined) {
      return ;
    }
    const snapshot = JSON.parse(serialized) as unknown;
    return typeof snapshot === "object"
      && snapshot !== null
      && Array.isArray(snapshot) === false
        ? snapshot as Record<string, unknown>
        : undefined;
  } catch {
    return ;
  }
}
