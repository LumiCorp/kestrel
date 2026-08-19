import { z } from "zod";

const digestImageSchema = z
  .string()
  .trim()
  .regex(
    /^[a-z0-9][a-z0-9._/-]*(?::[a-zA-Z0-9._-]+)?@sha256:[a-f0-9]{64}$/u,
    "Connector image must include an immutable sha256 digest.",
  );

export const connectorConfigSchema = z
  .object({
    kestrelBaseUrl: z.string().url().refine((value) => new URL(value).protocol === "https:"),
    displayName: z.string().trim().min(1).max(120),
    namespace: z.string().trim().min(1).max(63).default("kestrel-system"),
    identitySecretName: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .default("kestrel-connector-identity"),
    leaderLeaseName: z
      .string()
      .trim()
      .min(1)
      .max(63)
      .default("kestrel-connector-enrollment"),
    replicaId: z.string().trim().min(1).max(253),
    connectorVersion: z.string().trim().min(1).max(80),
    image: digestImageSchema,
    port: z.number().int().min(1).max(65_535).default(8080),
    serviceAccountTokenPath: z
      .string()
      .min(1)
      .default("/var/run/secrets/kubernetes.io/serviceaccount/token"),
    serviceAccountCaPath: z
      .string()
      .min(1)
      .default("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"),
    kubernetesHost: z.string().trim().min(1),
    kubernetesPort: z.number().int().min(1).max(65_535),
    outboundProxy: z.string().url().optional(),
  })
  .strict();

export type ConnectorConfig = z.infer<typeof connectorConfigSchema>;

export function readConnectorConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ConnectorConfig {
  return connectorConfigSchema.parse({
    kestrelBaseUrl: environment.KESTREL_BASE_URL,
    displayName: environment.KESTREL_CONNECTOR_DISPLAY_NAME,
    namespace: environment.KESTREL_CONNECTOR_NAMESPACE,
    identitySecretName: environment.KESTREL_CONNECTOR_IDENTITY_SECRET,
    leaderLeaseName: environment.KESTREL_CONNECTOR_LEADER_LEASE,
    replicaId: environment.POD_NAME,
    connectorVersion: environment.KESTREL_CONNECTOR_VERSION,
    image: environment.KESTREL_CONNECTOR_IMAGE,
    port: environment.PORT ? Number(environment.PORT) : undefined,
    serviceAccountTokenPath: environment.KUBERNETES_SERVICE_ACCOUNT_TOKEN_PATH,
    serviceAccountCaPath: environment.KUBERNETES_SERVICE_ACCOUNT_CA_PATH,
    kubernetesHost: environment.KUBERNETES_SERVICE_HOST,
    kubernetesPort: environment.KUBERNETES_SERVICE_PORT_HTTPS
      ? Number(environment.KUBERNETES_SERVICE_PORT_HTTPS)
      : 443,
    outboundProxy: environment.HTTPS_PROXY || environment.https_proxy,
  });
}
