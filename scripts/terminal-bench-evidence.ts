import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

export type TerminalBenchFailureClassification =
  | "passed"
  | "provider_config_or_quota"
  | "runtime_adapter_failed"
  | "benchmark_setup_failed_before_adapter"
  | "artifact_passed_but_agent_failed"
  | "adapter_completed_but_verifier_unresolved"
  | "model_quality_or_task_strategy"
  | "unknown";

export interface TerminalBenchTaskEvidence {
  taskId: string;
  resultPath?: string;
  adapterArtifactPaths: string[];
  eventLogPaths: string[];
  agentLogPath?: string;
  isResolved?: boolean;
  failureMode?: string;
  agentStartedAt?: string;
  agentEndedAt?: string;
  adapterStatus?: string;
  adapterFailureKind?: string;
  eventFailureKind?: string;
  protectedPathDenialObserved?: boolean;
  modelProvider?: string;
  model?: string;
  agentDurationMs?: number;
  runtimeStepCount?: number;
  classification: TerminalBenchFailureClassification;
}

export interface TerminalBenchRunEvidence {
  runId: string;
  runDir: string;
  aggregatePath: string;
  total: number;
  resolved: number;
  unresolved: number;
  accuracy: number;
  artifactPaths: string[];
  adapterFailureKindCounts: Record<string, number>;
  verifierFailureModeCounts: Record<string, number>;
  classificationCounts: Record<TerminalBenchFailureClassification, number>;
  agentDurationMs: number[];
  runtimeStepCounts: number[];
  tasks: TerminalBenchTaskEvidence[];
}

type JsonRecord = Record<string, unknown>;

const PROVIDER_FAILURE_KINDS = new Set([
  "provider_rate_limited",
  "provider_quota_or_config",
  "provider_config",
  "benchmark_setup_failed",
]);

const RUNTIME_ADAPTER_FAILURE_KINDS = new Set([
  "terminal_bench_bridge_fetch_failed",
  "terminal_bench_protected_path_misuse",
  "model_contract_cannot_satisfy",
  "runtime_waiting_for_user",
]);

const VERIFIER_ENV_FAILURE_MODES = new Set([
  "test_timeout",
]);

export async function collectTerminalBenchEvidence(runsDir: string): Promise<TerminalBenchRunEvidence[]> {
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const evidence: TerminalBenchRunEvidence[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const runDir = path.join(runsDir, entry.name);
    const aggregatePath = path.join(runDir, "results.json");
    const aggregate = await readJsonObject(aggregatePath);
    if (aggregate === undefined || terminalBenchAggregateMetrics(aggregate) === undefined) {
      continue;
    }
    evidence.push(await summarizeTerminalBenchRun(runDir));
  }
  return evidence.sort((left, right) => left.runId.localeCompare(right.runId));
}

export async function summarizeTerminalBenchRun(runDir: string): Promise<TerminalBenchRunEvidence> {
  const aggregatePath = path.join(runDir, "results.json");
  const aggregate = (await readJsonObject(aggregatePath)) ?? {};
  const metrics = terminalBenchAggregateMetrics(aggregate) ?? { total: 0, resolved: 0, unresolved: 0, accuracy: 0 };
  const taskResultPaths = (await listFilesByName(runDir, (name) => name === "results.json"))
    .filter((file) => path.resolve(file) !== path.resolve(aggregatePath));
  const adapterPaths = await listFilesByName(runDir, (name) => /^kestrel-.*\.json$/u.test(name));
  const eventLogPaths = await listFilesByName(runDir, (name) => /^kestrel-.*\.events\.jsonl$/u.test(name));
  const agentLogPaths = await listFilesByName(runDir, (name) => name === "agent.log");

  const adapterArtifacts = new Map<string, JsonRecord>();
  for (const adapterPath of adapterPaths) {
    const artifact = await readJsonObject(adapterPath);
    if (artifact !== undefined) {
      adapterArtifacts.set(adapterPath, artifact);
    }
  }

  const artifactPaths = [aggregatePath, ...taskResultPaths, ...adapterPaths, ...eventLogPaths, ...agentLogPaths].sort();
  const tasks: TerminalBenchTaskEvidence[] = [];
  for (const taskResultPath of taskResultPaths) {
    const taskResult = (await readJsonObject(taskResultPath)) ?? {};
    const taskDir = path.dirname(taskResultPath);
    const taskAdapterPaths = adapterPaths.filter((file) => isDescendant(taskDir, file));
    const taskEventLogPaths = eventLogPaths.filter((file) => isDescendant(taskDir, file));
    const taskAgentLogPath = agentLogPaths.find((file) => isDescendant(taskDir, file));
    const adapterArtifact = firstDefined(taskAdapterPaths.map((file) => adapterArtifacts.get(file)));
    const eventSignals = await readEventLogSignals(taskEventLogPaths);
    const evidence = taskEvidenceFromArtifacts({
      taskResult,
      taskResultPath,
      adapterArtifact,
      adapterPaths: taskAdapterPaths,
      eventLogPaths: taskEventLogPaths,
      agentLogPath: taskAgentLogPath,
      eventSignals,
    });
    tasks.push(evidence);
  }

  if (tasks.length === 0 && adapterPaths.length > 0) {
    for (const [adapterPath, adapterArtifact] of adapterArtifacts) {
      tasks.push(taskEvidenceFromArtifacts({
        taskResult: {},
        adapterArtifact,
        adapterPaths: [adapterPath],
        eventLogPaths,
        agentLogPath: agentLogPaths[0],
        eventSignals: await readEventLogSignals(eventLogPaths),
      }));
    }
  }

  const adapterFailureKindCounts: Record<string, number> = {};
  const verifierFailureModeCounts: Record<string, number> = {};
  const classificationCounts = emptyClassificationCounts();
  const agentDurationMs: number[] = [];
  const runtimeStepCounts: number[] = [];
  for (const task of tasks) {
    increment(classificationCounts, task.classification);
    if (task.adapterFailureKind !== undefined) {
      increment(adapterFailureKindCounts, task.adapterFailureKind);
    }
    if (task.eventFailureKind !== undefined && task.adapterFailureKind === undefined) {
      increment(adapterFailureKindCounts, task.eventFailureKind);
    }
    if (task.failureMode !== undefined) {
      increment(verifierFailureModeCounts, task.failureMode);
    }
    if (task.agentDurationMs !== undefined) {
      agentDurationMs.push(task.agentDurationMs);
    }
    if (task.runtimeStepCount !== undefined) {
      runtimeStepCounts.push(task.runtimeStepCount);
    }
  }

  return {
    runId: path.basename(runDir),
    runDir,
    aggregatePath,
    ...metrics,
    artifactPaths,
    adapterFailureKindCounts,
    verifierFailureModeCounts,
    classificationCounts,
    agentDurationMs,
    runtimeStepCounts,
    tasks: tasks.sort((left, right) => left.taskId.localeCompare(right.taskId)),
  };
}

function taskEvidenceFromArtifacts(input: {
  taskResult: JsonRecord;
  taskResultPath?: string | undefined;
  adapterArtifact?: JsonRecord | undefined;
  adapterPaths: string[];
  eventLogPaths: string[];
  agentLogPath?: string | undefined;
  eventSignals: EventLogSignals;
}): TerminalBenchTaskEvidence {
  const taskId = readString(input.taskResult.task_id) ?? readString(input.adapterArtifact?.task_id) ?? "unknown";
  const isResolved = typeof input.taskResult.is_resolved === "boolean" ? input.taskResult.is_resolved : undefined;
  const failureMode = readString(input.taskResult.failure_mode);
  const agentStartedAt = readString(input.taskResult.agent_started_at);
  const agentEndedAt = readString(input.taskResult.agent_ended_at);
  const adapterStatus = readString(input.adapterArtifact?.status);
  const artifactFailureKind = readString(input.adapterArtifact?.failure_kind);
  const eventFailureKind = input.eventSignals.failureKind;
  const protectedPathDenialObserved =
    input.eventSignals.protectedPathDenialObserved === true ||
    artifactProtectedPathDenialObserved(input.adapterArtifact);
  const adapterFailureKind = artifactFailureKind !== undefined && artifactFailureKind !== "none"
    ? artifactFailureKind
    : eventFailureKind;
  const modelProvider = readString(input.adapterArtifact?.model_provider);
  const model = readString(input.adapterArtifact?.model);
  const agentDurationMs = durationMs(agentStartedAt, agentEndedAt) ?? readNumber(input.adapterArtifact?.duration_ms);
  const classification = classifyTaskEvidence({
    isResolved,
    failureMode,
    agentStartedAt,
    adapterStatus,
    adapterFailureKind,
    eventFailureKind,
    runtimeTerminalStatus: input.eventSignals.terminalStatus,
    hasAdapterArtifact: input.adapterPaths.length > 0,
  });

  return {
    taskId,
    ...(input.taskResultPath === undefined ? {} : { resultPath: input.taskResultPath }),
    adapterArtifactPaths: input.adapterPaths,
    eventLogPaths: input.eventLogPaths,
    ...(input.agentLogPath === undefined ? {} : { agentLogPath: input.agentLogPath }),
    ...(isResolved === undefined ? {} : { isResolved }),
    ...(failureMode === undefined ? {} : { failureMode }),
    ...(agentStartedAt === undefined ? {} : { agentStartedAt }),
    ...(agentEndedAt === undefined ? {} : { agentEndedAt }),
    ...(adapterStatus === undefined ? {} : { adapterStatus }),
    ...(adapterFailureKind === undefined ? {} : { adapterFailureKind }),
    ...(eventFailureKind === undefined ? {} : { eventFailureKind }),
    ...(protectedPathDenialObserved === false ? {} : { protectedPathDenialObserved }),
    ...(modelProvider === undefined ? {} : { modelProvider }),
    ...(model === undefined ? {} : { model }),
    ...(agentDurationMs === undefined ? {} : { agentDurationMs }),
    ...(input.eventSignals.runtimeStepCount === undefined ? {} : { runtimeStepCount: input.eventSignals.runtimeStepCount }),
    classification,
  };
}

function classifyTaskEvidence(input: {
  isResolved?: boolean | undefined;
  failureMode?: string | undefined;
  agentStartedAt?: string | undefined;
  adapterStatus?: string | undefined;
  adapterFailureKind?: string | undefined;
  eventFailureKind?: string | undefined;
  runtimeTerminalStatus?: string | undefined;
  hasAdapterArtifact: boolean;
}): TerminalBenchFailureClassification {
  if (input.isResolved === true && input.adapterStatus !== "failed" && input.adapterStatus !== "timeout") {
    return "passed";
  }
  if (input.adapterFailureKind !== undefined && PROVIDER_FAILURE_KINDS.has(input.adapterFailureKind)) {
    return "provider_config_or_quota";
  }
  if (
    input.runtimeTerminalStatus === "WAITING" ||
    (input.eventFailureKind !== undefined && RUNTIME_ADAPTER_FAILURE_KINDS.has(input.eventFailureKind))
  ) {
    return "runtime_adapter_failed";
  }
  if (input.isResolved === true && (input.adapterStatus === "failed" || input.adapterStatus === "timeout")) {
    return "artifact_passed_but_agent_failed";
  }
  if (input.hasAdapterArtifact && (input.adapterStatus === "failed" || input.adapterStatus === "timeout")) {
    return "runtime_adapter_failed";
  }
  if (!input.hasAdapterArtifact && input.agentStartedAt === undefined) {
    return "benchmark_setup_failed_before_adapter";
  }
  if (
    input.adapterStatus === "completed" &&
    input.isResolved === false &&
    input.failureMode !== undefined &&
    VERIFIER_ENV_FAILURE_MODES.has(input.failureMode)
  ) {
    return "adapter_completed_but_verifier_unresolved";
  }
  if (input.hasAdapterArtifact && input.isResolved === false) {
    return "model_quality_or_task_strategy";
  }
  return "unknown";
}

function terminalBenchAggregateMetrics(parsed: JsonRecord): {
  total: number;
  resolved: number;
  unresolved: number;
  accuracy: number;
} | undefined {
  const explicitResolved = readNumber(parsed.n_resolved);
  const explicitUnresolved = readNumber(parsed.n_unresolved);
  const explicitAccuracy = readNumber(parsed.accuracy);
  if (explicitResolved !== undefined || explicitUnresolved !== undefined || explicitAccuracy !== undefined) {
    return {
      total: (explicitResolved ?? 0) + (explicitUnresolved ?? 0),
      resolved: explicitResolved ?? 0,
      unresolved: explicitUnresolved ?? 0,
      accuracy: explicitAccuracy ?? 0,
    };
  }

  if (!Array.isArray(parsed.results)) {
    return ;
  }
  const rows = parsed.results.filter(isRecord);
  if (rows.length === 0) {
    return ;
  }
  const resolved = rows.filter((row) => row.is_resolved === true).length;
  return {
    total: rows.length,
    resolved,
    unresolved: rows.length - resolved,
    accuracy: roundRate(resolved / rows.length),
  };
}

interface EventLogSignals {
  runtimeStepCount?: number;
  terminalStatus?: string;
  failureKind?: string;
  protectedPathDenialObserved?: boolean;
}

async function readEventLogSignals(paths: string[]): Promise<EventLogSignals> {
  let maxStepIndex = -1;
  let terminalStatus: string | undefined;
  let failureKind: string | undefined;
  let protectedPathDenialObserved = false;
  for (const file of paths) {
    let raw = "";
    try {
      raw = await readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/u)) {
      if (line.trim().length === 0) {
        continue;
      }
      if (line.includes("Terminal-Bench dev shell bridge request failed: fetch failed")) {
        failureKind = "terminal_bench_bridge_fetch_failed";
      }
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(record)) {
        continue;
      }
      const payload = isRecord(record.payload) ? record.payload : {};
      const update = isRecord(payload.update) ? payload.update : {};
      const entry = isRecord(payload.entry) ? payload.entry : {};
      const stepIndex = readNumber(update.stepIndex) ?? readNumber(entry.stepIndex);
      if (stepIndex !== undefined) {
        maxStepIndex = Math.max(maxStepIndex, stepIndex);
      }
      if (update.code === "WAITING_FOR_EVENT") {
        terminalStatus = "WAITING";
        failureKind = "runtime_waiting_for_user";
      }
      if (eventContainsTerminalBenchProtectedPathMisuse(record)) {
        failureKind = "terminal_bench_protected_path_misuse";
      }
      if (eventContainsProtectedPathDenialInOutput(record)) {
        protectedPathDenialObserved = true;
      }
      if (eventContainsCannotSatisfy(record)) {
        failureKind = "model_contract_cannot_satisfy";
      }
      const metadata = isRecord(entry.metadata) ? entry.metadata : {};
      if (entry.eventName === "run_terminal") {
        const status = readString(metadata.status);
        if (status !== undefined) {
          terminalStatus = status;
        }
      }
    }
  }
  return {
    ...(maxStepIndex >= 0 ? { runtimeStepCount: maxStepIndex + 1 } : {}),
    ...(terminalStatus === undefined ? {} : { terminalStatus }),
    ...(failureKind === undefined ? {} : { failureKind }),
    ...(protectedPathDenialObserved === false ? {} : { protectedPathDenialObserved }),
  };
}

function eventContainsTerminalBenchProtectedPathMisuse(record: JsonRecord): boolean {
  const payload = isRecord(record.payload) ? record.payload : {};
  const update = isRecord(payload.update) ? payload.update : {};
  if (toolPayloadMentionsProtectedPath(update)) {
    return true;
  }
  const output = isRecord(update.output) ? update.output : {};
  const audit = isRecord(output.auditRecord) ? output.auditRecord : {};
  if (toolPayloadMentionsProtectedPath(audit)) {
    return true;
  }

  const entry = isRecord(payload.entry) ? payload.entry : {};
  const metadata = isRecord(entry.metadata) ? entry.metadata : {};
  for (const key of ["next", "previous"]) {
    const state = isRecord(metadata[key]) ? metadata[key] as JsonRecord : {};
    const action = isRecord(state.nextAction) ? state.nextAction : {};
    if (actionMentionsProtectedPath(action)) {
      return true;
    }
  }
  const latestEvidence = isRecord(metadata.latestEvidence) ? metadata.latestEvidence : {};
  return readString(latestEvidence.summary)?.includes("Terminal-Bench protected path is not available to agent shell commands") === true;
}

function eventContainsProtectedPathDenialInOutput(record: JsonRecord): boolean {
  const payload = isRecord(record.payload) ? record.payload : {};
  const update = isRecord(payload.update) ? payload.update : {};
  if (protectedDenialInOutput(update.output)) {
    return true;
  }
  const output = isRecord(update.output) ? update.output : {};
  const audit = isRecord(output.auditRecord) ? output.auditRecord : {};
  if (protectedDenialInOutput(audit.output)) {
    return true;
  }

  const entry = isRecord(payload.entry) ? payload.entry : {};
  const metadata = isRecord(entry.metadata) ? entry.metadata : {};
  const latestEvidence = isRecord(metadata.latestEvidence) ? metadata.latestEvidence : {};
  const summary = readString(latestEvidence.summary);
  return summary?.includes("/protected") === true && summary.includes("Permission denied");
}

function eventContainsCannotSatisfy(record: JsonRecord): boolean {
  const payload = isRecord(record.payload) ? record.payload : {};
  const update = isRecord(payload.update) ? payload.update : {};
  if (update.toolName === "FinalizeAnswer" && containsCannotSatisfyMarker(update.input)) {
    return true;
  }
  const output = isRecord(update.output) ? update.output : {};
  const audit = isRecord(output.auditRecord) ? output.auditRecord : {};
  if (containsCannotSatisfyMarker(audit.input)) {
    return true;
  }

  const entry = isRecord(payload.entry) ? payload.entry : {};
  const metadata = isRecord(entry.metadata) ? entry.metadata : {};
  if (metadata.decisionCode === "cannot_satisfy") {
    return true;
  }
  for (const key of ["next", "previous"]) {
    const state = isRecord(metadata[key]) ? metadata[key] as JsonRecord : {};
    const action = isRecord(state.nextAction) ? state.nextAction : {};
    if (action.kind === "cannot_satisfy") {
      return true;
    }
  }
  return containsCannotSatisfyMarker(metadata.cannotSatisfy);
}

function toolPayloadMentionsProtectedPath(value: JsonRecord): boolean {
  const toolName = readString(value.toolName);
  return (
    (toolName !== undefined && actionMentionsProtectedPath(value.input)) ||
    blockedProtectedPathInOutput(value.output)
  );
}

function actionMentionsProtectedPath(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  for (const key of ["command", "path", "sourcePath", "destinationPath", "cwd", "workspaceRoot"]) {
    if (readString(value[key])?.includes("/protected") === true) {
      return true;
    }
  }
  return false;
}

function blockedProtectedPathInOutput(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.securityMode === "blocked_protected_path") {
    return true;
  }
  for (const key of ["output", "result", "payload"]) {
    if (blockedProtectedPathInOutput(value[key])) {
      return true;
    }
  }
  return false;
}

function protectedDenialInOutput(value: unknown): boolean {
  if (typeof value === "string") {
    return value.includes("Terminal-Bench protected path is not available to agent shell commands") ||
      (value.includes("/protected") && value.includes("Permission denied"));
  }
  if (!isRecord(value)) {
    return false;
  }
  for (const key of ["text", "stdout", "stderr", "failureReason", "message"]) {
    if (protectedDenialInOutput(value[key])) {
      return true;
    }
  }
  return protectedDenialInOutput(value.output);
}

function artifactProtectedPathDenialObserved(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const details = isRecord(value.failure_details) ? value.failure_details : {};
  return isRecord(details.protected_path_denial_observed_in_output);
}

function containsCannotSatisfyMarker(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsCannotSatisfyMarker);
  }
  if (!isRecord(value)) {
    return false;
  }
  if ("cannotSatisfy" in value || value.kind === "cannot_satisfy" || value.reasonCode === "unsatisfied_by_available_tools") {
    return true;
  }
  return Object.values(value).some(containsCannotSatisfyMarker);
}

async function listFilesByName(root: string, predicate: (name: string) => boolean): Promise<string[]> {
  const out: string[] = [];
  await walk(root, predicate, out);
  return out.sort();
}

async function walk(root: string, predicate: (name: string) => boolean, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      await walk(full, predicate, out);
      continue;
    }
    if (entry.isFile() && predicate(entry.name)) {
      out.push(full);
    }
  }
}

async function readJsonObject(file: string): Promise<JsonRecord | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return ;
  }
}

function isDescendant(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function firstDefined<T>(values: Array<T | undefined>): T | undefined {
  return values.find((value): value is T => value !== undefined);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function durationMs(start?: string, end?: string): number | undefined {
  if (start === undefined || end === undefined) {
    return ;
  }
  const startedAt = Date.parse(start);
  const endedAt = Date.parse(end);
  if (!(Number.isFinite(startedAt) && Number.isFinite(endedAt) ) || endedAt < startedAt) {
    return ;
  }
  return endedAt - startedAt;
}

function increment<T extends string>(counts: Record<T, number>, key: T): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function emptyClassificationCounts(): Record<TerminalBenchFailureClassification, number> {
  return {
    passed: 0,
    provider_config_or_quota: 0,
    runtime_adapter_failed: 0,
    benchmark_setup_failed_before_adapter: 0,
    artifact_passed_but_agent_failed: 0,
    adapter_completed_but_verifier_unresolved: 0,
    model_quality_or_task_strategy: 0,
    unknown: 0,
  };
}

function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000;
}
