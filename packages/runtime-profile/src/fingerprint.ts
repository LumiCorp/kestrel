import { fingerprintCanonicalValue } from "./stable.js";

/**
 * Revision of the canonical Kestrel execution-boundary policy. Keeping the
 * revision in this dependency-clean package makes every profile composer bind
 * the same security contract without importing a product runtime.
 */
export const KESTREL_EXECUTION_BOUNDARY_POLICY_REVISION =
  "sha256:2d48fef187d7e38ac5565fd0a1241d5c3f2de21608ce0fd4363c1f327d9a5503";

export function fingerprintResolvedProfile(
  profile: unknown,
  revisionProvenance?: unknown,
): string {
  return fingerprintCanonicalValue({
    profile,
    executionBoundaryPolicyRevision: KESTREL_EXECUTION_BOUNDARY_POLICY_REVISION,
    ...(revisionProvenance !== undefined ? { revisionProvenance } : {}),
  });
}
