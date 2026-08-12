import "server-only";

import { eq } from "drizzle-orm";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { assertRuntimeAdmissionReady } from "@/lib/runtimes/descriptor-service";
import { assertRuntimeReleased } from "@/lib/runtimes/release-gate";
import { getThreadForUser } from "@/lib/threads/store";
import {
  createDurableThreadTurn,
  DurableTurnError,
  getExistingDurableThreadTurnForAdmission,
  type DurableThreadTurnInput,
  type RuntimeAdmissionProof,
} from "@/lib/turns/store";

export async function resolveFreshForeignRuntimeAdmission(input: {
  organizationId: string;
  userId: string;
  runtimeId: "codex" | "claude";
  modelId?: string | undefined;
  projectId?: string | null | undefined;
}): Promise<RuntimeAdmissionProof> {
  assertRuntimeReleased(input.runtimeId);
  const resolution = await assertRuntimeAdmissionReady(input);
  return {
    runtimeId: input.runtimeId,
    environmentId: resolution.environmentId,
    capabilityDigest: resolution.capabilityDigest,
    selectedModelId: resolution.selectedModelId,
    observedAt: resolution.observedAt,
    readinessExpiresAt: resolution.readinessExpiresAt,
  };
}

export async function admitDurableThreadTurn(
  input: DurableThreadTurnInput & {
    requestedRuntimeId?: "kestrel" | "codex" | "claude" | undefined;
  },
) {
  const thread = await getThreadForUser(
    input.threadId,
    input.authorUserId,
    input.organizationId,
  );
  if (!thread) {
    throw new DurableTurnError("TURN_NOT_FOUND", "Thread not found.");
  }
  const requestedRuntimeId = input.requestedRuntimeId ?? "kestrel";
  const existing = await getExistingDurableThreadTurnForAdmission({
    threadId: input.threadId,
    organizationId: input.organizationId,
    authorUserId: input.authorUserId,
    idempotencyKey: input.idempotencyKey,
    requestedRuntimeId,
  });
  if (existing) return existing;
  assertRuntimeReleased(requestedRuntimeId);
  if (thread.runtimeId !== requestedRuntimeId) {
    throw new DurableTurnError(
      "RUNTIME_BINDING_IMMUTABLE",
      "The Runtime for an existing Thread cannot be changed.",
    );
  }
  const binding = thread.runtimeBindingId
    ? await knowledgeDb.query.runtimeBindings.findFirst({
        where: eq(schema.runtimeBindings.id, thread.runtimeBindingId),
      })
    : null;
  if (
    binding &&
    (binding.status === "degraded" ||
      binding.status === "released" ||
      binding.nativeSessionState === "degraded" ||
      binding.nativeSessionState === "released")
  ) {
    throw new DurableTurnError(
      "RUNTIME_BINDING_DEGRADED",
      "This Thread is read-only. Create the offered recovery fork to continue.",
    );
  }
  const requestedModelId = input.requestedModelId ?? binding?.selectedModelId ?? null;
  const runtimeAdmission = requestedRuntimeId !== "kestrel" &&
      (!binding || binding.nativeSessionState === "uninitialized")
    ? await resolveFreshForeignRuntimeAdmission({
        organizationId: input.organizationId,
        userId: input.authorUserId,
        runtimeId: requestedRuntimeId,
        modelId: requestedModelId ?? undefined,
        projectId: thread.projectId,
      })
    : undefined;
  return createDurableThreadTurn({
    ...input,
    requestedRuntimeId,
    requestedModelId,
    runtimeAdmission,
  });
}
