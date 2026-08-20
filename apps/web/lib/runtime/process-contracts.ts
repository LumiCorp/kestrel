import { createPrivateKey, createPublicKey } from "node:crypto";

export type ProcessRole =
  | "web"
  | "turn-worker"
  | "control-worker"
  | "runpod-worker";

export type ProcessContract = {
  role: ProcessRole;
  required: readonly string[];
  optional: readonly string[];
  oneOf: readonly (readonly string[])[];
  forbidden: readonly string[];
};

const IMAGE_CONFIGURATION = [
  "KESTREL_ENVIRONMENT_ROUTER_IMAGE",
  "KESTREL_WORKSPACE_RUNTIME_IMAGE",
] as const;

const PLATFORM_FLY_CONFIGURATION = [
  "FLY_API_TOKEN",
  "KESTREL_FLY_ORGANIZATION_SLUG",
] as const;

const BACKUP_CONFIGURATION = [
  "KESTREL_WORKSPACE_BACKUP_KEY",
  "KESTREL_WORKSPACE_BACKUP_KEY_ID",
  "STORAGE_ACCESS_KEY_ID",
  "STORAGE_BUCKET",
  "STORAGE_ENDPOINT",
  "STORAGE_FORCE_PATH_STYLE",
  "STORAGE_KEY_PREFIX",
  "STORAGE_PROVIDER",
  "STORAGE_REGION",
  "STORAGE_SECRET_ACCESS_KEY",
] as const;

const OPTIONAL_STORAGE_CONFIGURATION = [
  "STORAGE_FORCE_PATH_STYLE",
  "STORAGE_KEY_PREFIX",
  "STORAGE_REGION",
] as const;

export const WEB_PROCESS_CONTRACT = {
  role: "web",
  required: [
    "CRON_SECRET",
    "KESTREL_ENVIRONMENTS_ENABLED",
    "KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY",
    "KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY",
    "KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID",
    "KESTREL_GATEWAY_CREDENTIAL_KEYS",
    "KESTREL_FLY_ORGANIZATION_SLUG",
    "KESTREL_ONE_APP_URL",
    "KESTREL_ONE_CREDENTIAL_BROKER_TOKEN",
    "KESTREL_ONE_TOOL_TOKEN",
    "KESTREL_WORKSPACE_BACKUP_KEY",
    "KESTREL_WORKSPACE_BACKUP_KEY_ID",
    "FLY_API_TOKEN",
    "STORAGE_BUCKET",
    "STORAGE_ENDPOINT",
    "STORAGE_PROVIDER",
    "STORAGE_ACCESS_KEY_ID",
    "STORAGE_SECRET_ACCESS_KEY",
  ],
  optional: [
    "DATABASE_URL",
    "POSTGRES_URL",
    "KESTREL_ONE_PROFILE_ID",
    ...OPTIONAL_STORAGE_CONFIGURATION,
  ],
  oneOf: [["DATABASE_URL", "POSTGRES_URL"]],
  forbidden: [...IMAGE_CONFIGURATION],
} as const satisfies ProcessContract;

export const TURN_WORKER_PROCESS_CONTRACT = {
  role: "turn-worker",
  required: [
    "KESTREL_ENVIRONMENTS_ENABLED",
    "KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY",
    "KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY",
    "KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID",
    "KESTREL_GATEWAY_CREDENTIAL_KEYS",
    "KESTREL_ONE_APP_URL",
    "KESTREL_ONE_CREDENTIAL_BROKER_TOKEN",
    "KESTREL_ONE_PROFILE_ID",
    "KESTREL_ONE_TOOL_TOKEN",
  ],
  optional: [
    "DATABASE_URL",
    "POSTGRES_URL",
    "REDIS_URL",
    "KV_URL",
    "KESTREL_APP_CREDENTIAL_ACTIVE_KEY_ID",
    "KESTREL_APP_CREDENTIAL_KEYS",
    "KESTREL_ONE_AGENT_ID",
    "KESTREL_ONE_CONTEXT_GRANT_TTL_SECONDS",
    "KESTREL_TURN_WORKER_CONCURRENCY",
    "KESTREL_PRIVATE_INFERENCE_ENABLED",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "TAVILY_API_KEY",
    "TAVILY_PROJECT",
  ],
  oneOf: [
    ["DATABASE_URL", "POSTGRES_URL"],
    ["REDIS_URL", "KV_URL"],
  ],
  forbidden: [
    ...IMAGE_CONFIGURATION,
    ...PLATFORM_FLY_CONFIGURATION,
    "CRON_SECRET",
    ...BACKUP_CONFIGURATION,
  ],
} as const satisfies ProcessContract;

export const CONTROL_WORKER_PROCESS_CONTRACT = {
  role: "control-worker",
  required: [
    "FLY_API_TOKEN",
    "KESTREL_ENVIRONMENTS_ENABLED",
    "KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY",
    "KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY",
    "KESTREL_FLY_ORGANIZATION_SLUG",
    "KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID",
    "KESTREL_GATEWAY_CREDENTIAL_KEYS",
    "KESTREL_ONE_APP_URL",
    "KESTREL_ONE_CREDENTIAL_BROKER_TOKEN",
    "KESTREL_ONE_TOOL_TOKEN",
    "KESTREL_WORKSPACE_BACKUP_KEY",
    "KESTREL_WORKSPACE_BACKUP_KEY_ID",
    "STORAGE_BUCKET",
    "STORAGE_ENDPOINT",
    "STORAGE_PROVIDER",
    "STORAGE_ACCESS_KEY_ID",
    "STORAGE_SECRET_ACCESS_KEY",
  ],
  optional: [
    "DATABASE_URL",
    "POSTGRES_URL",
    "KESTREL_ENVIRONMENT_DEFAULT_REGION",
    "KESTREL_ONE_PROFILE_ID",
    "KESTREL_PREVIEW_EDGE_PUBLIC_ORIGIN",
    "KESTREL_PREVIEW_EDGE_SERVICE_TOKEN",
    "KESTREL_PREVIEW_HOST_SUFFIX",
    ...OPTIONAL_STORAGE_CONFIGURATION,
  ],
  oneOf: [["DATABASE_URL", "POSTGRES_URL"]],
  forbidden: [...IMAGE_CONFIGURATION, "CRON_SECRET"],
} as const satisfies ProcessContract;

export const RUNPOD_WORKER_PROCESS_CONTRACT = {
  role: "runpod-worker",
  required: [
    "KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID",
    "KESTREL_GATEWAY_CREDENTIAL_KEYS",
    "KESTREL_PRIVATE_INFERENCE_ENABLED",
    "RUNPOD_MANAGED_DEPLOYMENTS_ENABLED",
  ],
  optional: [
    "DATABASE_URL",
    "POSTGRES_URL",
    "KESTREL_APP_CREDENTIAL_ACTIVE_KEY_ID",
    "KESTREL_APP_CREDENTIAL_KEYS",
  ],
  oneOf: [["DATABASE_URL", "POSTGRES_URL"]],
  forbidden: [
    ...IMAGE_CONFIGURATION,
    ...PLATFORM_FLY_CONFIGURATION,
    "CRON_SECRET",
    ...BACKUP_CONFIGURATION,
    "RUNPOD_API_KEY",
  ],
} as const satisfies ProcessContract;

export function processContractAllowedNames(contract: ProcessContract) {
  return new Set([
    ...contract.required,
    ...contract.optional,
    ...contract.oneOf.flat(),
  ]);
}

export const MANAGED_HOSTED_RUNTIME_SECRET_NAMES = new Set([
  ...processContractAllowedNames(WEB_PROCESS_CONTRACT),
  ...processContractAllowedNames(TURN_WORKER_PROCESS_CONTRACT),
  ...processContractAllowedNames(CONTROL_WORKER_PROCESS_CONTRACT),
  ...processContractAllowedNames(RUNPOD_WORKER_PROCESS_CONTRACT),
  ...IMAGE_CONFIGURATION,
  ...PLATFORM_FLY_CONFIGURATION,
]);

export function assertProcessConfiguration(
  contract: ProcessContract,
  env: Record<string, string | undefined> = process.env,
) {
  const present = (name: string) => Boolean(env[name]?.trim());
  const forbidden = contract.forbidden.filter(present);
  if (forbidden.length) {
    throw new Error(
      `${contract.role} configuration contains forbidden values: ${forbidden.join(", ")}.`,
    );
  }
  const missing = contract.required.filter((name) => !present(name));
  for (const group of contract.oneOf) {
    if (!group.some(present)) missing.push(group.join(" or "));
  }
  if (missing.length) {
    throw new Error(
      `${contract.role} configuration is incomplete: ${missing.join(", ")}.`,
    );
  }
  assertTicketKeyPair(env);
}

function assertTicketKeyPair(env: Record<string, string | undefined>) {
  const privateValue = env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY?.trim();
  const publicValue = env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY?.trim();
  if (!(privateValue && publicValue)) return;
  try {
    const privateKey = createPrivateKey(privateValue);
    const configuredPublicKey = createPublicKey(publicValue);
    if (
      privateKey.asymmetricKeyType !== "ed25519" ||
      configuredPublicKey.asymmetricKeyType !== "ed25519" ||
      !createPublicKey(privateKey)
        .export({ format: "der", type: "spki" })
        .equals(configuredPublicKey.export({ format: "der", type: "spki" }))
    ) {
      throw new Error("mismatch");
    }
  } catch {
    throw new Error(
      `${env === process.env ? "Process" : "Hosted runtime"} Environment ticket keys must be a matching Ed25519 private/public key pair.`,
    );
  }
}

export function assertWebProcessConfiguration(
  env: Record<string, string | undefined> = process.env,
) {
  assertProcessConfiguration(WEB_PROCESS_CONTRACT, env);
}

export function assertTurnWorkerProcessConfiguration(
  env: Record<string, string | undefined> = process.env,
) {
  assertProcessConfiguration(TURN_WORKER_PROCESS_CONTRACT, env);
  resolveTurnWorkerConcurrency(env);
}

export function resolveTurnWorkerConcurrency(
  env: Record<string, string | undefined> = process.env,
) {
  const raw = env.KESTREL_TURN_WORKER_CONCURRENCY?.trim();
  if (!raw) return 16;
  if (!/^[0-9]+$/u.test(raw)) {
    throw new Error(
      "KESTREL_TURN_WORKER_CONCURRENCY must be an integer from 1 to 64.",
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > 64) {
    throw new Error(
      "KESTREL_TURN_WORKER_CONCURRENCY must be an integer from 1 to 64.",
    );
  }
  return value;
}

export function assertControlWorkerProcessConfiguration(
  env: Record<string, string | undefined> = process.env,
) {
  assertProcessConfiguration(CONTROL_WORKER_PROCESS_CONTRACT, env);
  assertControlWorkerSemanticConfiguration(env);
}

export function assertRunPodWorkerProcessConfiguration(
  env: Record<string, string | undefined> = process.env,
) {
  assertProcessConfiguration(RUNPOD_WORKER_PROCESS_CONTRACT, env);
  if (
    env.KESTREL_PRIVATE_INFERENCE_ENABLED !== "true" ||
    env.RUNPOD_MANAGED_DEPLOYMENTS_ENABLED !== "true"
  ) {
    throw new Error(
      "runpod-worker managed deployment flags must both be exactly true.",
    );
  }
  assertGatewayCredentialConfiguration(env);
}

function assertControlWorkerSemanticConfiguration(
  env: Record<string, string | undefined>,
) {
  const backupKey = Buffer.from(
    env.KESTREL_WORKSPACE_BACKUP_KEY ?? "",
    "base64",
  );
  if (backupKey.byteLength !== 32) {
    throw new Error(
      "KESTREL_WORKSPACE_BACKUP_KEY must be a base64-encoded 32-byte key.",
    );
  }
  const controlPlaneUrl = new URL(env.KESTREL_ONE_APP_URL ?? "");
  if (
    controlPlaneUrl.protocol !== "https:" &&
    !["127.0.0.1", "localhost"].includes(controlPlaneUrl.hostname)
  ) {
    throw new Error(
      "KESTREL_ONE_APP_URL must use HTTPS outside local development.",
    );
  }
  assertGatewayCredentialConfiguration(env);
}

function assertGatewayCredentialConfiguration(
  env: Record<string, string | undefined>,
) {
  const activeKeyId = env.KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID?.trim();
  const rawKeys = env.KESTREL_GATEWAY_CREDENTIAL_KEYS?.trim();
  if (!(activeKeyId && rawKeys)) {
    throw new Error(
      "Gateway credential encryption requires an active key ID and keyring.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawKeys);
  } catch {
    throw new Error(
      "KESTREL_GATEWAY_CREDENTIAL_KEYS must be a JSON object of base64-encoded 32-byte keys.",
    );
  }
  if (!(parsed && typeof parsed === "object" && !Array.isArray(parsed))) {
    throw new Error("KESTREL_GATEWAY_CREDENTIAL_KEYS must be a JSON object.");
  }
  const entries = Object.entries(parsed);
  for (const [keyId, encodedKey] of entries) {
    if (
      !/^[A-Za-z0-9._-]{1,64}$/u.test(keyId) ||
      typeof encodedKey !== "string" ||
      Buffer.from(encodedKey, "base64").byteLength !== 32
    ) {
      throw new Error(
        "KESTREL_GATEWAY_CREDENTIAL_KEYS must contain valid base64-encoded keys that decode to 32 bytes.",
      );
    }
  }
  if (!Object.hasOwn(parsed, activeKeyId)) {
    throw new Error(
      "KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID must identify a configured gateway credential key.",
    );
  }
}
