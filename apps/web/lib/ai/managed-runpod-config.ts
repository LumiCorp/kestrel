export function isManagedRunPodEnabled() {
  return process.env.RUNPOD_MANAGED_DEPLOYMENTS_ENABLED === "true";
}

export function assertManagedRunPodEnabled() {
  if (!isManagedRunPodEnabled()) {
    throw new Error("Managed RunPod deployments are disabled.");
  }
}
