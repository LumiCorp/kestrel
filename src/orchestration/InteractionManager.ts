import { randomUUID } from "node:crypto";

import type { ToolExecutionClass } from "../mode/contracts.js";
import {
  interactionRequestNotFoundFailure,
  interactionRequestNotPendingFailure,
  interactionRequestThreadMismatchFailure,
} from "../runtime/RuntimeFailure.js";
import type {
  ApprovalGrantRecord,
  InteractionRequestRecord,
  OrchestrationStore,
  ReplyToRequestInput,
} from "./contracts.js";

export class InteractionManager {
  private readonly store: OrchestrationStore;

  constructor(store: OrchestrationStore) {
    this.store = store;
  }

  async syncWaitState(input: {
    threadId: string;
    runId?: string | undefined;
    delegationId?: string | undefined;
    waitFor?: {
      kind?: string | undefined;
      eventType?: string | undefined;
      metadata?: Record<string, unknown> | undefined;
      interaction?: {
        requestId?: string | undefined;
        kind?: string | undefined;
        eventType?: string | undefined;
        prompt?: string | undefined;
      } | undefined;
    } | undefined;
  }): Promise<InteractionRequestRecord | undefined> {
    const pending = await this.store.listInteractionRequests({
      threadId: input.threadId,
      status: "PENDING",
    });
    const waitFor = input.waitFor;
    if (waitFor === undefined || typeof waitFor.eventType !== "string") {
      await this.cancelPendingRequests(pending);
      return undefined;
    }
    if (waitFor.kind !== "approval" && waitFor.kind !== "user") {
      await this.cancelPendingRequests(pending);
      return undefined;
    }

    const eventType = waitFor.eventType;
    const requestKind = waitFor.kind === "approval" ? "approval" : "user_input";
    const existing = pending.find((request) =>
      requestMatchesWaitFor(request, {
        kind: requestKind,
        eventType,
        metadata: waitFor.metadata ?? {},
        interaction: waitFor.interaction,
      })
    );
    await this.cancelPendingRequests(pending.filter((request) => request.requestId !== existing?.requestId));
    if (existing !== undefined) {
      return existing;
    }

    const metadata = waitFor.metadata ?? {};
    const interaction = waitFor.interaction;
    const request: InteractionRequestRecord = {
      requestId:
        typeof interaction?.requestId === "string" && interaction.requestId.length > 0
          ? interaction.requestId
          : typeof metadata.requestId === "string" && metadata.requestId.length > 0
            ? metadata.requestId
          : `request-${randomUUID()}`,
      threadId: input.threadId,
      ...(input.runId !== undefined ? { runId: input.runId } : {}),
      kind: requestKind,
      status: "PENDING",
      eventType,
      ...(input.delegationId !== undefined ? { delegationId: input.delegationId } : {}),
      waitKind: waitFor.kind,
      ...(typeof interaction?.prompt === "string"
        ? { prompt: interaction.prompt }
        : typeof metadata.prompt === "string"
          ? { prompt: metadata.prompt }
          : {}),
      metadata,
      createdAt: new Date().toISOString(),
    };
    await this.store.upsertInteractionRequest(request);
    return request;
  }

  private async cancelPendingRequests(requests: InteractionRequestRecord[]): Promise<void> {
    if (requests.length === 0) {
      return;
    }
    const resolvedAt = new Date().toISOString();
    await Promise.all(
      requests.map((request) =>
        this.store.upsertInteractionRequest({
          ...request,
          status: "CANCELLED",
          resolvedAt,
        }),
      ),
    );
  }

  async resolveRequest(input: ReplyToRequestInput): Promise<{
    request: InteractionRequestRecord;
    grant?: ApprovalGrantRecord | undefined;
  }> {
    const request = await this.store.getInteractionRequest(input.requestId);
    if (request === null) {
      throw interactionRequestNotFoundFailure(input.requestId);
    }
    if (request.threadId !== input.threadId) {
      throw interactionRequestThreadMismatchFailure({
        requestId: input.requestId,
        expectedThreadId: input.threadId,
        actualThreadId: request.threadId,
      });
    }
    if (request.status !== "PENDING") {
      throw interactionRequestNotPendingFailure({
        requestId: input.requestId,
        status: request.status,
      });
    }

    const resolvedRequest: InteractionRequestRecord = {
      ...request,
      status: "RESOLVED",
      response: {
        message: input.message,
        approve: input.approve !== false,
        ...(input.issuedBy !== undefined ? { issuedBy: input.issuedBy } : {}),
        ...(input.attachments !== undefined ? { attachments: input.attachments } : {}),
      },
      resolvedAt: new Date().toISOString(),
    };
    await this.store.upsertInteractionRequest(resolvedRequest);

    if (
      request.kind !== "approval" ||
      input.approve === false ||
      request.eventType === "runtime.assembly_change"
    ) {
      return { request: resolvedRequest };
    }

    const grant: ApprovalGrantRecord = {
      grantId: `grant-${randomUUID()}`,
      threadId: input.threadId,
      requestId: request.requestId,
      ...(request.delegationId !== undefined ? { delegationId: request.delegationId } : {}),
      scope: request.delegationId !== undefined ? "delegation_turn" : "turn",
      status: "ACTIVE",
      allowedToolClasses: normalizeToolClasses(input.allowedToolClasses),
      allowedCapabilities: normalizeCapabilities(input.allowedCapabilities),
      issuedBy: input.issuedBy ?? "operator",
      issuedAt: new Date().toISOString(),
      metadata: {
        sourceRequestId: request.requestId,
      },
    };
    await this.store.upsertApprovalGrant(grant);
    return {
      request: resolvedRequest,
      grant,
    };
  }

  async expireTurnScopedGrants(threadId: string): Promise<void> {
    const grants = await this.store.listApprovalGrants({
      threadId,
      status: "ACTIVE",
    });
    for (const grant of grants) {
      await this.store.upsertApprovalGrant({
        ...grant,
        status: "EXPIRED",
        expiresAt: new Date().toISOString(),
      });
    }
  }
}

function normalizeToolClasses(
  value: ToolExecutionClass[] | undefined,
): ToolExecutionClass[] {
  return value === undefined ? [] : [...new Set(value)];
}

function normalizeCapabilities(value: string[] | undefined): string[] {
  return value === undefined ? [] : [...new Set(value)];
}

function requestMatchesWaitFor(
  request: InteractionRequestRecord,
  waitFor: {
    kind: InteractionRequestRecord["kind"];
    eventType: string;
    metadata: Record<string, unknown>;
    interaction?: {
      requestId?: string | undefined;
      prompt?: string | undefined;
    } | undefined;
  },
): boolean {
  if (request.eventType !== waitFor.eventType || request.kind !== waitFor.kind) {
    return false;
  }

  const requestId =
    readNonEmptyString(waitFor.interaction?.requestId) ??
    readNonEmptyString(waitFor.metadata.requestId);
  if (requestId !== undefined) {
    return request.requestId === requestId;
  }

  const requestMetadata = request.metadata ?? {};
  const blockedActionId = readNonEmptyString(waitFor.metadata.blockedActionId);
  const requestBlockedActionId = readNonEmptyString(requestMetadata.blockedActionId);
  if (blockedActionId !== undefined || requestBlockedActionId !== undefined) {
    return blockedActionId !== undefined && blockedActionId === requestBlockedActionId;
  }

  const prompt =
    readNonEmptyString(waitFor.interaction?.prompt) ??
    readNonEmptyString(waitFor.metadata.prompt);
  const requestPrompt = request.prompt ?? readNonEmptyString(requestMetadata.prompt);
  const reason = readNonEmptyString(waitFor.metadata.reason);
  const requestReason = readNonEmptyString(requestMetadata.reason);
  if (
    prompt !== undefined ||
    requestPrompt !== undefined ||
    reason !== undefined ||
    requestReason !== undefined
  ) {
    return prompt === requestPrompt && reason === requestReason;
  }

  return true;
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
