import type { KubernetesProofProfile } from "./kubernetes-proof";

export type KubernetesCanaryEdgeMode = "gateway_api" | "ingress";

/**
 * The sanitized connection configuration is the authority for the live edge
 * path. The canary must not infer qualified-provider topology from the proof
 * profile name.
 */
export function resolveKubernetesCanaryEdgeMode(input: {
  connection: unknown;
  profile: KubernetesProofProfile;
}): KubernetesCanaryEdgeMode {
  const connection = record(input.connection, "connection");
  const configuration = record(connection.configuration, "connection.configuration");
  const value = record(configuration.value, "connection.configuration.value");
  const profile = record(value.profile, "connection.configuration.value.profile");
  const edge = record(profile.edge, "connection.configuration.value.profile.edge");
  const mode = edge.mode;
  if (mode !== "gateway_api" && mode !== "ingress") {
    throw new Error("Kubernetes connection configuration has an invalid edge mode.");
  }
  if (input.profile === "gke" && mode !== "gateway_api") {
    throw new Error("GKE proof requires a Gateway API connection configuration.");
  }
  if (input.profile === "eks" && mode !== "ingress") {
    throw new Error("EKS proof requires an Ingress connection configuration.");
  }
  return mode;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is unavailable.`);
  }
  return value as Record<string, unknown>;
}
