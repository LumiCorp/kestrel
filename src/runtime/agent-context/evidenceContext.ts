import type { ModelTranscript, ModelTranscriptItem } from "../modelTranscript.js";

const MAX_RECENT_FILESYSTEM_EVIDENCE_ITEMS = 4;
const MAX_RECENT_FILESYSTEM_PREVIEW_CHARS = 1200;
const MAX_RECENT_TOOL_RESULT_EVIDENCE_ITEMS = 3;
const MAX_ACTIVE_PROCESS_EVIDENCE_ITEMS = 2;
const MAX_TOOL_RESULT_FIELD_PREVIEW_CHARS = 360;
const MAX_PROJECT_QUEUE_TASKS_PER_STATUS = 8;
const PROJECT_TASK_STATUSES = ["proposed", "queued", "running", "needs_attention", "ready_for_review"] as const;

export function buildProjectTaskQueueContext(projectSnapshot: unknown): string | undefined {
  const snapshot = asRecord(projectSnapshot);
  const taskQueue = asRecord(snapshot?.taskQueue);
  const tasks = asRecord(taskQueue?.tasks);
  if (snapshot === undefined || taskQueue === undefined || tasks === undefined) {
    return ;
  }
  const lines = [
    "Mission Control task queue:",
    `- sessionId: ${asString(snapshot.sessionId) ?? "(current project thread)"}`,
    "- Use task.propose for agent-created follow-up work. Proposed tasks require human approval before execution.",
    "- User-created queued tasks are approved work. Claim only queued tasks, attach evidence, and submit completed output for review.",
    "- Before proposing tasks, compare against existing ids/titles/instructions below and avoid duplicates.",
  ];
  for (const status of PROJECT_TASK_STATUSES) {
    const statusTasks = Object.values(tasks)
      .map(asRecord)
      .filter((task): task is Record<string, unknown> => task !== undefined && asString(task.status) === status)
      .sort(compareProjectQueueTasks)
      .slice(0, MAX_PROJECT_QUEUE_TASKS_PER_STATUS);
    lines.push(`${status}: ${statusTasks.length === 0 ? "(empty)" : ""}`);
    for (const task of statusTasks) {
      const evidence = asRecord(asArray(task.evidence).at(-1));
      const assignedAgent = asString(task.assignedAgentId);
      lines.push(
        `- ${asString(task.id) ?? "unknown"} ${clampEvidencePreview(asString(task.title) ?? "Untitled", 160)} :: ${clampEvidencePreview(asString(task.instructions) ?? "", 280)}${assignedAgent !== undefined ? ` [agent ${assignedAgent}]` : ""}${evidence !== undefined ? ` [latest ${asString(evidence.source) ?? "evidence"}: ${clampEvidencePreview(asString(evidence.summary) ?? "", 180)}]` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

export function buildRecentFilesystemEvidence(reactState: Record<string, unknown>): string[] | undefined {
  const records = collectFilesystemResultRecords(reactState.lastActionResult);
  const immediateEvidence = records
    .map(describeFilesystemResult)
    .filter((item): item is string => item !== undefined)
    .slice(0, MAX_RECENT_FILESYSTEM_EVIDENCE_ITEMS);
  const ledgerEvidence = buildLedgerFilesystemEvidence(reactState.evidenceLedger);
  const evidence = uniqueStrings([
    ...immediateEvidence,
    ...ledgerEvidence,
  ]).slice(0, MAX_RECENT_FILESYSTEM_EVIDENCE_ITEMS);
  return evidence.length > 0 ? evidence : undefined;
}

export function buildRecentToolResultEvidence(input: {
  lastActionResult?: unknown;
  transcript?: ModelTranscript | undefined;
}): string[] | undefined {
  const lastAction = asRecord(input.lastActionResult);
  const lastToolName = asString(lastAction?.toolName) ?? asString(lastAction?.name);
  const lastToolInput = asRecord(lastAction?.input);
  const transcriptItems = [...(input.transcript?.items ?? [])].reverse();
  const latestTranscriptCopy = transcriptItems.find((item) =>
    isSameToolAction(item, lastToolName, lastToolInput)
  );
  const latest = describeLastActionToolResult(
    input.lastActionResult,
    latestTranscriptCopy?.rawOutputRef ?? asString(asRecord(latestTranscriptCopy?.toolOutput)?.rawOutputRef),
  );
  let skippedLatestTranscriptCopy = false;
  const historical = transcriptItems
    .map((item) => {
      if (
        skippedLatestTranscriptCopy === false &&
        latest !== undefined &&
        isSameToolAction(item, lastToolName, lastToolInput)
      ) {
        skippedLatestTranscriptCopy = true;
        return ;
      }
      return describeTranscriptToolResult(item);
    })
    .filter((item): item is string => item !== undefined);
  const evidence = uniqueStrings([
    ...(latest !== undefined ? [`latest: ${latest}`] : []),
    ...historical.map((item) => `historical: ${item}`),
  ]).slice(0, MAX_RECENT_TOOL_RESULT_EVIDENCE_ITEMS);
  return evidence.length > 0 ? evidence : undefined;
}

export function buildActiveProcessEvidence(
  reactState: Record<string, unknown>,
  transcript?: ModelTranscript | undefined,
): string[] | undefined {
  const evidence = uniqueStrings([
    ...collectActiveProcessResultRecords(reactState.lastActionResult).map(describeActiveProcessResult),
    ...collectActiveProcessTranscriptRecords(transcript).map(describeActiveProcessResult),
    ...buildLedgerActiveProcessEvidence(reactState.evidenceLedger),
  ].filter((item): item is string => item !== undefined)).slice(0, MAX_ACTIVE_PROCESS_EVIDENCE_ITEMS);
  return evidence.length > 0 ? evidence : undefined;
}

function compareProjectQueueTasks(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftOrder = readInteger(left.order) ?? 0;
  const rightOrder = readInteger(right.order) ?? 0;
  if (leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return (asString(left.id) ?? "").localeCompare(asString(right.id) ?? "");
}

function readInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.trunc(value)
    : undefined;
}

function collectFilesystemResultRecords(value: unknown): Record<string, unknown>[] {
  const record = asRecord(value);
  if (record === undefined) {
    return [];
  }
  const records = [record, ...asArray(record.items).map(asRecord).filter((item): item is Record<string, unknown> => item !== undefined)];
  return records.filter((item) => {
    const toolName = asString(item.toolName) ?? asString(item.name);
    return toolName === "fs.read_text" || toolName === "fs.search_text" || toolName === "fs.list";
  });
}

function collectActiveProcessResultRecords(value: unknown): Record<string, unknown>[] {
  const record = asRecord(value);
  if (record === undefined) {
    return [];
  }
  const records = [record, ...asArray(record.items).map(asRecord).filter((item): item is Record<string, unknown> => item !== undefined)];
  return records.filter((item) => {
    const toolName = asString(item.toolName) ?? asString(item.name);
    const output = asRecord(item.output);
    return toolName === "exec_command" && isRunningStatus(output?.status);
  });
}

function collectActiveProcessTranscriptRecords(transcript: ModelTranscript | undefined): Record<string, unknown>[] {
  return [...(transcript?.items ?? [])]
    .reverse()
    .filter((item) => item.kind === "tool_result" && item.toolName === "exec_command")
    .map((item) => ({
      toolName: item.toolName,
      input: item.toolInput,
      output: item.toolOutput,
    }))
    .filter((item) => {
      const output = asRecord(item.output);
      return isRunningStatus(output?.status);
    });
}

function buildLedgerActiveProcessEvidence(value: unknown): string[] {
  return asArray(value)
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .slice(-16)
    .reverse()
    .map(describeLedgerActiveProcessEntry)
    .filter((item): item is string => item !== undefined);
}

function buildLedgerFilesystemEvidence(value: unknown): string[] {
  return asArray(value)
    .map(asRecord)
    .filter((entry): entry is Record<string, unknown> => entry !== undefined)
    .slice(-16)
    .reverse()
    .map(describeLedgerFilesystemEntry)
    .filter((item): item is string => item !== undefined);
}

function describeLedgerActiveProcessEntry(entry: Record<string, unknown>): string | undefined {
  const kind = asString(entry.kind);
  const status = asString(entry.status);
  if (kind !== "process_state" || isRunningStatus(status) === false) {
    return ;
  }
  const facts = asRecord(entry.facts);
  const target = asRecord(entry.target);
  const sessionId = asString(facts?.sessionId) ??
    asString(facts?.processId) ??
    asString(target?.value) ??
    asString(entry.targetValue);
  if (sessionId === undefined) {
    return ;
  }
  const toolName = asString(facts?.toolName) ?? "exec_command";
  const command = asString(facts?.command);
  const stdin = asString(facts?.stdin) ?? asString(facts?.sentInput);
  const cursor = typeof facts?.cursor === "number" ? Math.trunc(facts.cursor) : undefined;
  const preview = asString(facts?.outputPreview) ?? asString(facts?.text);
  return formatActiveProcessEvidence({
    toolName,
    sessionId,
    command,
    stdin,
    cursor,
    preview,
  });
}

function describeLedgerFilesystemEntry(entry: Record<string, unknown>): string | undefined {
  const facts = asRecord(entry.facts);
  const toolName = asString(facts?.toolName);
  if (facts === undefined || toolName === undefined) {
    return ;
  }
  const target = asRecord(entry.target);
  const targetPath = asString(facts.outputPath) ?? asString(facts.inputPath) ?? asString(target?.value);
  if (toolName === "fs.search_text") {
    const query = asString(facts.query);
    const count = typeof facts.matchCount === "number" ? Math.trunc(facts.matchCount) : undefined;
    const previews = asArray(facts.matches)
      .map(asRecord)
      .filter((match): match is Record<string, unknown> => match !== undefined)
      .slice(0, 3)
      .map((match) => {
        const path = asString(match.path) ?? targetPath ?? "unknown";
        const line = typeof match.line === "number" ? Math.trunc(match.line) : undefined;
        const preview = asString(match.preview);
        return `${path}${line !== undefined ? `:${line}` : ""}${preview !== undefined ? ` ${clampEvidencePreview(preview, 180)}` : ""}`;
      })
      .join("; ");
    if (count !== undefined) {
      return [
        `fs.search_text ${targetPath ?? "."}${query !== undefined ? ` for ${JSON.stringify(query)}` : ""}`,
        `returned ${count} match${count === 1 ? "" : "es"}`,
        previews.length > 0 ? `: ${previews}` : ".",
      ].join(" ");
    }
  }
  if (toolName === "fs.replace_text") {
    const find = asString(facts.find);
    const replace = asString(facts.replace);
    const replacements = typeof facts.replacements === "number" ? Math.trunc(facts.replacements) : undefined;
    const changed = typeof facts.changed === "boolean" ? facts.changed : undefined;
    const tokenDelta = typeof facts.whitespaceTokenCountDelta === "number" ? Math.trunc(facts.whitespaceTokenCountDelta) : undefined;
    const lineDelta = typeof facts.lineCountDelta === "number" ? Math.trunc(facts.lineCountDelta) : undefined;
    const deltas = [
      tokenDelta !== undefined && tokenDelta !== 0 ? `token delta ${formatSignedNumber(tokenDelta)}` : undefined,
      lineDelta !== undefined && lineDelta !== 0 ? `line delta ${formatSignedNumber(lineDelta)}` : undefined,
    ].filter((item): item is string => item !== undefined);
    return [
      `fs.replace_text ${targetPath ?? "."}`,
      find !== undefined || replace !== undefined
        ? `${JSON.stringify(find ?? "")} -> ${JSON.stringify(replace ?? "")}`
        : "literal replacement",
      replacements !== undefined
        ? `(${replacements} replacement${replacements === 1 ? "" : "s"}${deltas.length > 0 ? `, ${deltas.join(", ")}` : ""})`
        : undefined,
      changed === false ? "made no changes." : undefined,
    ].filter((item): item is string => item !== undefined).join(" ");
  }
  if (toolName === "fs.write_text") {
    const mode = asString(facts.mode);
    const bytes = typeof facts.contentBytes === "number"
      ? Math.trunc(facts.contentBytes)
      : typeof facts.bytesWritten === "number"
        ? Math.trunc(facts.bytesWritten)
        : undefined;
    const existed = typeof facts.existed === "boolean" ? facts.existed : undefined;
    const tokenDelta = numberDelta(facts.whitespaceTokenCountBefore, facts.whitespaceTokenCountAfter) ??
      (typeof facts.whitespaceTokenCountDelta === "number" ? Math.trunc(facts.whitespaceTokenCountDelta) : undefined);
    const lineDelta = numberDelta(facts.lineCountBefore, facts.lineCountAfter) ??
      (typeof facts.lineCountDelta === "number" ? Math.trunc(facts.lineCountDelta) : undefined);
    if (mode === "overwrite" && existed === true) {
      const deltas = [
        tokenDelta !== undefined ? `token delta ${formatSignedNumber(tokenDelta)}` : undefined,
        lineDelta !== undefined ? `line delta ${formatSignedNumber(lineDelta)}` : undefined,
      ].filter((item): item is string => item !== undefined);
      return [
        `fs.write_text overwrote existing file ${targetPath ?? "."}`,
        bytes !== undefined ? `with ${bytes} bytes` : undefined,
        deltas.length > 0 ? `(${deltas.join(", ")})` : undefined,
      ].filter((item): item is string => item !== undefined).join(" ") + ".";
    }
    return `fs.write_text ${targetPath ?? "."}${bytes !== undefined ? ` wrote ${bytes} bytes` : ""}${mode !== undefined ? ` (${mode})` : ""}.`;
  }
  if (toolName === "dev.shell.run" || toolName === "exec_command") {
    const changedFiles = asArray(facts.changedFiles)
      .map((item) => asString(item)?.trim())
      .filter((item): item is string => item !== undefined && item.length > 0)
      .slice(0, 8);
    if (changedFiles.length > 0) {
      return `${toolName} changed files: ${changedFiles.join(", ")}.`;
    }
  }
  if (toolName === "fs.read_text") {
    const preview = asString(facts.contentPreview);
    return preview !== undefined
      ? `fs.read_text ${targetPath ?? "."}: ${clampEvidencePreview(preview)}`
      : `fs.read_text ${targetPath ?? "."}.`;
  }
  if (toolName === "fs.list") {
    const count = typeof facts.entryCount === "number" ? Math.trunc(facts.entryCount) : undefined;
    return `fs.list ${targetPath ?? "."}${count !== undefined ? ` returned ${count} entr${count === 1 ? "y" : "ies"}` : ""}.`;
  }
  return ;
}

function describeActiveProcessResult(record: Record<string, unknown>): string | undefined {
  const toolName = asString(record.toolName) ?? asString(record.name) ?? "exec_command";
  const input = asRecord(record.input);
  const output = asRecord(record.output);
  const sessionId = asString(output?.sessionId) ?? asString(output?.processId) ?? asString(input?.sessionId);
  if (sessionId === undefined) {
    return ;
  }
  const cursor = typeof output?.cursor === "number" ? Math.trunc(output.cursor) : undefined;
  const preview = asString(output?.output) ?? asString(output?.text);
  return formatActiveProcessEvidence({
    toolName,
    sessionId,
    command: asString(input?.command),
    stdin: asString(input?.stdin),
    cursor,
    preview,
  });
}

function formatActiveProcessEvidence(input: {
  toolName: string;
  sessionId: string;
  command?: string | undefined;
  stdin?: string | undefined;
  cursor?: number | undefined;
  preview?: string | undefined;
}): string {
  return [
    `${input.toolName} running sessionId=${quoteEvidenceValue(input.sessionId)}`,
    input.command !== undefined ? `command=${quoteEvidenceValue(input.command)}` : undefined,
    input.stdin !== undefined ? `last stdin=${quoteEvidenceValue(input.stdin)}` : undefined,
    input.cursor !== undefined ? `cursor=${input.cursor}` : undefined,
    input.preview !== undefined ? `text=${quoteEvidenceValue(input.preview)}` : undefined,
    "continue with exec_command sessionId + stdin; do not start a fresh command unless intentionally resetting or starting unrelated work.",
  ].filter((item): item is string => item !== undefined).join(" ");
}

function describeFilesystemResult(record: Record<string, unknown>): string | undefined {
  const toolName = asString(record.toolName) ?? asString(record.name);
  const input = asRecord(record.input);
  const output = asRecord(record.output);
  if (toolName === undefined) {
    return ;
  }
  if (toolName === "fs.read_text") {
    const targetPath = asString(output?.path) ?? asString(input?.path);
    const content = asString(output?.content);
    const truncated = output?.truncated === true ? " (truncated)" : "";
    if (targetPath !== undefined && content !== undefined) {
      return `fs.read_text ${targetPath}${truncated}: ${clampEvidencePreview(content)}`;
    }
    return targetPath !== undefined ? `fs.read_text ${targetPath}${truncated}.` : undefined;
  }
  if (toolName === "fs.search_text") {
    const targetPath = asString(output?.path) ?? asString(input?.path);
    const query = asString(output?.query) ?? asString(input?.query);
    const matches = asArray(output?.matches).map(asRecord).filter((item): item is Record<string, unknown> => item !== undefined);
    const matchPreview = matches.slice(0, 6).map((match) => {
      const path = asString(match.path) ?? targetPath ?? "unknown";
      const line = typeof match.line === "number" ? Math.trunc(match.line) : undefined;
      const preview = asString(match.preview);
      return `${path}${line !== undefined ? `:${line}` : ""}${preview !== undefined ? ` ${clampEvidencePreview(preview, 180)}` : ""}`;
    }).join("; ");
    return [
      `fs.search_text ${targetPath ?? "."}${query !== undefined ? ` for ${JSON.stringify(query)}` : ""}`,
      `returned ${matches.length} match${matches.length === 1 ? "" : "es"}`,
      matchPreview.length > 0 ? `: ${matchPreview}` : ".",
    ].join(" ");
  }
  if (toolName === "fs.list") {
    const targetPath = asString(output?.path) ?? asString(input?.path);
    const entries = asArray(output?.entries).map(asRecord).filter((item): item is Record<string, unknown> => item !== undefined);
    const paths = entries
      .map((entry) => asString(entry.path) ?? asString(entry.name))
      .filter((item): item is string => item !== undefined)
      .slice(0, 8)
      .join(", ");
    return `fs.list ${targetPath ?? "."} returned ${entries.length} entr${entries.length === 1 ? "y" : "ies"}${paths.length > 0 ? `: ${paths}` : "."}`;
  }
  return ;
}

function isRunningStatus(value: unknown): boolean {
  return typeof value === "string" && value.trim().toLowerCase() === "running";
}

function describeLastActionToolResult(value: unknown, transcriptRawOutputRef?: string): string | undefined {
  const result = asRecord(value);
  if (result === undefined || asString(result.kind) !== "tool") {
    return ;
  }
  const toolName = asString(result.toolName) ?? asString(result.name);
  if (toolName === undefined) {
    return ;
  }
  const input = asRecord(result.input);
  const output = asRecord(result.output);
  const status = normalizeObservedToolStatus(
    asString(result.status) ?? asString(output?.status),
    result.ok,
  );
  const command = asString(output?.command) ?? asString(input?.command);
  const cwd = asString(output?.cwd) ?? asString(input?.cwd);
  const path = asString(output?.path) ?? asString(input?.path);
  const exitCode = readFiniteNumber(output?.exitCode);
  const error = asRecord(result.error);
  const errorCode = asString(output?.errorCode) ?? asString(error?.code);
  const failureReason = asString(output?.failureReason) ?? asString(error?.message);
  const stdout = firstString(output?.stdout, output?.output, output?.text, result.outputSummary);
  const stderr = firstString(output?.stderr);
  const rawOutputRef = asString(result.rawOutputRef) ?? asString(output?.rawOutputRef) ?? transcriptRawOutputRef;
  return renderObservedToolResult({
    toolName,
    status,
    command,
    cwd,
    path,
    ...(exitCode !== undefined ? { exitCode: String(exitCode) } : {}),
    errorCode,
    failureReason,
    stdout,
    stderr,
    rawOutputRef,
  });
}

function describeTranscriptToolResult(item: ModelTranscriptItem): string | undefined {
  if (item.kind !== "tool_result") {
    return ;
  }
  const toolOutput = asRecord(item.toolOutput);
  const text = asString(toolOutput?.text);
  if (text === undefined) {
    return ;
  }
  const status = readRenderedToolFact(text, "status");
  const toolInput = asRecord(item.toolInput);
  const command = asString(toolInput?.command) ?? readRenderedToolFact(text, "command");
  const cwd = asString(toolInput?.cwd) ?? readRenderedToolFact(text, "cwd");
  const path = asString(toolInput?.path) ?? readRenderedToolFact(text, "path");
  const exitCode = readRenderedToolFact(text, "exitCode");
  const errorCode = readRenderedToolFact(text, "errorCode");
  const failureReason = readRenderedToolFact(text, "failureReason");
  const stdout = readRenderedToolBlock(text, "stdout");
  const stderr = readRenderedToolBlock(text, "stderr");
  const resultText = readRenderedToolBlock(text, "text");
  const rawOutputRef = item.rawOutputRef ?? asString(toolOutput?.rawOutputRef);
  return renderObservedToolResult({
    toolName: item.toolName ?? "unknown",
    status: normalizeObservedToolStatus(status),
    command,
    cwd,
    path,
    exitCode,
    errorCode,
    failureReason,
    stdout: stdout ?? resultText,
    stderr,
    rawOutputRef,
  });
}

function renderObservedToolResult(input: {
  toolName: string;
  status: string;
  command?: string | undefined;
  cwd?: string | undefined;
  path?: string | undefined;
  exitCode?: string | undefined;
  errorCode?: string | undefined;
  failureReason?: string | undefined;
  stdout?: string | undefined;
  stderr?: string | undefined;
  rawOutputRef?: string | undefined;
}): string {
  return [
    `${input.toolName} ${input.status}`,
    input.command !== undefined ? `command=${quoteEvidenceValue(input.command)}` : undefined,
    input.cwd !== undefined ? `cwd=${quoteEvidenceValue(input.cwd)}` : undefined,
    input.path !== undefined ? `path=${quoteEvidenceValue(input.path)}` : undefined,
    input.exitCode !== undefined ? `exitCode=${input.exitCode}` : undefined,
    input.errorCode !== undefined ? `errorCode=${quoteEvidenceValue(input.errorCode)}` : undefined,
    input.failureReason !== undefined ? `failureReason=${quoteEvidenceValue(input.failureReason)}` : undefined,
    input.stdout !== undefined ? `stdout=${quoteEvidenceValue(input.stdout)}` : undefined,
    input.stderr !== undefined ? `stderr=${quoteEvidenceValue(input.stderr)}` : undefined,
    input.rawOutputRef !== undefined ? `rawOutputRef=${input.rawOutputRef}` : undefined,
  ].filter((part): part is string => part !== undefined).join(" ");
}

function normalizeObservedToolStatus(value: string | undefined, ok?: unknown): string {
  const normalized = value?.trim().toLowerCase();
  if (ok === false || normalized === "failed" || normalized === "error") {
    return "failed";
  }
  if (normalized === "running") {
    return "running";
  }
  if (normalized === "partial") {
    return "partial";
  }
  if (
    ok === true ||
    normalized === "ok" ||
    normalized === "completed" ||
    normalized === "passed" ||
    normalized === "succeeded" ||
    normalized === "success"
  ) {
    return "succeeded";
  }
  return normalized ?? "observed";
}

function isSameToolAction(
  item: ModelTranscriptItem,
  toolName: string | undefined,
  toolInput: Record<string, unknown> | undefined,
): boolean {
  return item.kind === "tool_result" &&
    toolName !== undefined &&
    item.toolName === toolName &&
    JSON.stringify(item.toolInput ?? {}) === JSON.stringify(toolInput ?? {});
}

function readRenderedToolFact(text: string, fieldName: string): string | undefined {
  const prefix = `- ${fieldName}: `;
  const line = text.split(/\r?\n/u).find((item) => item.startsWith(prefix));
  const value = line?.slice(prefix.length).trim();
  return value !== undefined && value.length > 0 && value !== "<empty>" ? value : undefined;
}

function readRenderedToolBlock(text: string, fieldName: string): string | undefined {
  const lines = text.split(/\r?\n/u);
  const startIndex = lines.findIndex((line) => line === `- ${fieldName}:`);
  if (startIndex === -1) {
    return ;
  }
  const block: string[] = [];
  for (const line of lines.slice(startIndex + 1)) {
    if (line.startsWith("- ")) {
      break;
    }
    if (line.startsWith("  ") === false && line.trim().length > 0) {
      break;
    }
    block.push(line.startsWith("  ") ? line.slice(2) : line);
  }
  const value = block.join("\n").trim();
  if (value.length === 0 || value === "<empty>") {
    return ;
  }
  return clampEvidencePreview(value, MAX_TOOL_RESULT_FIELD_PREVIEW_CHARS);
}

function quoteEvidenceValue(value: string): string {
  return JSON.stringify(clampEvidencePreview(value, MAX_TOOL_RESULT_FIELD_PREVIEW_CHARS));
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }
  return result;
}

function numberDelta(before: unknown, after: unknown): number | undefined {
  if (
    typeof before !== "number" ||
    typeof after !== "number" ||
    Number.isFinite(before) === false ||
    Number.isFinite(after) === false
  ) {
    return ;
  }
  return Math.trunc(after) - Math.trunc(before);
}

function formatSignedNumber(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

function clampEvidencePreview(value: string, maxChars = MAX_RECENT_FILESYSTEM_PREVIEW_CHARS): string {
  const normalized = value.trim().replace(/\s+/gu, " ");
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && Array.isArray(value) === false
    ? value as Record<string, unknown>
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
