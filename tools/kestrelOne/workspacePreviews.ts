import { randomUUID } from "node:crypto";
import { createRuntimeFailure, RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type { SharedToolContext, SharedToolModule } from "../contracts.js";
import { parseObjectInput, readString } from "../helpers.js";
import { resolveKestrelOneAppRequest } from "./appTransport.js";

const PUBLIC_WARNING =
  "This is an anonymous bearer URL. Anyone with the URL can access the application until the preview closes or expires.";
const PREVIEW_PUBLICATION_LEASE_TTL_MS = 10 * 60_000;

function requireContextValue(value: string | undefined, label: string) {
  const normalized = value?.trim();
  if (!normalized) {
    throw createRuntimeFailure(
      "TOOL_CONTEXT_MISSING",
      `${label} is required.`,
      { subsystem: "tooling", classification: "policy", recoverable: false },
    );
  }
  return normalized;
}

const sharedCapability = {
  freshnessClass: "live" as const,
  latencyClass: "medium" as const,
  costClass: "metered" as const,
  allowedInteractionModes: ["build"] as Array<"build">,
  capabilityClasses: ["workspace.preview", "network.call"],
};

export const workspacePreviewPublishTool: SharedToolModule = {
  definition: {
    name: "workspace.preview.publish",
    description:
      "Publish an HTTP app that is already listening on a local Workspace port. Returns a short-lived anonymous public HTTPS URL that supports streaming and WebSockets. Start the app first with a shell or process tool. In the final response, copy the returned preview.url byte-for-byte; never infer, normalize, shorten, or replace its hostname.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "integer", minimum: 1024, maximum: 65_535 },
        sessionId: {
          type: "string",
          minLength: 1,
          description: "Exact sessionId returned by the exec_command call that started the listening application.",
        },
        ttlMinutes: { type: "integer", minimum: 1, maximum: 240 },
        name: { type: "string", minLength: 1, maxLength: 80 },
      },
      required: ["port", "sessionId"],
      additionalProperties: false,
    },
    capability: {
      ...sharedCapability,
      executionClass: "external_side_effect",
      approvalCapabilities: ["network.call"],
    },
    presentation: previewPresentation("Publish Workspace Preview"),
  },
  createHandler: (context) => async (input) => {
    const body = parseObjectInput("workspace.preview.publish", input);
    const sessionId = requiredSessionId(body);
    const provisionalLeaseId = `workspace-preview-publish:${randomUUID()}`;
    const provisionalExpiresAt = new Date(
      Date.now() + PREVIEW_PUBLICATION_LEASE_TTL_MS,
    ).toISOString();
    let preview: ({ id: string; expiresAt: string } & Record<string, unknown>) | undefined;
    let createdPreviewId: string | undefined;
    let promotionCompleted = false;
    try {
      await retainPreviewPublicationProcess(context, {
        processId: sessionId,
        leaseId: provisionalLeaseId,
        expiresAt: provisionalExpiresAt,
      });
      const payload = await requestPreview(context, "publish", ["previews"], {
        method: "POST",
        body: JSON.stringify({
          port: body.port,
          ...(body.ttlMinutes !== undefined ? { ttlMinutes: body.ttlMinutes } : {}),
          ...(body.name !== undefined ? { name: body.name } : {}),
        }),
      });
      createdPreviewId = previewIdFromPayload(payload);
      preview = requirePreview(payload);
      throwIfPreviewPublicationAborted(context.signal);
      await promotePreviewProcess(context, {
        processId: sessionId,
        fromLeaseId: provisionalLeaseId,
        previewId: preview.id,
        expiresAt: preview.expiresAt,
      });
      promotionCompleted = true;
      throwIfPreviewPublicationAborted(context.signal);
      return withPublicWarning(withPreview(payload, {
        ...preview,
        sessionId,
        retentionStatus: "active",
      }));
    } catch (error) {
      const cleanupFailures: Array<{ operation: string; message: string }> = [];
      if (createdPreviewId !== undefined) {
        await closePreview(context, createdPreviewId).catch((cleanupError) => {
          cleanupFailures.push({
            operation: "close_preview",
            message: errorMessage(cleanupError),
          });
        });
      }
      const retentionLeaseId = promotionCompleted && preview !== undefined
        ? previewLeaseId(preview.id)
        : provisionalLeaseId;
      await releasePreviewRetention(context, retentionLeaseId).catch((cleanupError) => {
        cleanupFailures.push({
          operation: promotionCompleted
            ? "release_preview_retention"
            : "release_provisional_retention",
          message: errorMessage(cleanupError),
        });
      });
      throw withCleanupEvidence(error, cleanupFailures);
    }
  },
};

export const workspacePreviewListTool: SharedToolModule = {
  definition: {
    name: "workspace.preview.list",
    description:
      "List public preview URL lease state separately from current application liveness and backing process retention. A valid URL can remain leased while its application is temporarily not listening.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    capability: {
      ...sharedCapability,
      latencyClass: "low",
      costClass: "free",
      executionClass: "read_only",
    },
    presentation: previewPresentation("List Workspace Previews"),
  },
  createHandler: (context) => async () => {
    const payload = await requestPreview(context, "list", ["previews"]);
    const record = asRecord(payload);
    const previews = Array.isArray(record?.previews) ? record.previews : [];
    const described = await Promise.all(previews.map(async (value) => {
      const preview = asRecord(value);
      const previewId = typeof preview?.id === "string" ? preview.id : undefined;
      if (previewId === undefined) return value;
      try {
        const retention = await inspectPreviewRetention(context, previewId);
        return {
          ...preview,
          ...(retention.processId !== undefined ? { sessionId: retention.processId } : {}),
          retentionStatus: retention.status === "active" ? "active" : "missing",
        };
      } catch {
        return { ...preview, retentionStatus: "unknown" };
      }
    }));
    return withPublicWarning({ ...(record ?? {}), previews: described });
  },
};

export const workspacePreviewInspectTool: SharedToolModule = {
  definition: {
    name: "workspace.preview.inspect",
    description:
      "Check whether an HTTP server is listening on a local Workspace port. Process listings are supporting evidence only; use this result or a direct HTTP response before claiming reachability. Report an exact exception name only when it was observed in tool output.",
    inputSchema: {
      type: "object",
      properties: {
        port: { type: "integer", minimum: 1024, maximum: 65_535 },
      },
      required: ["port"],
      additionalProperties: false,
    },
    capability: {
      ...sharedCapability,
      latencyClass: "low",
      costClass: "free",
      executionClass: "read_only",
    },
    presentation: previewPresentation("Inspect Workspace Preview Port"),
  },
  createHandler: (context) => async (input) => {
    const body = parseObjectInput("workspace.preview.inspect", input);
    return requestPreview(context, "inspect", ["ports", String(body.port)]);
  },
};

export const workspacePreviewRenewTool: SharedToolModule = {
  definition: {
    name: "workspace.preview.renew",
    description:
      "Extend an active Workspace preview without changing its public URL, up to four hours from initial publication.",
    inputSchema: {
      type: "object",
      properties: {
        previewId: { type: "string", minLength: 1 },
        ttlMinutes: { type: "integer", minimum: 1, maximum: 240 },
      },
      required: ["previewId", "ttlMinutes"],
      additionalProperties: false,
    },
    capability: {
      ...sharedCapability,
      executionClass: "external_side_effect",
      approvalCapabilities: ["network.call"],
    },
    presentation: previewPresentation("Renew Workspace Preview"),
  },
  createHandler: (context) => async (input) => {
    const body = parseObjectInput("workspace.preview.renew", input);
    const previewId = requiredPreviewId(body);
    const payload = await requestPreview(
        context,
        "renew",
        ["previews", previewId],
        { method: "POST", body: JSON.stringify({ ttlMinutes: body.ttlMinutes }) }
      );
    const preview = requirePreview(payload);
    const retention = await inspectPreviewRetention(context, previewId);
    if (retention.status !== "active" || retention.processId === undefined) {
      throw createRuntimeFailure(
        "WORKSPACE_PREVIEW_RETENTION_MISSING",
        "Workspace preview renewal could not confirm its backing process retention lease.",
        { subsystem: "tooling", previewId },
      );
    }
    await retainPreviewProcess(context, {
      processId: retention.processId,
      previewId,
      expiresAt: preview.expiresAt,
    });
    return withPublicWarning(withPreview(payload, {
      ...preview,
      sessionId: retention.processId,
      retentionStatus: "active",
    }));
  },
};

export const workspacePreviewCloseTool: SharedToolModule = {
  definition: {
    name: "workspace.preview.close",
    description:
      "Permanently close a Workspace public preview URL and release its process retention lease. The local application stops when no other process lease remains.",
    inputSchema: {
      type: "object",
      properties: { previewId: { type: "string", minLength: 1 } },
      required: ["previewId"],
      additionalProperties: false,
    },
    capability: {
      ...sharedCapability,
      latencyClass: "low",
      executionClass: "external_side_effect",
      approvalCapabilities: ["network.call"],
    },
    presentation: previewPresentation("Close Workspace Preview"),
  },
  createHandler: (context) => async (input) => {
    const previewId = requiredPreviewId(
      parseObjectInput("workspace.preview.close", input)
    );
    const payload = await requestPreview(
      context,
      "close",
      ["previews", previewId],
      { method: "DELETE" }
    );
    const release = requireRetentionService(context).releaseProcessRetention;
    if (release === undefined) throw retentionUnavailable();
    await release.call(context.devShellService, { leaseId: previewLeaseId(previewId) });
    return payload;
  },
};

export const workspacePreviewTools = [
  workspacePreviewPublishTool,
  workspacePreviewListTool,
  workspacePreviewInspectTool,
  workspacePreviewRenewTool,
  workspacePreviewCloseTool,
];

function previewPresentation(displayName: string) {
  return {
    displayName,
    aliases: ["public preview", "preview link"],
    keywords: ["workspace", "preview", "port", "tunnel", "edge"],
    provider: "kestrel-one",
    toolFamily: "workspace-preview",
  };
}

async function requestPreview(
  context: SharedToolContext,
  capability: "publish" | "list" | "inspect" | "renew" | "close",
  path: string[],
  init: RequestInit = {},
  forwardContextSignal = true,
) {
  const runtimeName = `workspace.preview.${capability}`;
  const approval =
    context.kestrelOne?.appApprovalModes?.[runtimeName] === "ask"
      ? `confirmed:${requireContextValue(context.runtime?.approvalId, "Runtime preview approval ID")}`
      : "auto";
  const pathname = `/api/runtime/apps/built_in.previews/${capability}/${encodeURIComponent(approval)}/${path
    .map(encodeURIComponent)
    .join("/")}`;
  const transport = resolveKestrelOneAppRequest(context, pathname);
  const response = await (context.fetchImpl ?? fetch)(transport.url, {
    ...init,
    ...(forwardContextSignal && init.signal === undefined && context.signal !== undefined
      ? { signal: context.signal }
      : {}),
    headers: {
      authorization: `Bearer ${transport.authorization}`,
      ...(init.body ? { "content-type": "application/json" } : {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = parseObjectInput("workspace preview error", payload);
    const nested =
      typeof error.error === "object" && error.error !== null
        ? (error.error as Record<string, unknown>)
        : {};
    throw new RuntimeFailure(
      typeof nested.code === "string"
        ? nested.code
        : "WORKSPACE_PREVIEW_REQUEST_FAILED",
      `Workspace preview request failed with HTTP ${response.status}.`,
      {
        subsystem: "tooling",
        status: response.status,
        classification: response.status >= 500 ? "runtime" : "policy",
        recoverable: response.status >= 409,
      }
    );
  }
  return payload;
}

function requiredPreviewId(input: Record<string, unknown>) {
  const previewId = readString(input, "previewId")?.trim();
  if (!previewId) {
    throw createRuntimeFailure(
      "TOOL_INPUT_SCHEMA_FAILED",
      "Workspace preview tool requires previewId.",
      { subsystem: "tooling" }
    );
  }
  return previewId;
}

function requiredSessionId(input: Record<string, unknown>) {
  const sessionId = readString(input, "sessionId")?.trim();
  if (!sessionId) {
    throw createRuntimeFailure(
      "TOOL_INPUT_SCHEMA_FAILED",
      "Workspace preview publication requires the exact exec_command sessionId.",
      { subsystem: "tooling" },
    );
  }
  return sessionId;
}

function requirePreview(payload: unknown): { id: string; expiresAt: string } & Record<string, unknown> {
  const preview = asRecord(asRecord(payload)?.preview);
  if (
    typeof preview?.id !== "string" || preview.id.length === 0 ||
    typeof preview.expiresAt !== "string" ||
    Number.isFinite(new Date(preview.expiresAt).getTime()) === false
  ) {
    throw createRuntimeFailure(
      "WORKSPACE_PREVIEW_RESPONSE_INVALID",
      "Workspace preview response did not include an id and authoritative expiry.",
      { subsystem: "tooling" },
    );
  }
  return preview as { id: string; expiresAt: string } & Record<string, unknown>;
}

function previewIdFromPayload(payload: unknown): string | undefined {
  const preview = asRecord(asRecord(payload)?.preview);
  return typeof preview?.id === "string" && preview.id.length > 0
    ? preview.id
    : undefined;
}

function withPreview(payload: unknown, preview: Record<string, unknown>) {
  return { ...(asRecord(payload) ?? {}), preview };
}

function previewLeaseId(previewId: string) {
  return `workspace-preview:${previewId}`;
}

async function retainPreviewProcess(
  context: SharedToolContext,
  input: { processId: string; previewId: string; expiresAt: string },
) {
  const retain = requireRetentionService(context).retainProcess;
  if (retain === undefined) throw retentionUnavailable();
  return retain.call(context.devShellService, {
    processId: input.processId,
    leaseId: previewLeaseId(input.previewId),
    kind: "workspace_preview",
    expiresAt: input.expiresAt,
  });
}

async function retainPreviewPublicationProcess(
  context: SharedToolContext,
  input: { processId: string; leaseId: string; expiresAt: string },
) {
  const retain = requireRetentionService(context).retainProcess;
  if (retain === undefined) throw retentionUnavailable();
  return retain.call(context.devShellService, {
    processId: input.processId,
    leaseId: input.leaseId,
    kind: "workspace_preview_provisional",
    expiresAt: input.expiresAt,
  });
}

async function promotePreviewProcess(
  context: SharedToolContext,
  input: { processId: string; fromLeaseId: string; previewId: string; expiresAt: string },
) {
  const promote = requireRetentionService(context).promoteProcessRetention;
  if (promote === undefined) throw retentionUnavailable();
  return promote.call(context.devShellService, {
    processId: input.processId,
    fromLeaseId: input.fromLeaseId,
    leaseId: previewLeaseId(input.previewId),
    kind: "workspace_preview",
    expiresAt: input.expiresAt,
  });
}

async function releasePreviewRetention(context: SharedToolContext, leaseId: string) {
  const release = requireRetentionService(context).releaseProcessRetention;
  if (release === undefined) throw retentionUnavailable();
  return release.call(context.devShellService, { leaseId });
}

async function inspectPreviewRetention(context: SharedToolContext, previewId: string) {
  const inspect = requireRetentionService(context).inspectProcessRetention;
  if (inspect === undefined) throw retentionUnavailable();
  return inspect.call(context.devShellService, { leaseId: previewLeaseId(previewId) });
}

function requireRetentionService(context: SharedToolContext) {
  if (context.devShellService === undefined) throw retentionUnavailable();
  return context.devShellService;
}

function retentionUnavailable() {
  return createRuntimeFailure(
    "WORKSPACE_PREVIEW_RETENTION_UNAVAILABLE",
    "Workspace preview process retention is unavailable.",
    { subsystem: "tooling" },
  );
}

async function closePreview(context: SharedToolContext, previewId: string) {
  await requestPreview(
    context,
    "close",
    ["previews", previewId],
    { method: "DELETE" },
    false,
  );
}

function withCleanupEvidence(
  error: unknown,
  cleanupFailures: Array<{ operation: string; message: string }>,
): unknown {
  if (cleanupFailures.length === 0) return error;
  if (error instanceof RuntimeFailure) {
    const combinedCleanupFailures = [
      ...readCleanupFailures(error.details),
      ...cleanupFailures,
    ];
    return new RuntimeFailure(error.code, error.message, {
      ...(error.details ?? {}),
      cleanupFailures: combinedCleanupFailures,
    });
  }
  const wrapped = new Error(errorMessage(error), { cause: error });
  const errorRecord = asRecord(error);
  const existingDetails = asRecord(errorRecord?.details);
  const combinedCleanupFailures = [
    ...readCleanupFailures(existingDetails),
    ...cleanupFailures,
  ];
  wrapped.name = error instanceof Error ? error.name : wrapped.name;
  Object.assign(wrapped, {
    ...(typeof errorRecord?.code === "string" ? { code: errorRecord.code } : {}),
    details: {
      ...(existingDetails ?? {}),
      cleanupFailures: combinedCleanupFailures,
    },
    cleanupFailures: combinedCleanupFailures,
  });
  return wrapped;
}

function readCleanupFailures(
  details: Record<string, unknown> | undefined,
): Array<{ operation: string; message: string }> {
  if (!Array.isArray(details?.cleanupFailures)) return [];
  return details.cleanupFailures.flatMap((value) => {
    const record = asRecord(value);
    return typeof record?.operation === "string" && typeof record.message === "string"
      ? [{ operation: record.operation, message: record.message }]
      : [];
  });
}

function throwIfPreviewPublicationAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : createRuntimeFailure(
        "RUN_CANCELLED",
        "Workspace preview publication was cancelled.",
        { subsystem: "tooling" },
      );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function withPublicWarning(payload: unknown) {
  return {
    ...(typeof payload === "object" && payload !== null ? payload : {}),
    warning: PUBLIC_WARNING,
  };
}
