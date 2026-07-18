import { renderWorkspaceRelativeTarget } from "./workspaceCoordinates.js";

export type WorkspaceFreshnessStatus =
  | "not_applicable"
  | "stale"
  | "fresh"
  | "attempted_unresolved";

export interface WorkspaceFreshnessEvidenceRef {
  evidenceId: string;
  stepIndex?: number | undefined;
  toolName?: string | undefined;
  processId?: string | undefined;
  command?: string | undefined;
  cwd?: string | undefined;
  status?: string | undefined;
  changedFiles?: string[] | undefined;
  summary: string;
}

export interface WorkspaceFreshnessSummary {
  status: WorkspaceFreshnessStatus;
  latestMutation?: WorkspaceFreshnessEvidenceRef | undefined;
  laterEvidence?: WorkspaceFreshnessEvidenceRef[] | undefined;
  unresolvedEvidence?: WorkspaceFreshnessEvidenceRef[] | undefined;
}

export function deriveWorkspaceFreshness(value: unknown): WorkspaceFreshnessSummary {
  const ledger = readLedger(value);
  const latestMutationIndex = findLatestMutationIndex(ledger);
  if (latestMutationIndex < 0) {
    return { status: "not_applicable" };
  }
  const latestMutation = ledger[latestMutationIndex]!;
  const mutationRef = toEvidenceRef(latestMutation);
  if (latestMutation.stepIndex === undefined) {
    return { status: "stale", latestMutation: mutationRef };
  }
  const mutationProcessId = readProcessId(latestMutation);
  const tokenState = new Map<string, { status: "supports" | "blocks"; entry: LedgerEntry }>();
  for (const entry of ledger.slice(latestMutationIndex + 1)) {
    if (entry.stepIndex === undefined || entry.stepIndex <= latestMutation.stepIndex) {
      continue;
    }
    if (mutationProcessId !== undefined && readProcessId(entry) === mutationProcessId) {
      continue;
    }
    const tokens = readQualifyingTokens(entry);
    if (tokens.length === 0) {
      continue;
    }
    if (entry.status === "passed") {
      for (const token of tokens) {
        tokenState.set(token, { status: "supports", entry });
      }
      continue;
    }
    if (entry.status === "failed" || entry.status === "blocked" || entry.status === "inconclusive") {
      for (const token of tokens) {
        tokenState.set(token, { status: "blocks", entry });
      }
    }
  }
  const supportEntries = uniqueEntries(
    [...tokenState.values()].filter((item) => item.status === "supports").map((item) => item.entry),
  );
  const blockerEntries = uniqueEntries(
    [...tokenState.values()].filter((item) => item.status === "blocks").map((item) => item.entry),
  );
  if (blockerEntries.length > 0) {
    return {
      status: "attempted_unresolved",
      latestMutation: mutationRef,
      ...(supportEntries.length > 0 ? { laterEvidence: supportEntries.map(toEvidenceRef) } : {}),
      unresolvedEvidence: blockerEntries.map(toEvidenceRef),
    };
  }
  if (supportEntries.length > 0) {
    return {
      status: "fresh",
      latestMutation: mutationRef,
      laterEvidence: supportEntries.map(toEvidenceRef),
    };
  }
  return { status: "stale", latestMutation: mutationRef };
}

export function deriveActiveExecCommandSessions(value: unknown): WorkspaceFreshnessEvidenceRef[] {
  const latestByProcess = new Map<string, LedgerEntry>();
  for (const entry of readLedger(value)) {
    const processId = readProcessId(entry);
    if (processId === undefined || isDevShellEntry(entry) === false) {
      continue;
    }
    latestByProcess.set(processId, entry);
  }
  return [...latestByProcess.values()]
    .filter((entry) => entry.status === "running")
    .map(toEvidenceRef);
}

interface LedgerEntry {
  id: string;
  stepIndex?: number | undefined;
  kind?: string | undefined;
  status?: string | undefined;
  summary: string;
  target?: Record<string, unknown> | undefined;
  facts: Record<string, unknown>;
  links?: Record<string, unknown> | undefined;
}

function readLedger(value: unknown): LedgerEntry[] {
  return asArray(value)
    .map((item) => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== undefined)
    .flatMap((item) => {
      const id = asString(item.id);
      const summary = asString(item.summary);
      const facts = asRecord(item.facts);
      if (id === undefined || summary === undefined || facts === undefined) {
        return [];
      }
      return [{
        id,
        summary,
        facts,
        ...(typeof item.stepIndex === "number" && Number.isFinite(item.stepIndex)
          ? { stepIndex: Math.trunc(item.stepIndex) }
          : {}),
        ...(asString(item.kind) !== undefined ? { kind: asString(item.kind) } : {}),
        ...(asString(item.status) !== undefined ? { status: asString(item.status) } : {}),
        ...(asRecord(item.target) !== undefined ? { target: asRecord(item.target) } : {}),
        ...(asRecord(item.links) !== undefined ? { links: asRecord(item.links) } : {}),
      }];
    });
}

function findLatestMutationIndex(ledger: LedgerEntry[]): number {
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    if (isObservedMutation(ledger[index]!)) {
      return index;
    }
  }
  return -1;
}

function isObservedMutation(entry: LedgerEntry): boolean {
  if (readChangedFiles(entry).length > 0) {
    return true;
  }
  if (entry.kind !== "file_write" || entry.status !== "passed") {
    return false;
  }
  if (entry.facts.changed === false) {
    return false;
  }
  return readPath(entry) !== undefined;
}

function readQualifyingTokens(entry: LedgerEntry): string[] {
  if (entry.status === "running") {
    return [];
  }
  if (entry.kind === "process_result") {
    const command = asString(entry.facts.command)?.trim();
    return command === undefined
      ? []
      : command.split(/\s+&&\s+/u).map((item) => item.trim()).filter(Boolean).map((item) => `check:${item}`);
  }
  if (entry.kind === "artifact_verification") {
    const target = asString(entry.target?.value) ?? asString(entry.facts.artifactTarget);
    return target !== undefined ? [`verify:${target}`] : [];
  }
  if (entry.kind === "file_content") {
    const path = readPath(entry);
    return path !== undefined ? [`file:${path}`] : [];
  }
  return [];
}

function toEvidenceRef(entry: LedgerEntry): WorkspaceFreshnessEvidenceRef {
  const changedFiles = readChangedFiles(entry);
  return {
    evidenceId: entry.id,
    summary: entry.summary,
    ...(entry.stepIndex !== undefined ? { stepIndex: entry.stepIndex } : {}),
    ...(asString(entry.facts.toolName) !== undefined ? { toolName: asString(entry.facts.toolName) } : {}),
    ...(readProcessId(entry) !== undefined ? { processId: readProcessId(entry) } : {}),
    ...(asString(entry.facts.command) !== undefined ? { command: asString(entry.facts.command) } : {}),
    ...(renderWorkspaceRelativeCwd(entry.facts) !== undefined
      ? { cwd: renderWorkspaceRelativeCwd(entry.facts) }
      : {}),
    ...(entry.status !== undefined ? { status: entry.status } : {}),
    ...(changedFiles.length > 0 ? { changedFiles } : {}),
  };
}

function renderWorkspaceRelativeCwd(facts: Record<string, unknown>): string | undefined {
  const cwd = asString(facts.cwd);
  const workspaceRoot = asString(facts.workspaceRoot);
  if (cwd === undefined || workspaceRoot === undefined) {
    return cwd;
  }
  return renderWorkspaceRelativeTarget(workspaceRoot, cwd);
}

function readChangedFiles(entry: LedgerEntry): string[] {
  return [...new Set(asArray(entry.facts.changedFiles)
    .map((item) => asString(item)?.trim())
    .filter((item): item is string => item !== undefined && item.length > 0))];
}

function readPath(entry: LedgerEntry): string | undefined {
  return asString(entry.target?.value) ??
    asString(entry.facts.outputPath) ??
    asString(entry.facts.inputPath) ??
    asString(entry.facts.path);
}

function readProcessId(entry: LedgerEntry): string | undefined {
  return asString(entry.facts.sessionId) ??
    asString(entry.facts.processId) ??
    asString(entry.links?.processId) ??
    (entry.target?.type === "process" ? asString(entry.target.value) : undefined);
}

function isDevShellEntry(entry: LedgerEntry): boolean {
  const toolName = asString(entry.facts.toolName);
  return toolName === "exec_command" || toolName === "dev.process.start" ||
    toolName === "dev.process.read" || toolName === "dev.process.write_and_read" ||
    toolName === "dev.process.stop";
}

function uniqueEntries(entries: LedgerEntry[]): LedgerEntry[] {
  return [...new Map(entries.map((entry) => [entry.id, entry])).values()];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
