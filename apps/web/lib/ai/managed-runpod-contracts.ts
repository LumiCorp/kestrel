import { createHash } from "node:crypto";
import { z } from "zod";

export const RUNPOD_IMAGE_DIGEST_PATTERN =
  /^[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/u;

const boundedString = z.string().trim().min(1).max(191);
const environmentSchema = z
  .record(z.string().regex(/^[A-Z_][A-Z0-9_]*$/u), z.string().max(4096))
  .default({});
const secretReferenceSchema = z
  .record(
    z.string().regex(/^[A-Z_][A-Z0-9_]*$/u),
    z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_][A-Za-z0-9_-]{0,190}$/u)
  )
  .default({});

export const runPodTemplateSpecSchema = z
  .object({
    containerDiskInGb: z.number().int().min(15).max(1000).default(50),
    containerRegistryAuthId: boundedString.nullable().default(null),
    dockerEntrypoint: z.array(z.string().max(1024)).max(32).default([]),
    dockerStartCmd: z.array(z.string().max(1024)).max(32).default([]),
    env: environmentSchema,
    secretEnv: secretReferenceSchema,
    ports: z
      .array(z.string().regex(/^\d{1,5}\/(?:http|tcp)$/u))
      .max(16)
      .default([]),
    volumeInGb: z.number().int().min(0).max(10_000).default(0),
    volumeMountPath: z.string().trim().min(1).max(512).default("/workspace"),
  })
  .strict()
  .refine(
    (value) => Object.keys(value.secretEnv).every((key) => !(key in value.env)),
    {
      message: "Environment keys cannot be both plain and secret references.",
      path: ["secretEnv"],
    }
  );

export const runPodEndpointSpecSchema = z
  .object({
    allowedCudaVersions: z.array(boundedString).max(16).default([]),
    dataCenterIds: z.array(boundedString).max(32).default([]),
    executionTimeoutMs: z
      .number()
      .int()
      .min(1000)
      .max(86_400_000)
      .default(600_000),
    flashboot: z.boolean().default(true),
    gpuCount: z.number().int().min(1).max(8).default(1),
    gpuTypeIds: z.array(boundedString).min(1).max(16),
    idleTimeout: z.number().int().min(1).max(3600).default(5),
    minCudaVersion: boundedString.nullable().default(null),
    networkVolumeIds: z.array(boundedString).max(16).default([]),
    scalerType: z.enum(["QUEUE_DELAY", "REQUEST_COUNT"]).default("QUEUE_DELAY"),
    scalerValue: z.number().int().min(1).max(10_000).default(4),
    workersMax: z.number().int().min(1).max(10).default(1),
    workersMin: z.number().int().min(0).max(10).default(0),
    estimatedMaxCostUsdPerHour: z.number().positive().max(10_000),
  })
  .strict()
  .refine((value) => value.workersMin <= value.workersMax, {
    message: "workersMin cannot exceed workersMax",
    path: ["workersMin"],
  });

export const managedRunPodProfileInputSchema = z
  .object({
    profileKey: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{1,62}$/u),
    displayName: boundedString,
    description: z.string().trim().max(2000).nullable().default(null),
    imageRef: z.string().trim().regex(RUNPOD_IMAGE_DIGEST_PATTERN),
    expectedModelId: boundedString,
    templateSpec: runPodTemplateSpecSchema,
    endpointSpec: runPodEndpointSpecSchema,
    costLimitUsdPerHour: z.number().positive().max(10_000),
  })
  .strict()
  .refine(
    (value) =>
      value.endpointSpec.estimatedMaxCostUsdPerHour <=
      value.costLimitUsdPerHour,
    {
      message: "Estimated maximum cost exceeds the profile cost limit.",
      path: ["costLimitUsdPerHour"],
    }
  );

export type RunPodTemplateSpec = z.infer<typeof runPodTemplateSpecSchema>;
export type RunPodEndpointSpec = z.infer<typeof runPodEndpointSpecSchema>;
export type ManagedRunPodProfileInput = z.infer<
  typeof managedRunPodProfileInputSchema
>;

export type ManagedRunPodSpecSnapshot = ManagedRunPodProfileInput & {
  profileId: string;
  profileVersion: number;
  specHash: string;
};

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalize(nested)])
    );
  }
  return value;
}

export function hashManagedRunPodProfile(input: ManagedRunPodProfileInput) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(input)))
    .digest("hex");
}

export function parseManagedRunPodSpecSnapshot(
  value: unknown
): ManagedRunPodSpecSnapshot {
  const root = z
    .object({
      profileId: z.string().min(1),
      profileVersion: z.number().int().positive(),
      specHash: z.string().regex(/^[a-f0-9]{64}$/u),
    })
    .passthrough()
    .parse(value);
  const { profileId, profileVersion, specHash, ...profile } = root;
  return {
    ...managedRunPodProfileInputSchema.parse(profile),
    profileId,
    profileVersion,
    specHash,
  };
}

export function sanitizeManagedRunPodTemplateSpec(value: unknown) {
  const spec = runPodTemplateSpecSchema.parse(value);
  return {
    ...spec,
    containerRegistryAuthId: spec.containerRegistryAuthId ? "configured" : null,
    env: Object.fromEntries(
      Object.keys(spec.env).map((key) => [key, "configured"])
    ),
    secretEnv: Object.fromEntries(
      Object.keys(spec.secretEnv).map((key) => [key, "configured"])
    ),
  };
}

export function sanitizeManagedRunPodEndpointSpec(value: unknown) {
  const spec = runPodEndpointSpecSchema.parse(value);
  return {
    ...spec,
    networkVolumeIds: spec.networkVolumeIds.map(() => "configured"),
  };
}

export function sanitizeManagedRunPodSpecSnapshot(value: unknown) {
  const snapshot = parseManagedRunPodSpecSnapshot(value);
  return {
    ...snapshot,
    templateSpec: sanitizeManagedRunPodTemplateSpec(snapshot.templateSpec),
    endpointSpec: sanitizeManagedRunPodEndpointSpec(snapshot.endpointSpec),
  };
}

export function getManagedRunPodResourceName(input: {
  kind: "deployment" | "qualification";
  id: string;
}) {
  const normalizedId = input.id.toLowerCase().replace(/[^a-z0-9-]/gu, "-");
  return `kestrel-${input.kind}-${normalizedId}`.slice(0, 191);
}
