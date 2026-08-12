import { createRuntimeFailure, RuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type { SharedToolContext, SharedToolModule } from "../contracts.js";
import { parseObjectInput, readString } from "../helpers.js";
import { resolveKestrelOneAppRequest } from "./appTransport.js";

const PUBLIC_WARNING =
  "This is an anonymous bearer URL. Anyone with the URL can access the application until the preview closes or expires.";

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
        ttlMinutes: { type: "integer", minimum: 1, maximum: 240 },
        name: { type: "string", minLength: 1, maxLength: 80 },
      },
      required: ["port"],
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
    return withPublicWarning(
      await requestPreview(context, "publish", ["previews"], {
        method: "POST",
        body: JSON.stringify(body),
      })
    );
  },
};

export const workspacePreviewListTool: SharedToolModule = {
  definition: {
    name: "workspace.preview.list",
    description:
      "List active public preview URLs for local HTTP ports in this Workspace, including availability and expiration.",
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
  createHandler: (context) => async () =>
    withPublicWarning(await requestPreview(context, "list", ["previews"])),
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
    return withPublicWarning(
      await requestPreview(
        context,
        "renew",
        ["previews", previewId],
        { method: "POST", body: JSON.stringify({ ttlMinutes: body.ttlMinutes }) }
      )
    );
  },
};

export const workspacePreviewCloseTool: SharedToolModule = {
  definition: {
    name: "workspace.preview.close",
    description:
      "Permanently close a Workspace public preview URL without stopping the local application.",
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
    return requestPreview(
      context,
      "close",
      ["previews", previewId],
      { method: "DELETE" }
    );
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
  init: RequestInit = {}
) {
  const runtimeName = `workspace.preview.${capability}`;
  const approval =
    context.kestrelOne?.appApprovalModes?.[runtimeName] === "ask"
      ? "confirmed"
      : "auto";
  const pathname = `/api/runtime/apps/built_in.previews/${capability}/${approval}/${path
    .map(encodeURIComponent)
    .join("/")}`;
  const transport = resolveKestrelOneAppRequest(context, pathname);
  const response = await (context.fetchImpl ?? fetch)(transport.url, {
    ...init,
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

function withPublicWarning(payload: unknown) {
  return {
    ...(typeof payload === "object" && payload !== null ? payload : {}),
    warning: PUBLIC_WARNING,
  };
}
