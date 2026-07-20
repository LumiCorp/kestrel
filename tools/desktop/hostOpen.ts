import path from "node:path";
import { realpath } from "node:fs/promises";

import type { ModelToolContract } from "../../src/kestrel/contracts/model-io.js";
import { createRuntimeFailure } from "../../src/runtime/RuntimeFailure.js";
import type { SharedToolContext, SharedToolModule } from "../contracts.js";
import { parseObjectInput, readString } from "../helpers.js";

const TOOL_NAME = "desktop.host.open";

const OUTPUT_CONTRACT: ModelToolContract = {
  type: "object",
  required: ["status", "kind"],
  fields: {
    status: { type: "string", enum: ["opened"] },
    kind: { type: "string", enum: ["application", "workspace_path", "url"] },
    application: { type: "string" },
    target: { type: "string" },
  },
};

export const desktopHostOpenTool: SharedToolModule = {
  definition: {
    name: TOOL_NAME,
    description:
      "Open an installed macOS application, a file within the active Desktop workspace, or an HTTP(S) URL only when the user explicitly requested that host action. This is the Desktop host-opening tool; do not use exec_command for app launching.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { type: "string", enum: ["application", "workspace_path", "url"] },
        application: { type: "string", minLength: 1, maxLength: 200 },
        path: { type: "string", minLength: 1 },
        url: { type: "string", minLength: 1, maxLength: 4096 },
      },
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "application"],
          properties: {
            kind: { type: "string", enum: ["application"] },
            application: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "path"],
          properties: {
            kind: { type: "string", enum: ["workspace_path"] },
            path: {
              type: "string",
              minLength: 1,
              description: "Workspace-relative path to an existing file or directory.",
            },
            application: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "url"],
          properties: {
            kind: { type: "string", enum: ["url"] },
            url: { type: "string", minLength: 1, maxLength: 4096 },
            application: { type: "string", minLength: 1, maxLength: 200 },
          },
        },
      ],
    },
    outputContract: OUTPUT_CONTRACT,
    capability: {
      freshnessClass: "volatile",
      latencyClass: "low",
      costClass: "free",
      executionClass: "external_side_effect",
      allowedInteractionModes: ["chat", "build"],
      capabilityClasses: ["desktop.host.open"],
    },
    presentation: {
      displayName: "Open on Desktop",
      aliases: ["open app", "open file", "open URL", "launch app"],
      keywords: ["desktop", "open", "launch", "application", "browser", "file", "URL"],
      provider: "kestrel",
      toolFamily: "desktop-host",
    },
  },
  createHandler(context) {
    return async (input: unknown) => {
      const service = requireHostOpenService(context);
      const body = parseObjectInput(TOOL_NAME, input);
      const kind = readString(body, "kind")?.trim();
      const application = normalizeApplication(readString(body, "application"));

      if (kind === "application") {
        if (application === undefined) {
          throw invalidInput("application is required for kind 'application'.", "application");
        }
        await service.open({ kind, application });
        return { status: "opened", kind, application };
      }

      if (kind === "workspace_path") {
        const requestedPath = readString(body, "path")?.trim();
        if (requestedPath === undefined || requestedPath.length === 0) {
          throw invalidInput("path is required for kind 'workspace_path'.", "path");
        }
        const targetPath = await resolveWorkspaceTarget(context, requestedPath);
        await service.open({
          kind,
          targetPath,
          ...(application !== undefined ? { application } : {}),
        });
        return {
          status: "opened",
          kind,
          target: requestedPath,
          ...(application !== undefined ? { application } : {}),
        };
      }

      if (kind === "url") {
        const url = normalizeHttpUrl(readString(body, "url"));
        await service.open({
          kind,
          url,
          ...(application !== undefined ? { application } : {}),
        });
        return {
          status: "opened",
          kind,
          target: url,
          ...(application !== undefined ? { application } : {}),
        };
      }

      throw invalidInput("kind must be 'application', 'workspace_path', or 'url'.", "kind");
    };
  },
};

function requireHostOpenService(context: SharedToolContext) {
  if (context.desktopHostOpenService === undefined) {
    throw createRuntimeFailure(
      "DESKTOP_HOST_OPEN_UNAVAILABLE",
      "Desktop host opening is unavailable for this runtime profile.",
      {
        subsystem: "desktop_host",
        toolName: TOOL_NAME,
        classification: "configuration",
        recoverable: false,
      },
    );
  }
  return context.desktopHostOpenService;
}

function normalizeApplication(value: string | undefined): string | undefined {
  const application = value?.trim();
  if (application === undefined) return;
  if (
    application.length === 0 ||
    application.length > 200 ||
    application.includes("/") ||
    /[\u0000-\u001f\u007f]/u.test(application)
  ) {
    throw invalidInput("application must be an installed application name, not a path.", "application");
  }
  return application;
}

function normalizeHttpUrl(value: string | undefined): string {
  if (value === undefined) {
    throw invalidInput("url is required for kind 'url'.", "url");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidInput("url must be an absolute HTTP(S) URL.", "url");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw invalidInput("url must use HTTP or HTTPS.", "url");
  }
  return parsed.toString();
}

async function resolveWorkspaceTarget(
  context: SharedToolContext,
  requestedPath: string,
): Promise<string> {
  if (path.isAbsolute(requestedPath)) {
    throw invalidInput("path must be relative to the active workspace.", "path");
  }
  const workspaceRoot = path.resolve(context.fileSystem?.workspaceRoot ?? ".");
  const requestedTarget = path.resolve(workspaceRoot, requestedPath);
  if (isWithinRoot(workspaceRoot, requestedTarget) === false) {
    throw invalidInput("path must not escape the active workspace.", "path");
  }
  try {
    const [realRoot, realTarget] = await Promise.all([
      realpath(workspaceRoot),
      realpath(requestedTarget),
    ]);
    if (isWithinRoot(realRoot, realTarget) === false) {
      throw invalidInput("path resolves outside the active workspace.", "path");
    }
    return realTarget;
  } catch (error) {
    if (isToolInputFailure(error)) throw error;
    throw invalidInput("path must identify an existing workspace file or directory.", "path");
  }
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && relative.startsWith(`..${path.sep}`) === false && path.isAbsolute(relative) === false);
}

function invalidInput(message: string, field: string) {
  return createRuntimeFailure(
    "TOOL_INPUT_INVALID",
    `${TOOL_NAME}: ${message}`,
    {
      subsystem: "tooling",
      toolName: TOOL_NAME,
      field,
      classification: "validation",
      recoverable: true,
    },
  );
}

function isToolInputFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "TOOL_INPUT_INVALID";
}
