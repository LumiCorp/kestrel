export type DesktopClaimRuntimeBinding = {
  id: string;
  threadId: string;
  runtimeId: "kestrel" | "codex" | "claude";
  environmentId: string | null;
  capabilityDigest: string | null;
};

/**
 * Binding identity is loaded by binding and Thread before this policy runs.
 * Kestrel bindings created before Environment pinning may be unscoped. Foreign
 * Runtime bindings must carry the exact signed connector Environment and a
 * descriptor capability proof.
 */
export function desktopClaimRuntimeBindingMatches(input: {
  binding: DesktopClaimRuntimeBinding;
  bindingId: string;
  threadId: string;
  claimedRuntimeId: "kestrel" | "codex" | "claude";
  authenticatedEnvironmentId: string;
}) {
  if (
    input.binding.id !== input.bindingId ||
    input.binding.threadId !== input.threadId ||
    input.binding.runtimeId !== input.claimedRuntimeId
  ) {
    return false;
  }
  if (input.binding.environmentId === null) {
    return input.claimedRuntimeId === "kestrel";
  }
  if (input.binding.environmentId !== input.authenticatedEnvironmentId) {
    return false;
  }
  return input.claimedRuntimeId === "kestrel" ||
    input.binding.capabilityDigest !== null;
}
