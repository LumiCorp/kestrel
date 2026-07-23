import type {
  DesktopManagedProjectRun,
  DesktopPreviewDiagnostic,
} from "../../src/contracts";

export type PreviewLifecycleAction = "start" | "stop" | "restart";
export type PreviewLifecyclePendingAction =
  | PreviewLifecycleAction
  | undefined;
export type PreviewDiagnosticSeverity = "info" | "warning" | "error";

export interface PreviewLifecyclePresentation {
  action: PreviewLifecycleAction;
  label: string;
  disabled: boolean;
}

export interface PreviewActivityEntry {
  at: string;
  kind: "lifecycle" | "preview_url" | "browser";
  severity: PreviewDiagnosticSeverity;
  label: string;
  detail?: string | undefined;
}

export function resolveActivePreviewRuns(
  runs: readonly DesktopManagedProjectRun[],
): {
  activeRun?: DesktopManagedProjectRun | undefined;
  otherActiveRuns: DesktopManagedProjectRun[];
} {
  const active = runs
    .filter((run) => run.status === "running" || run.status === "stopping")
    .slice()
    .sort(compareRunsNewestFirst);
  return {
    activeRun: active[0],
    otherActiveRuns: active.slice(1),
  };
}

export function presentPreviewLifecycle(input: {
  run?: DesktopManagedProjectRun | undefined;
  scriptName: string;
  pendingAction?: PreviewLifecyclePendingAction;
}): PreviewLifecyclePresentation {
  if (input.pendingAction === "start") {
    return { action: "start", label: "Starting…", disabled: true };
  }
  if (input.pendingAction === "restart") {
    return { action: "restart", label: "Restarting…", disabled: true };
  }
  if (input.pendingAction === "stop") {
    return { action: "stop", label: "Stopping…", disabled: true };
  }
  if (input.run?.status === "running") {
    return { action: "stop", label: "Stop", disabled: false };
  }
  if (input.run?.status === "stopping") {
    return { action: "stop", label: "Stopping…", disabled: true };
  }
  if (input.run !== undefined) {
    return {
      action: "restart",
      label: `Restart ${input.run.scriptName}`,
      disabled: false,
    };
  }
  return {
    action: "start",
    label: input.scriptName ? `Start ${input.scriptName}` : "Start",
    disabled: input.scriptName.length === 0,
  };
}

export function previewRunSummary(
  run: DesktopManagedProjectRun | undefined,
  pendingAction?: PreviewLifecyclePendingAction,
  previewUrl?: string | undefined,
  scriptName?: string | undefined,
): string {
  if (pendingAction === "start" || pendingAction === "restart") {
    return `Starting ${scriptName ?? run?.scriptName ?? "preview"}…`;
  }
  if (pendingAction === "stop" || run?.status === "stopping") {
    return "Stopping…";
  }
  if (run === undefined) return "Not running";
  if (run.status === "running") {
    const readyUrl = previewUrl ?? run.primaryPreviewUrl;
    return readyUrl
      ? `Ready · ${formatPreviewOrigin(readyUrl)}`
      : `Starting ${run.scriptName}…`;
  }
  if (run.status === "failed") {
    return run.exitCode === undefined
      ? "Failed"
      : `Failed · exit ${run.exitCode}`;
  }
  if (run.status === "completed") {
    return run.exitCode === undefined
      ? "Completed"
      : `Completed · exit ${run.exitCode}`;
  }
  return "Stopped";
}

export function formatPreviewOrigin(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function formatPreviewElapsed(
  startedAt: string,
  endedAt: string | number | Date = Date.now(),
): string {
  const started = new Date(startedAt).getTime();
  const ended = new Date(endedAt).getTime();
  if (!Number.isFinite(started) || !Number.isFinite(ended)) return "—";
  const totalSeconds = Math.max(0, Math.floor((ended - started) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function previewDiagnosticSeverity(
  diagnostic: DesktopPreviewDiagnostic,
): PreviewDiagnosticSeverity {
  if (
    diagnostic.kind === "network_error" ||
    diagnostic.kind === "load_error" ||
    (diagnostic.kind === "console" &&
      typeof diagnostic.level === "number" &&
      diagnostic.level >= 3)
  ) {
    return "error";
  }
  if (
    diagnostic.kind === "console" &&
    typeof diagnostic.level === "number" &&
    diagnostic.level === 2
  ) {
    return "warning";
  }
  return "info";
}

export function projectPreviewActivity(
  run: DesktopManagedProjectRun | undefined,
  diagnostics: readonly DesktopPreviewDiagnostic[],
): PreviewActivityEntry[] {
  if (run === undefined) {
    return diagnostics.map(projectDiagnostic);
  }
  const entries: PreviewActivityEntry[] = [
    {
      at: run.startedAt,
      kind: "lifecycle",
      severity: "info",
      label: `${run.scriptName} started`,
      detail: run.command,
    },
    ...(run.previewUrls ?? []).map((preview) => ({
      at: preview.firstSeenAt,
      kind: "preview_url" as const,
      severity: "info" as const,
      label: "Preview URL detected",
      detail: preview.url,
    })),
    ...diagnostics.map(projectDiagnostic),
  ];
  if (run.status !== "running" && run.status !== "stopping") {
    entries.push({
      at: run.completedAt ?? run.updatedAt,
      kind: "lifecycle",
      severity: run.status === "failed" ? "error" : "info",
      label:
        run.status === "failed"
          ? run.exitCode === undefined
            ? "Run failed"
            : `Run failed with exit ${run.exitCode}`
          : run.status === "completed"
            ? "Run completed"
            : "Run stopped",
    });
  } else if (run.status === "stopping") {
    entries.push({
      at: run.updatedAt,
      kind: "lifecycle",
      severity: "info",
      label: "Stopping run",
    });
  }
  return entries.sort((left, right) => left.at.localeCompare(right.at));
}

export function defaultPreviewDrawerOpen(input: {
  run?: DesktopManagedProjectRun | undefined;
  diagnostics: readonly DesktopPreviewDiagnostic[];
  pendingAction?: PreviewLifecyclePendingAction;
}): boolean {
  if (
    input.pendingAction === "start" ||
    input.pendingAction === "restart" ||
    input.run?.status === "stopping"
  ) {
    return true;
  }
  if (input.run?.status === "failed") return true;
  if (
    input.diagnostics.some(
      (diagnostic) => previewDiagnosticSeverity(diagnostic) !== "info",
    )
  ) {
    return true;
  }
  return input.run?.status === "running" && !input.run.primaryPreviewUrl;
}

function projectDiagnostic(
  diagnostic: DesktopPreviewDiagnostic,
): PreviewActivityEntry {
  return {
    at: diagnostic.at,
    kind: "browser",
    severity: previewDiagnosticSeverity(diagnostic),
    label:
      diagnostic.kind === "console"
        ? "Browser console"
        : diagnostic.kind === "network_error"
          ? "Network request failed"
          : "Preview failed to load",
    detail: diagnostic.url
      ? `${diagnostic.message} · ${diagnostic.url}`
      : diagnostic.message,
  };
}

function compareRunsNewestFirst(
  left: DesktopManagedProjectRun,
  right: DesktopManagedProjectRun,
): number {
  return (
    new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime()
  );
}
