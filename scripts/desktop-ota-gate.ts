import path from "node:path";

import type {
  DesktopUpdateBlocker,
  DesktopUpdateState,
} from "../apps/desktop/src/contracts.js";
import type { DesktopOtaRequestLedgerEntry } from "./desktop-ota-https-server.js";

export const DESKTOP_OTA_EVIDENCE_SCHEMA = "desktop-ota-smoke-v1";

export interface DesktopOtaCleanupAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface DesktopOtaCleanupResult {
  attempted: string[];
  completed: string[];
}

export async function runDesktopOtaCleanupActions(
  actions: readonly DesktopOtaCleanupAction[],
): Promise<DesktopOtaCleanupResult> {
  const attempted: string[] = [];
  const completed: string[] = [];
  const errors: Error[] = [];
  for (const action of actions) {
    attempted.push(action.label);
    try {
      await action.run();
      completed.push(action.label);
    } catch (error) {
      errors.push(
        new Error(
          `${action.label}: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        ),
      );
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Desktop OTA smoke cleanup failed.");
  }
  return { attempted, completed };
}

export function resolveDesktopOtaInstalledAppPath(input: {
  applicationsRoot?: string | undefined;
  runId: string;
}): string {
  if (!/^[A-Za-z0-9-]+$/u.test(input.runId)) {
    throw new Error(`Invalid Desktop OTA run ID '${input.runId}'.`);
  }
  return path.join(
    path.resolve(input.applicationsRoot ?? "/Applications"),
    `Kestrel OTA Gate ${input.runId}.app`,
  );
}

export function resolveDesktopOtaRelaunchProcessIds(
  processIds: readonly number[],
  previousPid: number,
): number[] {
  if (!Number.isSafeInteger(previousPid) || previousPid <= 0) {
    throw new Error("Desktop OTA previous process ID must be a positive integer.");
  }
  return [...new Set(processIds)]
    .filter(
      (pid) =>
        Number.isSafeInteger(pid) &&
        pid > 0 &&
        pid !== previousPid,
    )
    .sort((left, right) => left - right);
}

export function assertDesktopOtaUpdateState(
  state: DesktopUpdateState,
  expected: {
    phase: DesktopUpdateState["phase"];
    currentVersion: string;
    targetVersion?: string | undefined;
  },
): void {
  if (state.phase !== expected.phase) {
    throw new Error(
      `Desktop OTA phase must be '${expected.phase}'; found '${state.phase}': ${state.message}`,
    );
  }
  if (state.currentVersion !== expected.currentVersion) {
    throw new Error(
      `Desktop OTA current version must be '${expected.currentVersion}'; found '${state.currentVersion}'.`,
    );
  }
  if (
    expected.targetVersion !== undefined &&
    state.targetVersion !== expected.targetVersion
  ) {
    throw new Error(
      `Desktop OTA target version must be '${expected.targetVersion}'; found '${String(state.targetVersion)}'.`,
    );
  }
}

export function assertDesktopOtaBusyBlocker(input: {
  state: DesktopUpdateState;
  runStillActive: boolean;
}): DesktopUpdateBlocker {
  assertDesktopOtaUpdateState(input.state, {
    phase: "blocked",
    currentVersion: input.state.currentVersion,
    targetVersion: input.state.targetVersion,
  });
  const blocker = input.state.blockers.find(
    (candidate) =>
      candidate.source === "local_core" &&
      candidate.count > 0 &&
      /PROJECT|PROCESS|RUN/u.test(candidate.code),
  );
  if (blocker === undefined) {
    throw new Error(
      `Desktop OTA install did not return a typed Local Core project-run blocker: ${
        input.state.blockers.map((candidate) => candidate.code).join(", ")
      }.`,
    );
  }
  if (!input.runStillActive) {
    throw new Error("Desktop OTA blocked install cancelled the active project run.");
  }
  return { ...blocker };
}

export function sanitizeDesktopUpdaterLog(value: string): string[] {
  const allowed = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        /electron-updater|differential|blockmap|Full:|To download:|cache|update-(?:available|downloaded)|Cannot download/u
          .test(line),
    )
    .map((line) =>
      line
        .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
        .replace(
          /(?:api[_-]?key|token|secret|client[_-]?id)=\S+/giu,
          "[REDACTED]",
        )
        .slice(0, 2_000)
    );
  return allowed.slice(-200);
}

export function shapeDesktopOtaEvidence(input: {
  sourceCommit: string;
  artifactEvidence: readonly Record<string, unknown>[];
  transitions: readonly DesktopUpdateState[];
  requestLedger: readonly DesktopOtaRequestLedgerEntry[];
  transfers: readonly Record<string, unknown>[];
  updaterLog: string;
  screenshots: readonly { version: string; path: string }[];
  blocker: DesktopUpdateBlocker;
  persistenceMarker: string;
  finalFeedUrl: string;
  cleanup: DesktopOtaCleanupResult;
}): Record<string, unknown> {
  if (!/^[a-f0-9]{40}$/u.test(input.sourceCommit)) {
    throw new Error("Desktop OTA evidence requires a full source commit SHA.");
  }
  if (input.finalFeedUrl !==
    "https://updates.lumicorp.ai/desktop/stable/arm64") {
    throw new Error("Final Desktop OTA evidence must prove the production feed URL.");
  }
  return {
    schema: DESKTOP_OTA_EVIDENCE_SCHEMA,
    capturedAt: new Date().toISOString(),
    sourceCommit: input.sourceCommit,
    artifacts: input.artifactEvidence.map((entry) => ({ ...entry })),
    updater: {
      transitions: input.transitions.map((state) => ({
        ...state,
        blockers: state.blockers.map((blocker) => ({ ...blocker })),
      })),
      log: sanitizeDesktopUpdaterLog(input.updaterLog),
    },
    https: {
      requests: input.requestLedger.map((entry) => ({ ...entry })),
      transfers: input.transfers.map((entry) => ({ ...entry })),
    },
    installationBlocker: {
      ...input.blocker,
      activeWorkPreserved: true,
    },
    persistence: {
      marker: input.persistenceMarker,
      survivedEveryRelaunch: true,
    },
    screenshots: input.screenshots.map((entry) => ({ ...entry })),
    final: {
      version: "0.7.0",
      feedUrl: input.finalFeedUrl,
    },
    cleanup: {
      attempted: [...input.cleanup.attempted],
      completed: [...input.cleanup.completed],
    },
  };
}
