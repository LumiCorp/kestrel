import { createPrivateKey, createPublicKey } from "node:crypto";
import { assertGatewayCredentialEncryptionConfigured } from "@/lib/ai/gateway-credential-crypto";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export const HOSTED_ENVIRONMENTS_FEATURE_KEY = "hosted_environments";

export type HostedEnvironmentsRollout = {
  deploymentEnabled: boolean;
  organizationConfigured: boolean;
  organizationEnabled: boolean;
  effectiveEnabled: boolean;
};

export type HostedEnvironmentRuntimeMode = "fly" | "local";
export type HostedRoutingContractMode = "legacy" | "logical-v1";

export function getHostedRoutingContractMode(
  env: Record<string, string | undefined> = process.env,
): HostedRoutingContractMode {
  const value = env.KESTREL_HOSTED_ROUTING_CONTRACT_MODE?.trim().toLowerCase();
  if (!value || value === "legacy") return "legacy";
  if (value === "logical-v1") return "logical-v1";
  throw new Error(
    "KESTREL_HOSTED_ROUTING_CONTRACT_MODE must be legacy or logical-v1.",
  );
}

const REQUIRED_HOSTED_ENVIRONMENT_VALUES = [
  "CRON_SECRET",
  "KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY",
  "KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY",
  "KESTREL_WORKSPACE_BACKUP_KEY",
  "KESTREL_WORKSPACE_BACKUP_KEY_ID",
  "KESTREL_ONE_APP_URL",
  "KESTREL_ONE_CREDENTIAL_BROKER_TOKEN",
  "KESTREL_ONE_TOOL_TOKEN",
  "KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID",
  "KESTREL_GATEWAY_CREDENTIAL_KEYS",
] as const;

const LEGACY_GLOBAL_RUNNER_VALUES = [
  "KESTREL_RUNNER_SERVICE_URL",
  "KESTREL_RUNNER_SERVICE_TOKEN",
] as const;

export function getHostedEnvironmentRuntimeMode(
  env: Record<string, string | undefined> = process.env
): HostedEnvironmentRuntimeMode {
  const value = env.KESTREL_ENVIRONMENT_RUNTIME?.trim().toLowerCase();
  if (!value) return "fly";
  if (value === "fly") return value;
  if (value === "local") {
    if (env.VERCEL_ENV) {
      throw new Error(
        "The local Environment runtime cannot be used in a Vercel deployment."
      );
    }
    return value;
  }
  throw new Error("KESTREL_ENVIRONMENT_RUNTIME must be fly or local.");
}

export function hostedEnvironmentsDeploymentEnabled(
  env: Record<string, string | undefined> = process.env
) {
  const value = env.KESTREL_ENVIRONMENTS_ENABLED?.trim().toLowerCase();
  if (!value) return true;
  return value === "true";
}

export function hostedEnvironmentsOrganizationEnabled(
  enabled: boolean | null | undefined
) {
  return enabled === true;
}

export function hostedEnvironmentsEnabled(input: {
  organizationEnabled: boolean;
  env?: Record<string, string | undefined>;
}) {
  return (
    hostedEnvironmentsDeploymentEnabled(input.env) && input.organizationEnabled
  );
}

export function assertHostedEnvironmentConfiguration(
  env: Record<string, string | undefined> = process.env
) {
  if (getHostedEnvironmentRuntimeMode(env) === "local") {
    assertLocalEnvironmentRuntimeConfiguration(env);
    return;
  }
  assertHostedEnvironmentRuntimeConfiguration(env);
  const legacy = LEGACY_GLOBAL_RUNNER_VALUES.filter((name) =>
    env[name]?.trim()
  );
  if (legacy.length > 0) {
    throw new Error(
      `Hosted Environment cutover requires removing legacy global runner configuration: ${legacy.join(", ")}.`
    );
  }
}

export function assertLocalEnvironmentRuntimeConfiguration(
  env: Record<string, string | undefined> = process.env
) {
  const runnerUrl = env.KESTREL_LOCAL_ENVIRONMENT_RUNNER_URL?.trim();
  if (!runnerUrl) {
    throw new Error(
      "Local Environment runtime requires KESTREL_LOCAL_ENVIRONMENT_RUNNER_URL. Start Kestrel One with pnpm dev:all."
    );
  }
  const url = new URL(runnerUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      "KESTREL_LOCAL_ENVIRONMENT_RUNNER_URL must use HTTP or HTTPS."
    );
  }
  if (!(url.hostname === "127.0.0.1" || url.hostname === "localhost")) {
    throw new Error(
      "KESTREL_LOCAL_ENVIRONMENT_RUNNER_URL must target localhost."
    );
  }
}

export function assertHostedEnvironmentRuntimeConfiguration(
  env: Record<string, string | undefined> = process.env
) {
  getHostedRoutingContractMode(env);
  const missing = REQUIRED_HOSTED_ENVIRONMENT_VALUES.filter(
    (name) => !env[name]?.trim()
  );
  if (missing.length > 0) {
    throw new Error(
      `Hosted Environment configuration is incomplete: ${missing.join(", ")}.`
    );
  }
  const backupKey = Buffer.from(
    env.KESTREL_WORKSPACE_BACKUP_KEY ?? "",
    "base64"
  );
  if (backupKey.byteLength !== 32) {
    throw new Error(
      "KESTREL_WORKSPACE_BACKUP_KEY must be a base64-encoded 32-byte key."
    );
  }
  const controlPlaneUrl = new URL(env.KESTREL_ONE_APP_URL ?? "");
  if (
    controlPlaneUrl.protocol !== "https:" &&
    !["127.0.0.1", "localhost"].includes(controlPlaneUrl.hostname)
  ) {
    throw new Error(
      "KESTREL_ONE_APP_URL must use HTTPS outside local development."
    );
  }
  assertGatewayCredentialEncryptionConfigured(env as NodeJS.ProcessEnv);
  try {
    const privateKey = createPrivateKey(
      env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY ?? ""
    );
    const configuredPublicKey = createPublicKey(
      env.KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY ?? ""
    );
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
      "Environment ticket keys must be a matching Ed25519 private/public key pair."
    );
  }
}

export async function getHostedEnvironmentsRollout(input: {
  organizationId: string;
  env?: Record<string, string | undefined>;
}): Promise<HostedEnvironmentsRollout> {
  const flag = await knowledgeDb.query.organizationFeatureFlags.findFirst({
    where: (table, { and, eq }) =>
      and(
        eq(table.organizationId, input.organizationId),
        eq(table.key, HOSTED_ENVIRONMENTS_FEATURE_KEY)
      ),
  });
  const deploymentEnabled = hostedEnvironmentsDeploymentEnabled(input.env);
  const organizationEnabled = hostedEnvironmentsOrganizationEnabled(
    flag?.enabled
  );
  return {
    deploymentEnabled,
    organizationConfigured: Boolean(flag),
    organizationEnabled,
    effectiveEnabled: deploymentEnabled && organizationEnabled,
  };
}

export async function setHostedEnvironmentsOrganizationFlag(input: {
  organizationId: string;
  actorUserId: string;
  enabled: boolean;
}) {
  const now = new Date();
  const [flag] = await knowledgeDb
    .insert(schema.organizationFeatureFlags)
    .values({
      organizationId: input.organizationId,
      key: HOSTED_ENVIRONMENTS_FEATURE_KEY,
      enabled: input.enabled,
      updatedByUserId: input.actorUserId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.organizationFeatureFlags.organizationId,
        schema.organizationFeatureFlags.key,
      ],
      set: {
        enabled: input.enabled,
        updatedByUserId: input.actorUserId,
        updatedAt: now,
      },
    })
    .returning();
  if (!flag) throw new Error("Environment rollout update failed.");
  return flag;
}

export async function requireHostedEnvironmentsEnabled(input: {
  organizationId: string;
  env?: Record<string, string | undefined>;
}) {
  const rollout = await getHostedEnvironmentsRollout(input);
  if (!rollout.deploymentEnabled) {
    throw new Error(
      "Hosted Environments are not enabled for this Kestrel One deployment."
    );
  }
  if (!rollout.organizationEnabled) {
    throw new Error(
      "Hosted Environments are not enabled for this organization."
    );
  }
  return rollout;
}
