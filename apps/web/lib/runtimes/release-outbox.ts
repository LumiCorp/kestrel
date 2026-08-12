import "server-only";

import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  lt,
  ne,
  or,
} from "drizzle-orm";
import {
  ENVIRONMENT_ROUTER_AUDIENCE,
  signEnvironmentExecutionTicket,
} from "@lumi/kestrel-environment-auth";
import { KestrelClient } from "@kestrel-agents/sdk/runner";
import type {
  RunnerEventEnvelope,
  RunnerProfile,
  RuntimeReleaseCommandPayload,
} from "@kestrel-agents/protocol";
import { knowledgeDb, schema } from "@/lib/knowledge/db";
import { getHostedEnvironmentRuntimeMode } from "@/lib/environments/config";

export type RuntimeReleaseDelivery = (
  input: RuntimeReleaseCommandPayload & {
    organizationId: string;
    outboxId: string;
    workspaceId: string;
    actorUserId: string;
  },
) => Promise<RunnerEventEnvelope<"runtime.released">>;

/**
 * Delivers a bounded batch of durable native-binding cleanup jobs. Failed
 * attempts remain retryable; the command's binding-scoped identity makes a
 * duplicate native acknowledgement harmless.
 */
export async function processRuntimeBindingReleaseOutbox(
  deliver: RuntimeReleaseDelivery,
  limit = 25,
): Promise<{ processed: number; released: number; failed: number }> {
  const staleDeliveryBefore = new Date(Date.now() - 5 * 60_000);
  const retryableState = or(
    inArray(schema.runtimeBindingReleaseOutbox.state, ["pending", "failed"]),
    and(
      eq(schema.runtimeBindingReleaseOutbox.state, "delivering"),
      lt(schema.runtimeBindingReleaseOutbox.updatedAt, staleDeliveryBefore),
    ),
  );
  const candidates = await knowledgeDb
    .select(getTableColumns(schema.runtimeBindingReleaseOutbox))
    .from(schema.runtimeBindingReleaseOutbox)
    .innerJoin(
      schema.environments,
      and(
        eq(
          schema.environments.id,
          schema.runtimeBindingReleaseOutbox.environmentId,
        ),
        ne(schema.environments.provider, "desktop"),
      ),
    )
    .where(retryableState)
    .orderBy(asc(schema.runtimeBindingReleaseOutbox.createdAt))
    .limit(limit);
  let released = 0;
  let failed = 0;
  for (const candidate of candidates) {
    const [claimed] = await knowledgeDb
      .update(schema.runtimeBindingReleaseOutbox)
      .set({
        state: "delivering",
        attempts: candidate.attempts + 1,
        failureCode: null,
        failureMessage: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.runtimeBindingReleaseOutbox.id, candidate.id),
          retryableState,
        ),
      )
      .returning();
    if (!claimed) continue;
    try {
      const acknowledgement = await deliver({
        outboxId: claimed.id,
        organizationId: claimed.organizationId,
        runtimeId: claimed.runtimeId,
        bindingId: claimed.bindingId,
        participantId: claimed.participantId,
        threadId: claimed.threadId,
        environmentId: claimed.environmentId,
        workspaceId: claimed.workspaceId,
        actorUserId: claimed.actorUserId,
      });
      assertRuntimeReleaseAcknowledgement(claimed, acknowledgement);
      await knowledgeDb
        .update(schema.runtimeBindingReleaseOutbox)
        .set({
          state: "released",
          acknowledgementEventId: acknowledgement.id,
          acknowledgedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.runtimeBindingReleaseOutbox.id, claimed.id));
      released += 1;
    } catch (error) {
      await knowledgeDb
        .update(schema.runtimeBindingReleaseOutbox)
        .set({
          state: "failed",
          failureCode: sanitizedFailureCode(error),
          failureMessage: "Runtime binding release will be retried.",
          updatedAt: new Date(),
        })
        .where(eq(schema.runtimeBindingReleaseOutbox.id, claimed.id));
      failed += 1;
    }
  }
  return { processed: released + failed, released, failed };
}

/**
 * Delivers one cleanup command without recreating the deleted product Thread
 * or obtaining a provider credential. The short-lived environment ticket is
 * restricted to Runtime release.
 */
export async function deliverRuntimeBindingRelease(
  input: RuntimeReleaseCommandPayload & {
    organizationId: string;
    outboxId: string;
    workspaceId: string;
    actorUserId: string;
  },
): Promise<RunnerEventEnvelope<"runtime.released">> {
  const route = await resolveRuntimeBindingReleaseRoute(input);
  const profile: RunnerProfile = {
    id: `runtime-release-${input.runtimeId}`,
    label: `Runtime release (${input.runtimeId})`,
    agent: "kestrel",
    sessionPrefix: "runtime-release",
    defaultInteractionMode: "build",
    runtimeId: input.runtimeId,
  };
  const client = new KestrelClient({
    target: {
      kind: "remote",
      baseUrl: route.baseUrl,
      authToken: route.authToken,
    },
  });
  try {
    return await client.releaseRuntime(
      {
        runtimeId: input.runtimeId,
        bindingId: input.bindingId,
        participantId: input.participantId,
        threadId: input.threadId,
        environmentId: input.environmentId,
      },
      {
        tenantId: input.organizationId,
        profile,
        actor: {
          actorId: input.actorUserId,
          actorType: "operator",
          tenantId: input.organizationId,
          orgRole: "org_admin",
        },
      },
    );
  } finally {
    await client.close();
  }
}

function assertRuntimeReleaseAcknowledgement(
  release: RuntimeReleaseCommandPayload & { outboxId?: string; id?: string },
  event: RunnerEventEnvelope<"runtime.released">,
): void {
  if (
    event.type !== "runtime.released" ||
    event.commandId !== (release.outboxId ?? release.id) ||
    event.payload.runtimeId !== release.runtimeId ||
    event.payload.bindingId !== release.bindingId ||
    event.payload.participantId !== release.participantId ||
    event.payload.threadId !== release.threadId ||
    event.payload.environmentId !== release.environmentId
  ) {
    throw Object.assign(new Error("Runtime release acknowledgement did not match its outbox command."), {
      code: "RUNTIME_RELEASE_ACK_INVALID",
    });
  }
}

async function resolveRuntimeBindingReleaseRoute(input: {
  organizationId: string;
  environmentId: string;
  workspaceId: string;
  threadId: string;
  actorUserId: string;
  outboxId: string;
}) {
  if (getHostedEnvironmentRuntimeMode() === "local") {
    return {
      baseUrl: process.env.KESTREL_LOCAL_ENVIRONMENT_RUNNER_URL ?? "",
      authToken: process.env.KESTREL_LOCAL_ENVIRONMENT_RUNNER_TOKEN ?? "",
    };
  }
  const [route] = await knowledgeDb
    .select({
      provider: schema.environments.provider,
      routerUrl: schema.environments.routerUrl,
      flyAppName: schema.environments.flyAppName,
      flyMachineId: schema.environmentWorkspaces.flyMachineId,
    })
    .from(schema.environments)
    .innerJoin(
      schema.environmentWorkspaces,
      eq(schema.environmentWorkspaces.environmentId, schema.environments.id),
    )
    .where(
      and(
        eq(schema.environments.id, input.environmentId),
        eq(schema.environments.organizationId, input.organizationId),
        eq(schema.environmentWorkspaces.id, input.workspaceId),
      ),
    )
    .limit(1);
  if (route?.provider === "desktop") {
    throw Object.assign(
      new Error("Desktop Runtime release is waiting for its environment route."),
      { code: "RUNTIME_RELEASE_ROUTE_UNAVAILABLE" },
    );
  }
  if (!(route?.routerUrl && route.flyAppName && route.flyMachineId)) {
    throw Object.assign(new Error("Runtime release Environment is unavailable."), {
      code: "RUNTIME_RELEASE_ROUTE_UNAVAILABLE",
    });
  }
  const now = Math.floor(Date.now() / 1000);
  return {
    baseUrl: route.routerUrl,
    authToken: signEnvironmentExecutionTicket({
      privateKey: process.env.KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY ?? "",
      ticket: {
        version: 2,
        audience: ENVIRONMENT_ROUTER_AUDIENCE,
        organizationId: input.organizationId,
        environmentId: input.environmentId,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        runId: input.outboxId,
        actorId: input.actorUserId,
        agentId: "kestrel-one-runtime-release-worker",
        target: {
          provider: "fly",
          appName: route.flyAppName,
          machineId: route.flyMachineId,
        },
        capabilities: ["runtime.release"],
        issuedAt: now,
        expiresAt: now + 300,
        nonce: crypto.randomUUID(),
      },
    }),
  };
}

function sanitizedFailureCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error &&
      typeof error.code === "string" && /^[A-Z0-9_]{1,80}$/u.test(error.code)
    ? error.code
    : "RUNTIME_RELEASE_DELIVERY_FAILED";
}
