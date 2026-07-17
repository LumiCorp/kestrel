import type { ModelToolSpec } from "../../../src/kestrel/contracts/model-io.js";

import { asRecord, asString } from "../../shared/valueAccess.js";
import type { LatestToolEvidence as ProcessToolState } from "./types.js";

export interface HiddenDeliberatorTool {
  name: string;
  reason: string;
  correction: string;
}

export interface DeliberatorToolAvailability {
  allowedToolNames: string[];
  hiddenTools: HiddenDeliberatorTool[];
  correction?: string | undefined;
}

export interface FilteredDeliberatorTools {
  tools: ModelToolSpec[];
  availability: DeliberatorToolAvailability;
}

export interface ManagedEntrypointToolContext {
  path: string;
  command: string;
  cwd: string;
  securityMode: "protected_entrypoint";
  requiredTransport: "kestrel_devshell.start" | "dev.process.start";
}

export interface DeliberatorToolFilterContext {
  devShellProcesses?: Record<string, unknown>[] | undefined;
  availableToolNames?: string[] | undefined;
  latestProcessToolState?: ProcessToolState | undefined;
  postToolVerification?: Record<string, unknown> | undefined;
  managedEntrypoints?: readonly ManagedEntrypointToolContext[] | undefined;
  artifactTarget?: string | undefined;
}

export function filterDeliberatorToolsForContext(
  tools: ModelToolSpec[],
  contextOrLegacyState: DeliberatorToolFilterContext | unknown = {},
  maybeContext?: DeliberatorToolFilterContext,
): FilteredDeliberatorTools {
  const context = maybeContext ?? (isDeliberatorToolFilterContext(contextOrLegacyState) ? contextOrLegacyState : {});
  const filterContext: DeliberatorToolFilterContext = {
    ...context,
    availableToolNames: context.availableToolNames ?? tools.map((tool) => tool.name),
  };
  const hiddenTools: HiddenDeliberatorTool[] = [];
  const filteredTools = tools.filter((tool) => {
    const hidden =
      readHiddenProcessStartTool(tool.name, filterContext) ??
      readHiddenDeadProcessTool(tool.name, filterContext) ??
      readHiddenManualProcessTool(tool.name, filterContext);
    if (hidden !== undefined) {
      hiddenTools.push(hidden);
      return false;
    }
    return true;
  });

  return {
    tools: filteredTools,
    availability: {
      allowedToolNames: filteredTools.map((tool) => tool.name),
      hiddenTools,
      ...(hiddenTools.length > 0 ? { correction: hiddenTools[0]?.correction } : {}),
    },
  };
}

function isDeliberatorToolFilterContext(value: unknown): value is DeliberatorToolFilterContext {
  const record = asRecord(value);
  if (record === undefined) {
    return false;
  }
  return "devShellProcesses" in record ||
    "availableToolNames" in record ||
    "latestProcessToolState" in record ||
    "postToolVerification" in record ||
    "managedEntrypoints" in record ||
    "artifactTarget" in record;
}

function readHiddenProcessStartTool(
  toolName: string,
  context: DeliberatorToolFilterContext,
): HiddenDeliberatorTool | undefined {
  if (toolName !== "dev.process.start") {
    return ;
  }
  if (managedEntrypointRequiresProcessStart(context)) {
    return ;
  }
  return {
    name: toolName,
    reason: "No managed entrypoint requires a new live process for this turn.",
    correction:
      "Use the available terminal command tool for ordinary bounded commands such as scaffolding, installs, builds, tests, dev-server smoke checks, and inspections.",
  };
}

function managedEntrypointRequiresProcessStart(context: DeliberatorToolFilterContext): boolean {
  return (context.managedEntrypoints ?? []).some((entrypoint) => entrypoint.requiredTransport === "dev.process.start");
}

function readHiddenDeadProcessTool(
  toolName: string,
  context: DeliberatorToolFilterContext,
): HiddenDeliberatorTool | undefined {
  if (
    toolName !== "dev.process.write" &&
    toolName !== "dev.process.write_and_read" &&
    toolName !== "dev.process.read" &&
    toolName !== "dev.process.stop"
  ) {
    return ;
  }
  if (hasLiveDevShellProcess(context)) {
    return ;
  }
  return {
    name: toolName,
    reason: "No live dev-shell process exists; this action cannot affect a stopped or failed process.",
    correction:
      "Use the available terminal command tool for new bounded work, or file tools instead. If a controller failed, inspect or patch the controller file and rerun it with the available terminal command tool.",
  };
}

function readHiddenManualProcessTool(
  toolName: string,
  context: DeliberatorToolFilterContext,
): HiddenDeliberatorTool | undefined {
  if (isManualDevShellProcessTool(toolName) === false || shouldHideManualProcessToolForGather(toolName, context) === false) {
    return ;
  }
  return {
    name: toolName,
    reason: readManualProcessHiddenReason(toolName, context),
    correction: readManualProcessHiddenCorrection(toolName, context),
  };
}

export function isManualDevShellProcessTool(toolName: string): boolean {
  return toolName === "dev.process.write" ||
    toolName === "dev.process.write_and_read" ||
    toolName === "dev.process.read";
}

export function isInteractiveProcessTool(toolName: string): boolean {
  return toolName === "dev.process.write" ||
    toolName === "dev.process.write_and_read" ||
    toolName === "dev.process.read" ||
    toolName === "dev.process.stop";
}

function hasLiveDevShellProcess(context: DeliberatorToolFilterContext): boolean {
  if ((context.devShellProcesses ?? []).some((process) =>
    process.live === true || normalizeStatus(asString(process.status)) === "RUNNING"
  )) {
    return true;
  }
  const devShell = asRecord(context.postToolVerification?.devShell);
  if (devShell?.activeProcessPresent === true || normalizeStatus(asString(devShell?.status)) === "RUNNING") {
    return true;
  }
  return normalizeStatus(context.latestProcessToolState?.status) === "RUNNING";
}

function normalizeStatus(value: string | undefined): string | undefined {
  return value?.trim().toUpperCase();
}

export function isHelperWorkTool(toolName: string): boolean {
  return toolName === "exec_command" ||
    toolName === "dev.process.start" ||
    toolName === "code.execute" ||
    toolName === "fs.read_text" ||
    toolName === "fs.list" ||
    toolName === "fs.search_text" ||
    toolName === "repo.trace" ||
    toolName === "fs.write_text" ||
    toolName === "fs.replace_text" ||
    toolName === "fs.mkdir" ||
    toolName === "fs.copy" ||
    toolName === "fs.move" ||
    toolName === "fs.delete";
}

export function isRunHelperContinuationTool(toolName: string): boolean {
  return toolName === "dev.process.read" || toolName === "dev.process.stop";
}

export function isHelperSourceInspectionTool(toolName: string): boolean {
  return toolName === "fs.read_text" ||
    toolName === "repo.trace" ||
    toolName === "exec_command";
}

export function isHelperSourceEditTool(toolName: string): boolean {
  return toolName === "fs.write_text" || toolName === "fs.replace_text";
}

export function isHelperRepairCheckTool(toolName: string): boolean {
  return toolName === "exec_command";
}

export function isArtifactDerivationTool(toolName: string): boolean {
  return toolName === "fs.write_text" ||
    toolName === "fs.replace_text" ||
    toolName === "code.execute";
}

export function shouldHideManualProcessToolForGather(
  toolName: string,
  context: DeliberatorToolFilterContext,
): boolean {
  const latest = context.latestProcessToolState;
  const devShell = asRecord(context.postToolVerification?.devShell);
  if (devShell?.noProgress === true) {
    return toolName === "dev.process.read";
  }
  if (latest === undefined) {
    return false;
  }
  if (latest.toolName === "dev.process.start") {
    return latestExecNeedsManualContinuation(latest) === false;
  }
  if (latest.toolName === "dev.process.read") {
    return toolName === "dev.process.read" && latestReadMadeNoProgress(latest);
  }
  if (latest.toolName === "dev.process.write") {
    if (toolName === "dev.process.write" || toolName === "dev.process.write_and_read") {
      return latestWriteNeedsRead(latest);
    }
    return false;
  }
  return true;
}

function readManualProcessHiddenReason(
  toolName: string,
  context: DeliberatorToolFilterContext,
): string {
  if (toolName === "dev.process.read" && latestProcessReadHadNoOutput(context)) {
    return "The latest read from the live process returned no new output; another unchanged read would just poll the same state.";
  }
  if (
    (toolName === "dev.process.write" || toolName === "dev.process.write_and_read") &&
    latestProcessWriteNeedsRead(context)
  ) {
    return "The latest stdin write only accepted input; read the process response before sending another stdin line.";
  }
  return "The latest process interaction result is already available; low-level stdin/read should not remain the general strategy tool.";
}

function readManualProcessHiddenCorrection(
  toolName: string,
  context: DeliberatorToolFilterContext,
): string {
  if (toolName === "dev.process.read" && latestProcessReadHadNoOutput(context)) {
    return "Do not read again unchanged. Send valid stdin to the live process, stop it, use file tools for bounded work, or start a different terminal process with the available terminal command tool.";
  }
  if (
    (toolName === "dev.process.write" || toolName === "dev.process.write_and_read") &&
    latestProcessWriteNeedsRead(context)
  ) {
    return "Use dev.process.read for the live process before sending another stdin line.";
  }
  return "Use file/code tools, stop the process, or start a different terminal process with the available terminal command tool to change the evidence tactic or create durable evidence before more stdin/read probing. Do not send controller scripts as foreground process input.";
}

function latestProcessReadHadNoOutput(context: DeliberatorToolFilterContext): boolean {
  const devShell = asRecord(context.postToolVerification?.devShell);
  if (devShell?.noProgress === true) {
    return true;
  }
  const latest = context.latestProcessToolState;
  return latest?.toolName === "dev.process.read" && latestReadMadeNoProgress(latest);
}

function latestProcessWriteNeedsRead(context: DeliberatorToolFilterContext): boolean {
  const latest = context.latestProcessToolState;
  return latest?.toolName === "dev.process.write" && latestWriteNeedsRead(latest);
}

function latestExecNeedsManualContinuation(latest: ProcessToolState): boolean {
  return normalizeStatus(latest.status) === "RUNNING" && latest.processId !== undefined;
}

function latestWriteNeedsRead(latest: ProcessToolState): boolean {
  const content = latest.content ?? latest.excerpt;
  const sent = latest.sentInputPreview;
  if (content === undefined) {
    return normalizeStatus(latest.status) === "RUNNING";
  }
  if (sent === undefined) {
    return false;
  }
  return normalizeProcessText(content) === normalizeProcessText(sent);
}

function latestReadMadeNoProgress(latest: ProcessToolState): boolean {
  const content = latest.content ?? latest.excerpt;
  return normalizeStatus(latest.status) === "RUNNING" && normalizeProcessText(content ?? "").length === 0;
}

function normalizeProcessText(value: string): string {
  return asString(value)?.replace(/\r\n/gu, "\n").trim() ?? "";
}
