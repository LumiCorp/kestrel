export function isEnvironmentPrivateInferenceEnabled() {
  return process.env.KESTREL_PRIVATE_INFERENCE_ENABLED === "true";
}

export function assertEnvironmentPrivateInferenceEnabled() {
  if (!isEnvironmentPrivateInferenceEnabled()) {
    throw new Error("Environment private inference is disabled.");
  }
}

export function isManagedRunPodEnabled() {
  return process.env.RUNPOD_MANAGED_DEPLOYMENTS_ENABLED === "true";
}

export function assertManagedRunPodEnabled() {
  if (!isManagedRunPodEnabled()) {
    throw new Error("Managed RunPod deployments are disabled.");
  }
}
