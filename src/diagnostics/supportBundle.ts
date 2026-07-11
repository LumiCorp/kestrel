import type { DesktopManagedProjectRun, DesktopSettings } from "../desktopShell/contracts.js";
import {
  mergeRedactionSummaries,
  redactDiagnosticText,
  type RedactionSummary,
} from "./redaction.js";

export type SupportBundleSource =
  | "chat"
  | "ops"
  | "settings"
  | "desktop"
  | "desktop-boot"
  | "project-run";

export interface SupportBundleAppInfo {
  name: string;
  version: string;
  surface: "web" | "desktop";
  isPackaged?: boolean | undefined;
}

export interface SupportBundleStatus {
  state: string;
  title: string;
  detail: string;
}

export interface SupportBundleLogRef {
  label: string;
  path: string;
}

export interface SupportBundleError {
  code?: string | undefined;
  message: string;
}

export interface SupportBundleInput {
  source: SupportBundleSource;
  generatedAt: string;
  app: SupportBundleAppInfo;
  readiness?: SupportBundleStatus | undefined;
  settings?: Partial<DesktopSettings> | Record<string, unknown> | undefined;
  runtime?: Record<string, unknown> | undefined;
  database?: Record<string, unknown> | undefined;
  identifiers?: Record<string, string | undefined> | undefined;
  errors?: SupportBundleError[] | undefined;
  logs?: SupportBundleLogRef[] | undefined;
  projectRuns?: DesktopManagedProjectRun[] | undefined;
  extra?: Record<string, unknown> | undefined;
}

export interface SupportBundle extends Omit<SupportBundleInput, "settings" | "runtime" | "database" | "errors" | "projectRuns" | "extra"> {
  schema: "kestrel-support-bundle/v1";
  settings?: Record<string, unknown> | undefined;
  runtime?: Record<string, unknown> | undefined;
  database?: Record<string, unknown> | undefined;
  errors?: SupportBundleError[] | undefined;
  projectRuns?: Array<{
    runId: string;
    projectPath: string;
    scriptName: string;
    command: string;
    status: DesktopManagedProjectRun["status"];
    exitCode?: number | undefined;
    startedAt: string;
    updatedAt: string;
    completedAt?: string | undefined;
    stdoutTail?: string[] | undefined;
    stderrTail?: string[] | undefined;
  }> | undefined;
  extra?: Record<string, unknown> | undefined;
  redactions: RedactionSummary;
}

export function buildSupportBundle(input: SupportBundleInput): SupportBundle {
  const summaries: RedactionSummary[] = [];
  const settings = sanitizeRecord(input.settings, summaries);
  const runtime = sanitizeRecord(input.runtime, summaries);
  const database = sanitizeRecord(input.database, summaries);
  const extra = sanitizeRecord(input.extra, summaries);
  const readiness = input.readiness !== undefined
    ? {
        state: redact(input.readiness.state, summaries),
        title: redact(input.readiness.title, summaries),
        detail: redact(input.readiness.detail, summaries),
      }
    : undefined;
  const errors = input.errors?.map((error) => ({
    ...(error.code !== undefined ? { code: redact(error.code, summaries) } : {}),
    message: redact(error.message, summaries),
  }));
  const projectRuns = input.projectRuns?.map((run) => ({
    runId: run.runId,
    projectPath: redact(run.projectPath, summaries),
    scriptName: run.scriptName,
    command: redact(run.command, summaries),
    status: run.status,
    ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
    startedAt: run.startedAt,
    updatedAt: run.updatedAt,
    ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
    stdoutTail: run.stdoutTail.slice(-20).map((line) => redact(line, summaries)),
    stderrTail: run.stderrTail.slice(-20).map((line) => redact(line, summaries)),
  }));

  return {
    schema: "kestrel-support-bundle/v1",
    source: input.source,
    generatedAt: input.generatedAt,
    app: input.app,
    ...(readiness !== undefined ? { readiness } : {}),
    ...(settings !== undefined ? { settings } : {}),
    ...(runtime !== undefined ? { runtime } : {}),
    ...(database !== undefined ? { database } : {}),
    ...(input.identifiers !== undefined ? { identifiers: sanitizeIdentifiers(input.identifiers, summaries) } : {}),
    ...(errors !== undefined ? { errors } : {}),
    ...(input.logs !== undefined ? { logs: input.logs.map((log) => ({ label: log.label, path: redact(log.path, summaries) })) } : {}),
    ...(projectRuns !== undefined ? { projectRuns } : {}),
    ...(extra !== undefined ? { extra } : {}),
    redactions: mergeRedactionSummaries(summaries),
  };
}

export function serializeSupportBundle(bundle: SupportBundle): string {
  return `${bundle.schema}\n${JSON.stringify(bundle, null, 2)}`;
}

function sanitizeRecord(
  value: Record<string, unknown> | undefined,
  summaries: RedactionSummary[],
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return undefined;
  }
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }
    next[key] = sanitizeUnknown(entry, summaries);
  }
  return next;
}

function sanitizeUnknown(value: unknown, summaries: RedactionSummary[]): unknown {
  if (typeof value === "string") {
    return redact(value, summaries);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item, summaries));
  }
  if (typeof value === "object" && value !== null) {
    return sanitizeRecord(value as Record<string, unknown>, summaries);
  }
  return value;
}

function sanitizeIdentifiers(
  identifiers: Record<string, string | undefined>,
  summaries: RedactionSummary[],
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(identifiers)) {
    if (value !== undefined && value.trim().length > 0) {
      next[key] = redact(value, summaries);
    }
  }
  return next;
}

function redact(value: string, summaries: RedactionSummary[]): string {
  const result = redactDiagnosticText(value);
  summaries.push(result.summary);
  return result.value;
}
