import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { NormalizedOutput } from "../kestrel/contracts/execution.js";
import type { SessionRecord } from "../kestrel/contracts/store.js";
import {
  buildManagedScratchpadFromRuntime,
  parseManagedScratchpad,
  serializeManagedScratchpad,
  WORKSPACE_SCRATCHPAD_RELATIVE_PATH,
  type ManagedScratchpad,
} from "./workspaceScratchpad.js";
import { resolveKestrelHomePath } from "./kestrelHome.js";

export async function syncRuntimeWorkspaceScratchpad(input: {
  workspace: unknown;
  session?: SessionRecord | undefined;
  output: NormalizedOutput;
  operatorAffordance?: unknown;
}): Promise<boolean> {
  const workspace = readWorkspaceScratchpadTarget(input.workspace);
  if (workspace === undefined) {
    return false;
  }

  const scratchpadPath =
    workspace.scratchpadPath ??
    buildRuntimeWorkspaceScratchpadPath(workspace);
  const generated = buildManagedScratchpadFromRuntime({
    session: input.session,
    output: input.output,
    operatorAffordance: readOperatorAffordance(input.operatorAffordance),
  });
  const existingRaw = await readOptionalTextFile(scratchpadPath);
  const existing = existingRaw !== undefined ? parseManagedScratchpad(existingRaw) : undefined;
  const merged = mergeScratchpads(existing, generated);
  const nextRaw = serializeManagedScratchpad(merged);
  if (existingRaw === nextRaw) {
    return false;
  }

  await mkdir(path.dirname(scratchpadPath), { recursive: true });
  await writeFile(scratchpadPath, nextRaw, "utf8");
  return true;
}

function readWorkspaceScratchpadTarget(value: unknown): {
  workspaceId: string;
  workspaceRoot: string;
  scratchpadPath?: string | undefined;
} | undefined {
  const record = asRecord(value);
  const workspaceRoot = asString(record?.workspaceRoot);
  const workspaceId = asString(record?.workspaceId);
  if (workspaceRoot === undefined || workspaceId === undefined) {
    return undefined;
  }
  const scratchpadPath = asString(record?.scratchpadPath);
  return {
    workspaceId,
    workspaceRoot,
    ...(scratchpadPath !== undefined ? { scratchpadPath } : {}),
  };
}

function buildRuntimeWorkspaceScratchpadPath(workspace: {
  workspaceId: string;
}): string {
  return path.join(
    resolveKestrelHomePath(),
    WORKSPACE_SCRATCHPAD_RELATIVE_PATH,
    sanitizePathSegment(workspace.workspaceId),
    "memory",
    "current.md",
  );
}

function sanitizePathSegment(value: string): string {
  const normalized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/gu, "_")
    .replace(/^[._-]+/u, "")
    .replace(/_+/gu, "_")
    .slice(0, 96);
  return normalized.length > 0 && normalized !== "." && normalized !== ".."
    ? normalized
    : "workspace";
}

function readOperatorAffordance(value: unknown): {
  recommendedAction?: { summary: string } | undefined;
} | undefined {
  const record = asRecord(value);
  const recommendedAction = asRecord(record?.recommendedAction);
  const summary = asString(recommendedAction?.summary);
  if (summary === undefined) {
    return undefined;
  }
  return {
    recommendedAction: {
      summary,
    },
  };
}

function mergeScratchpads(
  existing: ManagedScratchpad | undefined,
  generated: ManagedScratchpad,
): ManagedScratchpad {
  return {
    ...(generated.goal !== undefined
      ? { goal: generated.goal }
      : existing?.goal !== undefined
        ? { goal: existing.goal }
        : {}),
    currentPlan:
      generated.currentPlan.length > 0 ? generated.currentPlan : (existing?.currentPlan ?? []),
    facts: mergeScratchpadItems(generated.facts, existing?.facts),
    openIssues: generated.openIssues,
    nextActions:
      generated.nextActions.length > 0 ? generated.nextActions : (existing?.nextActions ?? []),
    recentDecisions: mergeScratchpadItems(generated.recentDecisions, existing?.recentDecisions),
  };
}

function mergeScratchpadItems(
  primary: string[],
  secondary: string[] | undefined,
): string[] {
  return [...primary, ...(secondary ?? [])];
}

async function readOptionalTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
