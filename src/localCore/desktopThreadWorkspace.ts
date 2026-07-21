import path from "node:path";

import type { WorkspaceRuntimeContext } from "../../cli/contracts.js";
import type { ThreadRecord } from "../kestrel/contracts/orchestration.js";
import type { SessionStore } from "../kestrel/contracts/store.js";

export interface DesktopThreadWorkspaceRegistration {
  sessionId: string;
  threadId: string;
  workspace: WorkspaceRuntimeContext;
}

export async function syncDesktopThreadWorkspace(
  store: SessionStore,
  input: DesktopThreadWorkspaceRegistration,
): Promise<ThreadRecord> {
  const canonicalThreadId = `thread-main:${input.sessionId}`;
  if (input.threadId !== canonicalThreadId) {
    throw new Error(`Desktop threadId must be '${canonicalThreadId}'.`);
  }
  if (!path.isAbsolute(input.workspace.workspaceRoot)) {
    throw new Error("Desktop thread workspaceRoot must be absolute.");
  }

  await store.ensureSession(input.sessionId);
  const existing = await store.getThread(input.threadId);
  if (existing !== null && existing.sessionId !== input.sessionId) {
    throw new Error("Desktop thread belongs to a different session.");
  }
  const existingWorkspace = asRecord(existing?.metadata?.workspace);
  const existingRoot = readString(existingWorkspace?.workspaceRoot);
  if (existingRoot !== undefined && path.resolve(existingRoot) !== path.resolve(input.workspace.workspaceRoot)) {
    throw new Error("Desktop thread already has a different authoritative workspace.");
  }

  const now = new Date().toISOString();
  const thread: ThreadRecord = existing === null
    ? {
        threadId: input.threadId,
        sessionId: input.sessionId,
        title: input.sessionId,
        status: "IDLE",
        metadata: { mainThread: true, workspace: input.workspace },
        createdAt: now,
        updatedAt: now,
      }
    : {
        ...existing,
        metadata: {
          ...(existing.metadata ?? {}),
          mainThread: true,
          workspace: input.workspace,
        },
        updatedAt: now,
      };
  await store.upsertThread(thread);
  return thread;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
