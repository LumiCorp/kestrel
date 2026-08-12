import "server-only";

import { createHash, randomBytes } from "node:crypto";
import {
  parseRunnerEventV2,
  type RunnerEventEnvelope,
  type RuntimeDescriptorResolutionV1,
} from "@kestrel-agents/protocol";
import { and, asc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import type { DesktopConnectorAuthorization } from "@/lib/environments/desktop";
import { knowledgeDb, schema } from "@/lib/knowledge/db";

const PROBE_LEASE_MS = 90_000;
const PROBE_DEADLINE_MS = 30_000;
const MAX_ACTIVE_PROBES = 2;
const FAILURE_CODES = new Set([
  "RUNTIME_AUTH_REQUIRED",
  "RUNTIME_UNAVAILABLE",
  "RUNTIME_VERSION_MISMATCH",
  "RUNTIME_MODEL_UNAVAILABLE",
  "RUNTIME_DESCRIPTOR_FAILED",
]);

export type DesktopRuntimeDescriptorProbeRequest = {
  client: "web";
  runtimeId: "codex" | "claude";
  modelProvider: "openai" | "openrouter" | "anthropic" | "ollama" | "lmstudio";
  model: string;
  environmentId: string;
};

export const desktopRuntimeDescriptorProbeCompletionSchema = z.object({
  claimToken: z.string().min(32).max(256),
  outcome: z.discriminatedUnion("status", [
    z.object({ status: z.literal("resolved"), event: z.unknown() }),
    z.object({
      status: z.literal("failed"),
      failureCode: z.string().trim().min(1).max(120),
    }),
  ]),
});

export async function requestDesktopRuntimeDescriptorProbe(input: {
  organizationId: string;
  environmentId: string;
  actorUserId: string;
  runtimeId: "codex" | "claude";
  requestedModelId: string;
  request: DesktopRuntimeDescriptorProbeRequest;
}): Promise<RuntimeDescriptorResolutionV1> {
  if (
    input.request.runtimeId !== input.runtimeId ||
    input.request.environmentId !== input.environmentId
  ) {
    throw descriptorProbeError("RUNTIME_DESCRIPTOR_FAILED");
  }
  const connection = await knowledgeDb.query.desktopEnvironmentConnections.findFirst({
    where: and(
      eq(schema.desktopEnvironmentConnections.organizationId, input.organizationId),
      eq(schema.desktopEnvironmentConnections.environmentId, input.environmentId),
      eq(schema.desktopEnvironmentConnections.status, "active"),
    ),
    columns: { id: true },
  });
  if (!connection) throw descriptorProbeError("RUNTIME_UNAVAILABLE");
  const id = crypto.randomUUID();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PROBE_DEADLINE_MS);
  await knowledgeDb.insert(schema.desktopRuntimeDescriptorProbes).values({
    id,
    organizationId: input.organizationId,
    environmentId: input.environmentId,
    actorUserId: input.actorUserId,
    runtimeId: input.runtimeId,
    requestedModelId: input.requestedModelId,
    request: input.request,
    state: "pending",
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });

  while (Date.now() < expiresAt.getTime()) {
    const probe = await knowledgeDb.query.desktopRuntimeDescriptorProbes.findFirst({
      where: eq(schema.desktopRuntimeDescriptorProbes.id, id),
    });
    if (!probe) throw descriptorProbeError("RUNTIME_DESCRIPTOR_FAILED");
    if (probe.state === "resolved") {
      return parseResolvedProbe(probe.resolution, input);
    }
    if (probe.state === "failed" || probe.state === "expired") {
      throw descriptorProbeError(probe.failureCode ?? "RUNTIME_DESCRIPTOR_FAILED");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  await knowledgeDb
    .update(schema.desktopRuntimeDescriptorProbes)
    .set({
      state: "expired",
      claimTokenHash: null,
      claimExpiresAt: null,
      failureCode: "RUNTIME_DESCRIPTOR_FAILED",
      failureMessage: "The Desktop Runtime descriptor probe timed out.",
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.desktopRuntimeDescriptorProbes.id, id),
      inArray(schema.desktopRuntimeDescriptorProbes.state, ["pending", "delivering"]),
    ));
  throw descriptorProbeError("RUNTIME_DESCRIPTOR_FAILED");
}

export async function claimDesktopRuntimeDescriptorProbe(
  authorization: DesktopConnectorAuthorization,
) {
  const now = new Date();
  const claimToken = randomBytes(32).toString("base64url");
  return knowledgeDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`kestrel:desktop-runtime-descriptor:${authorization.connection.id}`}, 0))`);
    const [{ count }] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.desktopRuntimeDescriptorProbes)
      .where(and(
        eq(schema.desktopRuntimeDescriptorProbes.organizationId, authorization.connection.organizationId),
        eq(schema.desktopRuntimeDescriptorProbes.environmentId, authorization.environment.id),
        eq(schema.desktopRuntimeDescriptorProbes.state, "delivering"),
        gt(schema.desktopRuntimeDescriptorProbes.claimExpiresAt, now),
      ));
    if ((count ?? 0) >= MAX_ACTIVE_PROBES) return null;
    const [candidate] = await tx
      .select()
      .from(schema.desktopRuntimeDescriptorProbes)
      .where(and(
        eq(schema.desktopRuntimeDescriptorProbes.organizationId, authorization.connection.organizationId),
        eq(schema.desktopRuntimeDescriptorProbes.environmentId, authorization.environment.id),
        gt(schema.desktopRuntimeDescriptorProbes.expiresAt, now),
        or(
          eq(schema.desktopRuntimeDescriptorProbes.state, "pending"),
          and(
            eq(schema.desktopRuntimeDescriptorProbes.state, "delivering"),
            lt(schema.desktopRuntimeDescriptorProbes.claimExpiresAt, now),
          ),
        ),
      ))
      .orderBy(asc(schema.desktopRuntimeDescriptorProbes.createdAt))
      .limit(1);
    if (!candidate) return null;
    const claimExpiresAt = new Date(now.getTime() + PROBE_LEASE_MS);
    const [claimed] = await tx
      .update(schema.desktopRuntimeDescriptorProbes)
      .set({
        state: "delivering",
        attempts: candidate.attempts + 1,
        claimTokenHash: hashClaimToken(claimToken),
        claimExpiresAt,
        claimedAt: now,
        failureCode: null,
        failureMessage: null,
        updatedAt: now,
      })
      .where(and(
        eq(schema.desktopRuntimeDescriptorProbes.id, candidate.id),
        eq(schema.desktopRuntimeDescriptorProbes.organizationId, authorization.connection.organizationId),
        eq(schema.desktopRuntimeDescriptorProbes.environmentId, authorization.environment.id),
      ))
      .returning();
    if (!claimed) return null;
    return {
      probe: {
        id: claimed.id,
        runtimeId: claimed.runtimeId,
        environmentId: claimed.environmentId,
        actorUserId: claimed.actorUserId,
        request: claimed.request as DesktopRuntimeDescriptorProbeRequest,
      },
      claimToken,
      claimExpiresAt: claimExpiresAt.toISOString(),
    };
  });
}

export async function renewDesktopRuntimeDescriptorProbeLease(input: {
  authorization: DesktopConnectorAuthorization;
  probeId: string;
  body: unknown;
}) {
  const body = z.object({ claimToken: z.string().min(32).max(256) }).parse(input.body);
  const now = new Date();
  const claimExpiresAt = new Date(now.getTime() + PROBE_LEASE_MS);
  const [renewed] = await knowledgeDb
    .update(schema.desktopRuntimeDescriptorProbes)
    .set({ claimExpiresAt, updatedAt: now })
    .where(and(
      eq(schema.desktopRuntimeDescriptorProbes.id, input.probeId),
      eq(schema.desktopRuntimeDescriptorProbes.organizationId, input.authorization.connection.organizationId),
      eq(schema.desktopRuntimeDescriptorProbes.environmentId, input.authorization.environment.id),
      eq(schema.desktopRuntimeDescriptorProbes.state, "delivering"),
      eq(schema.desktopRuntimeDescriptorProbes.claimTokenHash, hashClaimToken(body.claimToken)),
      gt(schema.desktopRuntimeDescriptorProbes.claimExpiresAt, now),
      gt(schema.desktopRuntimeDescriptorProbes.expiresAt, now),
    ))
    .returning();
  if (!renewed) throw descriptorProbeError("DESKTOP_RUNTIME_DESCRIPTOR_CLAIM_INVALID");
  return { claimExpiresAt: claimExpiresAt.toISOString() };
}

export async function completeDesktopRuntimeDescriptorProbe(input: {
  authorization: DesktopConnectorAuthorization;
  probeId: string;
  body: unknown;
}) {
  const body = desktopRuntimeDescriptorProbeCompletionSchema.parse(input.body);
  const tokenHash = hashClaimToken(body.claimToken);
  return knowledgeDb.transaction(async (tx) => {
    const [probe] = await tx
      .select()
      .from(schema.desktopRuntimeDescriptorProbes)
      .where(and(
        eq(schema.desktopRuntimeDescriptorProbes.id, input.probeId),
        eq(schema.desktopRuntimeDescriptorProbes.organizationId, input.authorization.connection.organizationId),
        eq(schema.desktopRuntimeDescriptorProbes.environmentId, input.authorization.environment.id),
        inArray(schema.desktopRuntimeDescriptorProbes.state, ["delivering", "resolved"]),
      ))
      .limit(1)
      .for("update");
    if (!probe || probe.claimTokenHash !== tokenHash) {
      throw descriptorProbeError("DESKTOP_RUNTIME_DESCRIPTOR_CLAIM_INVALID");
    }
    if (body.outcome.status === "failed") {
      if (probe.state !== "delivering" || !probe.claimExpiresAt || probe.claimExpiresAt <= new Date()) {
        throw descriptorProbeError("DESKTOP_RUNTIME_DESCRIPTOR_CLAIM_INVALID");
      }
      const [failed] = await tx
        .update(schema.desktopRuntimeDescriptorProbes)
        .set({
          state: "failed",
          claimTokenHash: null,
          claimExpiresAt: null,
          failureCode: sanitizeFailureCode(body.outcome.failureCode),
          failureMessage: "The Desktop Runtime descriptor probe failed.",
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.desktopRuntimeDescriptorProbes.id, probe.id))
        .returning();
      return failed!;
    }
    const event = parseRunnerEventV2(body.outcome.event);
    assertProbeResolution(probe, event);
    if (probe.state === "resolved") {
      if (probe.acknowledgementEventId !== event.id) {
        throw descriptorProbeError("DESKTOP_RUNTIME_DESCRIPTOR_ACK_CONFLICT");
      }
      return probe;
    }
    if (!probe.claimExpiresAt || probe.claimExpiresAt <= new Date()) {
      throw descriptorProbeError("DESKTOP_RUNTIME_DESCRIPTOR_CLAIM_INVALID");
    }
    const [resolved] = await tx
      .update(schema.desktopRuntimeDescriptorProbes)
      .set({
        state: "resolved",
        resolution: structuredClone(event.payload) as unknown as Record<string, unknown>,
        acknowledgementEventId: event.id,
        completedAt: new Date(),
        claimExpiresAt: null,
        failureCode: null,
        failureMessage: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.desktopRuntimeDescriptorProbes.id, probe.id))
      .returning();
    return resolved!;
  });
}

function assertProbeResolution(
  probe: typeof schema.desktopRuntimeDescriptorProbes.$inferSelect,
  event: ReturnType<typeof parseRunnerEventV2>,
): asserts event is RunnerEventEnvelope<"runtime.described"> {
  if (
    event.type !== "runtime.described" ||
    event.commandId !== probe.id ||
    event.payload.environmentId !== probe.environmentId ||
    event.payload.descriptor.runtimeId !== probe.runtimeId ||
    typeof event.payload.profileFingerprint !== "string" ||
    event.payload.profileFingerprint.length === 0 ||
    typeof event.payload.capabilityDigest !== "string" ||
    event.payload.capabilityDigest.length === 0 ||
    !isExactStoredProbeRequest(probe)
  ) {
    throw descriptorProbeError("DESKTOP_RUNTIME_DESCRIPTOR_ACK_INVALID");
  }
}

function isExactStoredProbeRequest(
  probe: typeof schema.desktopRuntimeDescriptorProbes.$inferSelect,
): boolean {
  const request = probe.request;
  if (!(request && typeof request === "object" && !Array.isArray(request))) return false;
  const record = request as Record<string, unknown>;
  const encodedModel = probe.requestedModelId.match(
    /^desktop-local:(openai|openrouter|anthropic|ollama|lmstudio):(.+)$/u,
  );
  if (!(encodedModel?.[1] && encodedModel[2])) return false;
  let model: string;
  try {
    model = decodeURIComponent(encodedModel[2]);
  } catch {
    return false;
  }
  return Object.keys(record).length === 5 &&
    record.client === "web" &&
    record.runtimeId === probe.runtimeId &&
    record.environmentId === probe.environmentId &&
    record.modelProvider === encodedModel[1] &&
    record.model === model;
}

function parseResolvedProbe(
  value: unknown,
  expected: { runtimeId: "codex" | "claude"; environmentId: string },
): RuntimeDescriptorResolutionV1 {
  if (!(value && typeof value === "object" && !Array.isArray(value))) {
    throw descriptorProbeError("RUNTIME_DESCRIPTOR_FAILED");
  }
  const resolution = value as unknown as RuntimeDescriptorResolutionV1;
  if (
    resolution.version !== "runtime_descriptor_resolution_v1" ||
    resolution.environmentId !== expected.environmentId ||
    resolution.descriptor?.runtimeId !== expected.runtimeId
  ) {
    throw descriptorProbeError("RUNTIME_DESCRIPTOR_FAILED");
  }
  return resolution;
}

function sanitizeFailureCode(code: string): string {
  return FAILURE_CODES.has(code) ? code : "RUNTIME_DESCRIPTOR_FAILED";
}

function descriptorProbeError(code: string): Error & { code: string } {
  return Object.assign(new Error("The Desktop Runtime descriptor probe is unavailable."), { code });
}

function hashClaimToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
