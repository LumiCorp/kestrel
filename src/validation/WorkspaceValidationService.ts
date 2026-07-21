import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import { redactDiagnosticText } from "../diagnostics/redaction.js";
import type {
  WorkspaceValidationAction,
  WorkspaceValidationKind,
  WorkspaceValidationOutputEntry,
  WorkspaceValidationResult,
  WorkspaceValidationSnapshot,
  WorkspaceValidationSuite,
} from "./contracts.js";

const MAX_OUTPUT_BYTES = 512 * 1024;
const MAX_RESULTS = 200;
const CANONICAL_KINDS = new Set<WorkspaceValidationKind>([
  "setup",
  "test",
  "lint",
  "typecheck",
  "build",
  "smoke",
]);

interface Store {
  version: 1;
  results: WorkspaceValidationResult[];
}

interface ValidationConfig {
  version: 1;
  actions?: Array<{
    id: string;
    label: string;
    kind: WorkspaceValidationKind;
    command: string;
    args?: string[] | undefined;
    cwd?: string | undefined;
    required?: boolean | undefined;
    artifacts?: string[] | undefined;
    locationsFile?: string | undefined;
  }>;
  suites?: Array<{
    id: string;
    label: string;
    actions: string[];
    stopOnFailure?: boolean | undefined;
  }>;
}

export class WorkspaceValidationService {
  private readonly results = new Map<string, WorkspaceValidationResult>();
  private readonly processes = new Map<string, ChildProcess>();
  private persistTail: Promise<void> = Promise.resolve();

  constructor(private readonly metadataPath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.metadataPath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.metadataPath, "utf8")) as Partial<Store>;
      if (parsed.version === 1 && Array.isArray(parsed.results)) {
        for (const result of parsed.results) {
          if (!isResult(result)) continue;
          const normalized = {
            ...result,
            locations: Array.isArray(result.locations) ? result.locations : [],
          };
          this.results.set(
            result.resultId,
            result.outcome === "running"
              ? {
                  ...normalized,
                  outcome: "cancelled",
                  completedAt: new Date().toISOString(),
                  durationMs: Date.now() - Date.parse(result.startedAt),
                  output: [
                    ...normalized.output,
                    {
                      seq: result.output.length + 1,
                      at: new Date().toISOString(),
                      stream: "system",
                      text: "Validation process did not survive Local Core restart.",
                    },
                  ],
                }
              : normalized,
          );
        }
      }
    } catch {
      // Missing or invalid Local Core validation metadata starts empty.
    }
    await this.persist();
  }

  async inspect(input: {
    sessionId: string;
    threadId: string;
    workspaceRoot: string;
    candidateFingerprint: string;
  }): Promise<WorkspaceValidationSnapshot> {
    const sessionId = identifier(input.sessionId, "sessionId");
    const threadId = identifier(input.threadId, "threadId");
    const workspaceRoot = await realpath(path.resolve(input.workspaceRoot));
    const candidateFingerprint = fingerprint(input.candidateFingerprint);
    const { actions, suites } = await discover(workspaceRoot);
    let changed = false;
    for (const [id, result] of this.results) {
      if (
        result.sessionId === sessionId &&
        result.threadId === threadId &&
        result.outcome !== "stale" &&
        result.candidateFingerprint !== candidateFingerprint
      ) {
        if (result.outcome === "running") this.terminate(id);
        const now = new Date().toISOString();
        this.results.set(id, {
          ...result,
          outcome: "stale",
          ...(result.completedAt ? {} : { completedAt: now, durationMs: Math.max(0, Date.parse(now) - Date.parse(result.startedAt)) }),
          output: [
            ...result.output,
            {
              seq: (result.output.at(-1)?.seq ?? 0) + 1,
              at: now,
              stream: "system",
              text: "Candidate changed while validation was running; this result cannot be used as evidence.",
            },
          ],
        });
        changed = true;
      }
    }
    if (changed) await this.persist();
    const results = [...this.results.values()]
      .filter((result) => result.sessionId === sessionId && result.threadId === threadId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(clone);
    return {
      sessionId,
      threadId,
      workspaceRoot,
      candidateFingerprint,
      actions,
      suites,
      results,
      readiness: readiness(actions, results, candidateFingerprint),
      generatedAt: new Date().toISOString(),
    };
  }

  async runAction(input: {
    sessionId: string;
    threadId: string;
    workspaceRoot: string;
    candidateFingerprint: string;
    actionId: string;
  }): Promise<WorkspaceValidationSnapshot> {
    const snapshot = await this.inspect(input);
    const action = snapshot.actions.find((candidate) => candidate.actionId === input.actionId);
    if (!action) throw failure("WORKSPACE_VALIDATION_ACTION_NOT_FOUND", "Validation action is unavailable.");
    if (snapshot.results.some((result) => result.outcome === "running" && result.actionId === action.actionId))
      throw failure("WORKSPACE_VALIDATION_ALREADY_RUNNING", "This validation action is already running.");
    this.start(snapshot, action);
    return this.inspect(input);
  }

  async runSuite(input: {
    sessionId: string;
    threadId: string;
    workspaceRoot: string;
    candidateFingerprint: string;
    suiteId: string;
  }): Promise<WorkspaceValidationSnapshot> {
    const snapshot = await this.inspect(input);
    const suite = snapshot.suites.find((candidate) => candidate.suiteId === input.suiteId);
    if (!suite) throw failure("WORKSPACE_VALIDATION_SUITE_NOT_FOUND", "Validation suite is unavailable.");
    if (snapshot.results.some((result) => result.outcome === "running"))
      throw failure("WORKSPACE_VALIDATION_ALREADY_RUNNING", "Wait for the active validation action to finish.");
    void this.executeSuite(snapshot, suite);
    return this.inspect(input);
  }

  async cancel(input: {
    sessionId: string;
    threadId: string;
    resultId: string;
  }): Promise<void> {
    const result = this.requireOwned(input);
    if (result.outcome !== "running")
      throw failure("WORKSPACE_VALIDATION_NOT_RUNNING", "Validation is not running.");
    const child = this.processes.get(result.resultId);
    if (!child) throw failure("WORKSPACE_VALIDATION_PROCESS_UNAVAILABLE", "Validation process is unavailable.");
    this.terminate(result.resultId);
  }

  async markSubmitted(input: {
    sessionId: string;
    threadId: string;
    resultIds: string[];
    runId: string;
  }): Promise<void> {
    if (!Array.isArray(input.resultIds) || input.resultIds.length === 0 || input.resultIds.length > 100)
      throw failure("WORKSPACE_VALIDATION_SELECTION_INVALID", "Select between 1 and 100 validation failures.");
    const runId = identifier(input.runId, "runId");
    for (const id of new Set(input.resultIds)) {
      const result = this.requireOwned({ ...input, resultId: id });
      if (result.outcome !== "failed" && result.outcome !== "stale")
        throw failure("WORKSPACE_VALIDATION_SELECTION_INVALID", "Only failed validation results can be sent to the coding thread.");
      this.results.set(id, { ...result, submissionRunId: runId });
    }
    await this.persist();
  }

  selected(input: { sessionId: string; threadId: string; resultIds: string[] }): WorkspaceValidationResult[] {
    if (!Array.isArray(input.resultIds) || input.resultIds.length === 0 || input.resultIds.length > 100)
      throw failure("WORKSPACE_VALIDATION_SELECTION_INVALID", "Select between 1 and 100 validation failures.");
    return [...new Set(input.resultIds)].map((resultId) => clone(this.requireOwned({ ...input, resultId })));
  }

  private start(snapshot: WorkspaceValidationSnapshot, action: WorkspaceValidationAction): WorkspaceValidationResult {
    const now = new Date().toISOString();
    const result: WorkspaceValidationResult = {
      resultId: randomUUID(),
      sessionId: snapshot.sessionId,
      threadId: snapshot.threadId,
      actionId: action.actionId,
      actionLabel: action.label,
      kind: action.kind,
      candidateFingerprint: snapshot.candidateFingerprint,
      outcome: "running",
      command: action.command,
      args: [...action.args],
      cwd: action.cwd,
      startedAt: now,
      output: [],
      outputTruncated: false,
      evidence: action.artifactPaths.map((artifactPath) => ({ path: artifactPath, exists: false })),
      locations: [],
      ...(action.locationsFile ? { locationsFile: action.locationsFile } : {}),
    };
    this.results.set(result.resultId, result);
    void this.persist();
    const child = spawn(action.command, action.args, {
      cwd: action.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.processes.set(result.resultId, child);
    child.stdout?.on("data", (chunk: Buffer) => this.append(result.resultId, "stdout", chunk.toString("utf8")));
    child.stderr?.on("data", (chunk: Buffer) => this.append(result.resultId, "stderr", chunk.toString("utf8")));
    child.once("error", (cause) => void this.finish(result.resultId, null, null, cause.message));
    child.once("close", (code, signal) => void this.finish(result.resultId, code, signal));
    return result;
  }

  private async executeSuite(snapshot: WorkspaceValidationSnapshot, suite: WorkspaceValidationSuite): Promise<void> {
    for (let index = 0; index < suite.actionIds.length; index += 1) {
      const actionId = suite.actionIds[index]!;
      const action = snapshot.actions.find((candidate) => candidate.actionId === actionId);
      if (!action) continue;
      const result = this.start(snapshot, action);
      const settled = await this.waitFor(result.resultId);
      if (settled.outcome === "passed" || !suite.stopOnFailure) continue;
      const now = new Date().toISOString();
      for (const skippedId of suite.actionIds.slice(index + 1)) {
        const skipped = snapshot.actions.find((candidate) => candidate.actionId === skippedId);
        if (!skipped) continue;
        const skippedResult: WorkspaceValidationResult = {
          resultId: randomUUID(), sessionId: snapshot.sessionId, threadId: snapshot.threadId,
          actionId: skipped.actionId, actionLabel: skipped.label, kind: skipped.kind,
          candidateFingerprint: snapshot.candidateFingerprint, outcome: "skipped",
          command: skipped.command, args: [...skipped.args], cwd: skipped.cwd,
          startedAt: now, completedAt: now, durationMs: 0,
          output: [{ seq: 1, at: now, stream: "system", text: `Skipped after '${action.label}' did not pass.` }],
          outputTruncated: false,
          evidence: skipped.artifactPaths.map((artifactPath) => ({ path: artifactPath, exists: false })),
          locations: [],
          ...(skipped.locationsFile ? { locationsFile: skipped.locationsFile } : {}),
        };
        this.results.set(skippedResult.resultId, skippedResult);
      }
      await this.persist();
      break;
    }
  }

  private async waitFor(resultId: string): Promise<WorkspaceValidationResult> {
    return new Promise((resolve) => {
      const poll = () => {
        const result = this.results.get(resultId);
        if (!result || result.outcome !== "running") return resolve(clone(result!));
        setTimeout(poll, 25);
      };
      poll();
    });
  }

  private append(resultId: string, stream: "stdout" | "stderr", text: string): void {
    const result = this.results.get(resultId);
    if (!result || result.outcome !== "running" || !text) return;
    const entry: WorkspaceValidationOutputEntry = {
      seq: (result.output.at(-1)?.seq ?? 0) + 1,
      at: new Date().toISOString(),
      stream,
      text: redactDiagnosticText(text).value,
    };
    const output = [...result.output, entry];
    let bytes = output.reduce((total, candidate) => total + Buffer.byteLength(candidate.text, "utf8"), 0);
    let truncated = result.outputTruncated;
    while (bytes > MAX_OUTPUT_BYTES && output.length > 1) {
      bytes -= Buffer.byteLength(output.shift()!.text, "utf8");
      truncated = true;
    }
    this.results.set(resultId, { ...result, output, outputTruncated: truncated });
  }

  private terminate(resultId: string): void {
    const child = this.processes.get(resultId);
    if (!child) return;
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch { /* Process already settled. */ }
    }
  }

  private async finish(resultId: string, exitCode: number | null, signal: NodeJS.Signals | null, error?: string): Promise<void> {
    const result = this.results.get(resultId);
    this.processes.delete(resultId);
    if (!result || result.outcome !== "running") return;
    const completedAt = new Date().toISOString();
    const evidence = await Promise.all(result.evidence.map(async (entry) => ({ ...entry, exists: await exists(path.join(result.cwd, entry.path)) })));
    const locations = result.locationsFile
      ? await readStructuredLocations(path.join(result.cwd, result.locationsFile))
      : [];
    this.results.set(resultId, {
      ...result,
      outcome: error || (exitCode !== 0 && signal === null) ? "failed" : signal ? "cancelled" : "passed",
      ...(exitCode !== null ? { exitCode } : {}),
      ...(signal ? { signal } : {}),
      completedAt,
      durationMs: Math.max(0, Date.parse(completedAt) - Date.parse(result.startedAt)),
      output: error
        ? [...result.output, { seq: (result.output.at(-1)?.seq ?? 0) + 1, at: completedAt, stream: "system", text: redactDiagnosticText(error).value }]
        : result.output,
      evidence,
      locations,
    });
    await this.persist();
  }

  private requireOwned(input: { sessionId: string; threadId: string; resultId: string }): WorkspaceValidationResult {
    const result = this.results.get(identifier(input.resultId, "resultId"));
    if (!result || result.sessionId !== input.sessionId || result.threadId !== input.threadId)
      throw failure("WORKSPACE_VALIDATION_RESULT_NOT_FOUND", "Validation result is unavailable.");
    return result;
  }

  private async persist(): Promise<void> {
    const retained = [...this.results.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).slice(-MAX_RESULTS);
    if (retained.length !== this.results.size) {
      this.results.clear();
      for (const result of retained) this.results.set(result.resultId, result);
    }
    const temp = `${this.metadataPath}.tmp`;
    const value: Store = { version: 1, results: retained };
    this.persistTail = this.persistTail.then(async () => {
      await writeFile(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temp, this.metadataPath);
    });
    await this.persistTail;
  }
}

async function discover(workspaceRoot: string): Promise<{ actions: WorkspaceValidationAction[]; suites: WorkspaceValidationSuite[] }> {
  const actions = new Map<string, WorkspaceValidationAction>();
  const packageJsonPath = path.join(workspaceRoot, "package.json");
  try {
    const parsed = JSON.parse(await readFile(packageJsonPath, "utf8")) as { scripts?: Record<string, unknown> };
    const manager = await packageManager(workspaceRoot);
    for (const [script, value] of Object.entries(parsed.scripts ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      if (typeof value !== "string") continue;
      const actionId = `package:${script}`;
      actions.set(actionId, {
        actionId,
        label: script,
        kind: CANONICAL_KINDS.has(script as WorkspaceValidationKind) ? (script as WorkspaceValidationKind) : "custom",
        command: manager,
        args: manager === "npm" ? ["run", script] : ["run", script],
        cwd: workspaceRoot,
        required: CANONICAL_KINDS.has(script as WorkspaceValidationKind) && script !== "setup",
        artifactPaths: [],
        source: "package_script",
      });
    }
  } catch {
    // Projects without package.json may rely entirely on explicit Kestrel config.
  }
  let configuredSuites: WorkspaceValidationSuite[] = [];
  try {
    const config = JSON.parse(await readFile(path.join(workspaceRoot, ".kestrel", "validation.json"), "utf8")) as ValidationConfig;
    if (config.version !== 1) throw failure("WORKSPACE_VALIDATION_CONFIG_INVALID", "Validation config version is unsupported.");
    for (const configured of config.actions ?? []) {
      const actionId = identifier(configured.id, "action id");
      const cwd = await containedDirectory(workspaceRoot, configured.cwd ?? ".");
      actions.set(actionId, {
        actionId,
        label: text(configured.label, "action label", 256),
        kind: validationKind(configured.kind),
        command: executable(configured.command),
        args: stringArray(configured.args ?? [], "action args", 128),
        cwd,
        required: configured.required ?? true,
        artifactPaths: relativePaths(configured.artifacts ?? []),
        ...(configured.locationsFile
          ? { locationsFile: relativePath(configured.locationsFile, "locations file") }
          : {}),
        source: "kestrel_config",
      });
    }
    configuredSuites = (config.suites ?? []).map((suite) => ({
      suiteId: identifier(suite.id, "suite id"),
      label: text(suite.label, "suite label", 256),
      actionIds: stringArray(suite.actions, "suite actions", 128),
      stopOnFailure: suite.stopOnFailure ?? true,
    }));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
  }
  const actionList = [...actions.values()];
  for (const suite of configuredSuites) {
    if (suite.actionIds.some((id) => !actions.has(id)))
      throw failure("WORKSPACE_VALIDATION_CONFIG_INVALID", `Suite '${suite.suiteId}' references an unknown action.`);
  }
  const defaultSuite: WorkspaceValidationSuite | undefined = actionList.some((action) => action.required)
    ? { suiteId: "required", label: "Required validation", actionIds: actionList.filter((action) => action.required).map((action) => action.actionId), stopOnFailure: true }
    : undefined;
  return { actions: actionList, suites: [...(defaultSuite ? [defaultSuite] : []), ...configuredSuites.filter((suite) => suite.suiteId !== "required")] };
}

async function packageManager(root: string): Promise<"pnpm" | "yarn" | "npm"> {
  if (await exists(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

async function containedDirectory(root: string, value: string): Promise<string> {
  const target = await realpath(path.resolve(root, text(value, "cwd", 4096)));
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative) || !(await stat(target)).isDirectory())
    throw failure("WORKSPACE_VALIDATION_CONFIG_INVALID", "Validation cwd escapes the workspace.");
  return target;
}

function readiness(actions: WorkspaceValidationAction[], results: WorkspaceValidationResult[], candidateFingerprint: string) {
  const required = actions.filter((action) => action.required);
  const latest = new Map<string, WorkspaceValidationResult>();
  for (const result of results) if (!latest.has(result.actionId)) latest.set(result.actionId, result);
  const current = required.map((action) => latest.get(action.actionId));
  const passed = current.filter((result) => result?.outcome === "passed" && result.candidateFingerprint === candidateFingerprint).length;
  const failed = current.filter((result) => result?.outcome === "failed").length;
  const stale = current.filter((result) => result?.outcome === "stale" || (result && result.candidateFingerprint !== candidateFingerprint)).length;
  const running = current.some((result) => result?.outcome === "running");
  const state = running ? "running" : failed > 0 ? "blocked" : stale > 0 ? "stale" : required.length > 0 && passed === required.length ? "ready" : "not_run";
  return { state, required: required.length, passed, failed, stale, message: state === "ready" ? "All required validation passed for this exact candidate." : state === "stale" ? "Validation evidence predates the current candidate." : state === "blocked" ? "Required validation failed." : state === "running" ? "Validation is running." : "Required validation has not run for this candidate." } as const;
}

function validationKind(value: unknown): WorkspaceValidationKind {
  if (value === "setup" || value === "test" || value === "lint" || value === "typecheck" || value === "build" || value === "smoke" || value === "custom") return value;
  throw failure("WORKSPACE_VALIDATION_CONFIG_INVALID", "Validation kind is invalid.");
}
function executable(value: unknown): string { const parsed = text(value, "command", 1024); if (parsed.includes("\0")) throw failure("WORKSPACE_VALIDATION_CONFIG_INVALID", "Validation command is invalid."); return parsed; }
function stringArray(value: unknown, label: string, max: number): string[] { if (!Array.isArray(value) || value.length > max) throw failure("WORKSPACE_VALIDATION_CONFIG_INVALID", `${label} is invalid.`); return value.map((entry) => text(entry, label, 4096)); }
function relativePaths(value: unknown): string[] { return stringArray(value, "artifact path", 128).map((entry) => { const normalized = entry.replaceAll("\\", "/"); if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) throw failure("WORKSPACE_VALIDATION_CONFIG_INVALID", "Artifact path escapes the action cwd."); return normalized; }); }
function relativePath(value: unknown, label: string): string { const normalized = text(value, label, 4096).replaceAll("\\", "/"); if (path.isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) throw failure("WORKSPACE_VALIDATION_CONFIG_INVALID", `${label} escapes the workspace.`); return normalized; }
function identifier(value: unknown, label: string): string { return text(value, label, 256); }
function text(value: unknown, label: string, max: number): string { if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\0")) throw failure("WORKSPACE_VALIDATION_INPUT_INVALID", `${label} is invalid.`); return value.trim(); }
function fingerprint(value: unknown): string { const parsed = text(value, "candidateFingerprint", 256); if (!/^sha256:[a-f0-9]{64}$/u.test(parsed)) throw failure("WORKSPACE_VALIDATION_INPUT_INVALID", "candidateFingerprint is invalid."); return parsed; }
async function exists(value: string): Promise<boolean> { try { await access(value); return true; } catch { return false; } }
function clone<T>(value: T): T { return structuredClone(value); }
function isResult(value: unknown): value is WorkspaceValidationResult { if (typeof value !== "object" || value === null || Array.isArray(value)) return false; const record = value as Record<string, unknown>; return typeof record.resultId === "string" && typeof record.sessionId === "string" && typeof record.threadId === "string" && typeof record.actionId === "string" && typeof record.candidateFingerprint === "string" && typeof record.outcome === "string" && Array.isArray(record.output); }
function failure(code: string, message: string): Error { return createRuntimeFailure(code, message, { subsystem: "validation", classification: "state", recoverable: true }); }

async function readStructuredLocations(filePath: string) {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    if (!Array.isArray(parsed) || parsed.length > 1000) throw new Error("invalid locations document");
    return parsed.map((value) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid location");
      const record = value as Record<string, unknown>;
      const line = Number(record.line);
      const column = record.column === undefined ? undefined : Number(record.column);
      if (!Number.isInteger(line) || line <= 0 || (column !== undefined && (!Number.isInteger(column) || column <= 0))) throw new Error("invalid location coordinates");
      return { path: relativePath(record.path, "location path"), line, ...(column !== undefined ? { column } : {}), ...(record.message !== undefined ? { message: text(record.message, "location message", 4096) } : {}) };
    });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [];
  }
}
