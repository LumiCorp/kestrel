import { createPrivateKey, createPublicKey } from "node:crypto";
import { assertGatewayCredentialEncryptionConfigured } from "@/lib/ai/gateway-credential-crypto";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

export const HOSTED_ENVIRONMENTS_FEATURE_KEY = "hosted_environments";

export type HostedEnvironmentsRollout = {
  deploymentEnabled: boolean;
  organizationEnabled: boolean;
  effectiveEnabled: boolean;
};

const REQUIRED_HOSTED_ENVIRONMENT_VALUES = [
  "CRON_SECRET",
  "FLY_API_TOKEN",
  "KESTREL_FLY_ORGANIZATION_SLUG",
  "KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY",
  "KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY",
  "KESTREL_ENVIRONMENT_ROUTER_IMAGE",
  "KESTREL_WORKSPACE_RUNTIME_IMAGE",
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

export function hostedEnvironmentsDeploymentEnabled(
  env: Record<string, string | undefined> = process.env
) {
  return env.KESTREL_ENVIRONMENTS_ENABLED?.trim().toLowerCase() === "true";
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
  const missing = REQUIRED_HOSTED_ENVIRONMENT_VALUES.filter(
    (name) => !env[name]?.trim()
  );
  if (missing.length > 0) {
    throw new Error(
      `Hosted Environment configuration is incomplete: ${missing.join(", ")}.`
    );
  }
  const legacy = LEGACY_GLOBAL_RUNNER_VALUES.filter((name) =>
    env[name]?.trim()
  );
  if (legacy.length > 0) {
    throw new Error(
      `Hosted Environment cutover requires removing legacy global runner configuration: ${legacy.join(", ")}.`
    );
  }
  for (const imageName of [
    "KESTREL_ENVIRONMENT_ROUTER_IMAGE",
    "KESTREL_WORKSPACE_RUNTIME_IMAGE",
  ] as const) {
    const image = env[imageName] ?? "";
    if (
      !/^registry\.fly\.io\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u.test(
        image
      )
    ) {
      throw new Error(
        `${imageName} must be an immutable registry.fly.io sha256 digest reference.`
      );
    }
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
  const organizationEnabled = flag?.enabled === true;
  return {
    deploymentEnabled,
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
  assertHostedEnvironmentConfiguration(input.env);
  return rollout;
}
