import type {
  DesktopMissionControlActionIntent,
  DesktopMissionControlProjectResponse,
  DesktopMissionControlProjectSetup,
} from "../../src/contracts";
import type {
  MissionControlExecutionAttempt,
  MissionControlHistoryEntry,
  MissionControlWorkItem,
} from "../../../../src/missionControl/projectAuthority";
import type { MissionControlReviewBundle } from "../../../../src/missionControl/reviewContracts";

export interface MissionControlPreviewStore {
  getProject(projectId: string): Promise<DesktopMissionControlProjectResponse>;
  inspectSetup(projectId: string): DesktopMissionControlProjectSetup;
  execute(
    intent: DesktopMissionControlActionIntent,
  ): Promise<DesktopMissionControlProjectResponse>;
  subscribe(
    listener: (project: DesktopMissionControlProjectResponse) => void,
  ): () => void;
}

export function createMissionControlPreviewStore(options: {
  now?: (() => string) | undefined;
  createId?: (() => string) | undefined;
  projectPath?: ((projectId: string) => string) | undefined;
  emptyProjectIds?: ReadonlySet<string> | undefined;
} = {}): MissionControlPreviewStore {
  const projects = new Map<string, DesktopMissionControlProjectResponse>();
  const listeners = new Set<
    (project: DesktopMissionControlProjectResponse) => void
  >();
  const now = options.now ?? (() => new Date().toISOString());
  let generatedId = 0;
  const createId = options.createId ?? (() => `generated-${++generatedId}`);
  const projectPath = options.projectPath ?? (() => "/workspace/kestrel");
  const emptyProjectIds = options.emptyProjectIds ?? new Set([
    "22222222-2222-4222-8222-222222222222",
  ]);

  const getProject = async (projectId: string) => {
    const existing = projects.get(projectId);
    if (existing !== undefined) return structuredClone(existing);
    const created = await createPreviewMissionControlProject(
      projectId,
      now(),
      emptyProjectIds.has(projectId),
    );
    projects.set(projectId, created);
    return structuredClone(created);
  };

  return {
    getProject,
    inspectSetup(projectId) {
      const path = projectPath(projectId);
      return {
        projectId,
        projectPath: path,
        actions: [
          {
            actionId: "package:test",
            label: "test",
            kind: "test",
            command: "pnpm",
            args: ["run", "test"],
            cwd: path,
            required: true,
            artifactPaths: [],
            source: "package_script",
          },
          {
            actionId: "package:build",
            label: "build",
            kind: "build",
            command: "pnpm",
            args: ["run", "build"],
            cwd: path,
            required: true,
            artifactPaths: [],
            source: "package_script",
          },
        ],
        suites: [{
          suiteId: "required",
          label: "Required validation",
          actionIds: ["package:test", "package:build"],
          stopOnFailure: true,
        }],
      };
    },
    async execute(intent) {
      const next = await reducePreviewMissionControlIntent(
        await getProject(intent.projectId),
        intent,
        { now: now(), createId },
      );
      projects.set(intent.projectId, next);
      for (const listener of listeners) listener(structuredClone(next));
      return structuredClone(next);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export function createPreviewMissionControlProject(
  projectId: string,
  now: string,
  empty = false,
): Promise<DesktopMissionControlProjectResponse> {
  return createPreviewMissionControlProjectValue(projectId, now, empty);
}

async function createPreviewMissionControlProjectValue(
  projectId: string,
  now: string,
  empty: boolean,
): Promise<DesktopMissionControlProjectResponse> {
  const review = await previewReviewWorkItem(projectId, now);
  const done = await previewDoneWorkItem(projectId, now);
  const items: Record<string, MissionControlWorkItem> = empty ? {} : {
    "preview-proposed": previewWorkItem({
      id: "preview-proposed",
      title: "Improve project onboarding",
      instructions: "Review this suggestion before adding it to Ready work.",
      createdBy: "agent",
      phase: "proposed",
      order: 0,
      now,
    }),
    "preview-ready": previewWorkItem({
      id: "preview-ready",
      title: "Prepare the Desktop release",
      instructions: "Complete the project-scoped release checklist.",
      createdBy: "operator",
      phase: "ready",
      order: 1,
      now,
    }),
    "preview-active": previewWorkItem({
      id: "preview-active",
      title: "Verify Mission Control recovery",
      instructions: "Exercise disconnect, relaunch, and exact-run recovery.",
      createdBy: "operator",
      phase: "active",
      order: 1,
      now,
      attempt: createPreviewMissionControlAttempt(
        "preview-active-attempt",
        "running",
        now,
      ),
    }),
    "preview-waiting": previewWorkItem({
      id: "preview-waiting",
      title: "Confirm the release audience",
      instructions: "Prepare the release once the intended audience is confirmed.",
      createdBy: "operator",
      phase: "active",
      order: 2,
      now,
      attempt: createPreviewMissionControlAttempt(
        "preview-waiting-attempt",
        "waiting",
        now,
      ),
    }),
    "preview-needs-attention": {
      ...previewWorkItem({
        id: "preview-needs-attention",
        title: "Recover the packaging check",
        instructions: "Retry the packaging check after reviewing its failure.",
        createdBy: "operator",
        phase: "needs_attention",
        order: 0,
        now,
        attempt: createPreviewMissionControlAttempt(
          "preview-failed-attempt",
          "failed",
          now,
        ),
      }),
      attentionReason: "execution_failed",
    },
    "preview-review": review,
    "preview-done": done,
    "preview-discarded": previewWorkItem({
      id: "preview-discarded",
      title: "Retired parallel board",
      instructions: "Historical preview-only item.",
      createdBy: "agent",
      phase: "discarded",
      order: 1,
      now,
    }),
  };
  return {
    projectId,
    project: {
      projectId,
      schemaVersion: 1,
      revision: 6,
      authorityEpoch: 1,
      document: {
        schemaVersion: 1,
        projectId,
        autopilot: { enabled: false, wipLimit: 4 },
        items,
        history: [{
          actionId: "preview-history",
          actionType: "execution.accepted",
          revision: 6,
          timestamp: now,
          itemId: "preview-active",
          attemptId: "preview-active-attempt",
          disposition: "applied",
        }],
        migration: {
          version: 1,
          status: "staged_empty",
          registeredPath: "/workspace/kestrel",
          sources: [],
          candidates: [],
          rebinds: [],
          stagedAt: now,
          updatedAt: now,
        },
      },
      createdAt: now,
      updatedAt: now,
    },
  };
}

export async function reducePreviewMissionControlIntent(
  current: DesktopMissionControlProjectResponse,
  intent: DesktopMissionControlActionIntent,
  dependencies: { now: string; createId: () => string },
): Promise<DesktopMissionControlProjectResponse> {
  if (intent.expectedRevision !== current.project.revision) {
    throw new Error(
      `Mission Control project revision conflict: expected=${intent.expectedRevision} actual=${current.project.revision}.`,
    );
  }
  if (intent.type === "resequence") {
    assertCompletePhaseOrder(current, intent.targetPhase, intent.orderedItemIds);
  }
  assertPreviewIntentAllowed(current, intent);
  const next = structuredClone(current);
  const now = dependencies.now;
  next.project.revision += 1;
  next.project.updatedAt = now;
  const items = next.project.document.items;

  if (intent.type === "create") {
    const itemId = `preview-${dependencies.createId()}`;
    if (items[itemId] !== undefined) {
      throw new Error(`Preview Mission Control item already exists: ${itemId}.`);
    }
    items[itemId] = {
      id: itemId,
      title: intent.title,
      instructions: intent.instructions,
      createdBy: "operator",
      completionContract: intent.completionContract,
      ...(intent.followUpToItemId === undefined
        ? {}
        : { followUpToItemId: intent.followUpToItemId }),
      phase: "ready",
      order: Object.values(items).filter((item) => item.phase === "ready").length,
      attempts: [],
      reviewBundles: [],
      reviewDecisions: [],
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
  } else if (intent.type === "resequence") {
    intent.orderedItemIds.forEach((itemId, order) => {
      const item = items[itemId]!;
      items[itemId] = {
        ...item,
        order,
        version: item.version + 1,
        updatedAt: now,
      };
    });
  } else if (intent.type === "configure_autopilot") {
    next.project.document.autopilot = {
      enabled: intent.enabled,
      wipLimit: intent.wipLimit,
      ...(intent.enabled ? { confirmedAt: now } : {}),
    };
  } else {
    const item = items[intent.itemId];
    if (item === undefined) {
      throw new Error("Preview Mission Control item is unavailable.");
    }
    if (item.version !== intent.expectedItemVersion) {
      throw new Error("Preview Mission Control item version conflict.");
    }
    let updated: MissionControlWorkItem = { ...item, updatedAt: now };
    switch (intent.type) {
      case "update":
        updated = {
          ...updated,
          title: intent.title,
          instructions: intent.instructions,
          completionContract: intent.completionContract,
          version: item.version + 1,
        };
        break;
      case "approve":
        updated = { ...updated, phase: "ready", version: item.version + 1 };
        break;
      case "return_to_ready":
        updated = {
          ...updated,
          phase: "ready",
          attentionReason: undefined,
          version: item.version + 1,
        };
        break;
      case "discard":
        updated = { ...updated, phase: "discarded", version: item.version + 1 };
        break;
      case "restore":
        updated = { ...updated, phase: "ready", version: item.version + 1 };
        break;
      case "start":
      case "retry": {
        const attemptId = `preview-attempt-${dependencies.createId()}`;
        if (item.attempts.some((attempt) => attempt.id === attemptId)) {
          throw new Error(`Preview Mission Control attempt already exists: ${attemptId}.`);
        }
        const attempt = createPreviewMissionControlAttempt(
          attemptId,
          "running",
          now,
        );
        updated = {
          ...updated,
          phase: "active",
          attempts: [...item.attempts, attempt],
          currentAttemptId: attempt.id,
          attentionReason: undefined,
          version: item.version + 1,
        };
        break;
      }
      case "reply":
        updated = updatePreviewAttempt(updated, intent.attemptId, (attempt) => ({
          ...attempt,
          status: "running",
          pendingRequest: undefined,
          version: attempt.version + 1,
          updatedAt: now,
        }));
        updated.version += 1;
        break;
      case "stop":
        updated = updatePreviewAttempt(updated, intent.attemptId, (attempt) => ({
          ...attempt,
          status: "cancelled",
          terminalReason: "Stopped from Mission Control.",
          terminalReasonCode: "operator_stopped",
          version: attempt.version + 1,
          updatedAt: now,
        }));
        updated.phase = "needs_attention";
        updated.attentionReason = "operator_stopped";
        updated.version += 1;
        break;
      case "prepare_review": {
        const attempt = updated.attempts.find(
          (candidate) => candidate.id === intent.attemptId,
        );
        if (attempt === undefined) {
          throw new Error("Preview attempt is unavailable.");
        }
        const bundle = await createPreviewReviewBundle(
          next.projectId,
          updated,
          attempt,
          now,
        );
        updated = {
          ...updated,
          phase: "review",
          reviewBundles: [...(updated.reviewBundles ?? []), bundle],
          currentReviewBundleId: bundle.id,
          version: item.version + 1,
        };
        break;
      }
      case "accept":
        updated = {
          ...updated,
          phase: "done",
          reviewDecisions: [
            ...(updated.reviewDecisions ?? []),
            acceptedDecision(next.projectId, item.id, intent, now, next.project.revision),
          ],
          version: item.version + 1,
        };
        break;
      case "request_changes":
        updated = {
          ...updated,
          phase: "ready",
          currentReviewBundleId: undefined,
          reviewDecisions: [
            ...(updated.reviewDecisions ?? []),
            {
              decision: "changes_requested",
              projectId: next.projectId,
              itemId: item.id,
              attemptId: intent.attemptId,
              candidateFingerprint: intent.candidateFingerprint,
              bundleId: intent.bundleId,
              operatorId: "preview-operator",
              actionId: `preview-action-${next.project.revision}`,
              decidedAt: now,
              ...(intent.reason === undefined ? {} : { reason: intent.reason }),
            },
          ],
          version: item.version + 1,
        };
        break;
    }
    items[item.id] = updated;
  }

  next.project.document.history.push({
    actionId: `preview-action-${next.project.revision}`,
    actionType: previewHistoryActionType(intent.type),
    revision: next.project.revision,
    timestamp: now,
    ...("itemId" in intent ? { itemId: intent.itemId } : {}),
  });
  return next;
}

function assertPreviewIntentAllowed(
  current: DesktopMissionControlProjectResponse,
  intent: DesktopMissionControlActionIntent,
): void {
  const items = current.project.document.items;
  if (intent.type === "create") {
    if (intent.followUpToItemId !== undefined) {
      const source = items[intent.followUpToItemId];
      if (source === undefined || source.phase !== "done") {
        throw new Error("A preview Mission Control follow-up must reference existing Done work.");
      }
    }
    return;
  }
  if (intent.type === "resequence") return;
  if (intent.type === "configure_autopilot") {
    if (intent.enabled && intent.confirmed === false) {
      throw new Error("Enabling preview Mission Control Autopilot requires explicit confirmation.");
    }
    if (Number.isSafeInteger(intent.wipLimit) === false || intent.wipLimit < 1) {
      throw new Error("Preview Mission Control WIP limit must be a positive integer.");
    }
    return;
  }

  const item = items[intent.itemId];
  if (item === undefined) {
    throw new Error("Preview Mission Control item is unavailable.");
  }
  if (item.version !== intent.expectedItemVersion) {
    throw new Error("Preview Mission Control item version conflict.");
  }

  switch (intent.type) {
    case "update":
      if (
        (item.phase !== "proposed" && item.phase !== "ready") ||
        item.attempts.length > 0
      ) {
        throw new Error("Preview work can be edited only before its first run while Proposed or Ready.");
      }
      return;
    case "approve":
      requirePreviewPhase(item, "proposed", "Only Proposed preview work can be approved.");
      return;
    case "return_to_ready":
      requirePreviewPhase(item, "needs_attention", "Only Needs attention preview work can return to Ready.");
      return;
    case "discard":
      if (
        item.phase !== "proposed" &&
        item.phase !== "ready" &&
        item.phase !== "needs_attention"
      ) {
        throw new Error("Only Proposed, Ready, or Needs attention preview work can be discarded.");
      }
      return;
    case "restore":
      requirePreviewPhase(item, "discarded", "Only discarded preview work can be restored.");
      return;
    case "start":
      requirePreviewPhase(item, "ready", "Preview execution can start only from Ready.");
      if (item.currentAttemptId !== undefined) {
        const attempt = item.attempts.find(
          (candidate) => candidate.id === item.currentAttemptId,
        );
        if (attempt !== undefined && isActivePreviewAttempt(attempt)) {
          throw new Error("Preview work already has unresolved execution.");
        }
      }
      if (activePreviewWorkCount(current) >= current.project.document.autopilot.wipLimit) {
        throw new Error("Preview Mission Control project WIP limit has been reached.");
      }
      return;
    case "retry": {
      requirePreviewPhase(item, "needs_attention", "Preview retry requires Needs attention.");
      const attempt = requirePreviewCurrentAttempt(item);
      if (
        attempt.status !== "failed" &&
        attempt.status !== "orphaned" &&
        attempt.status !== "cancelled"
      ) {
        throw new Error("Only failed, orphaned, or stopped preview attempts can be retried.");
      }
      if (currentPreviewRun(attempt) === undefined) {
        throw new Error("Preview retry requires an authoritative prior thread.");
      }
      if (activePreviewWorkCount(current) >= current.project.document.autopilot.wipLimit) {
        throw new Error("Preview Mission Control project WIP limit has been reached.");
      }
      return;
    }
    case "reply": {
      const attempt = requirePreviewAttempt(item, intent);
      requirePreviewCurrentAttemptIdentity(item, attempt);
      const run = currentPreviewRun(attempt);
      if (
        attempt.status !== "waiting" ||
        attempt.pendingRequest?.requestId !== intent.requestId ||
        run === undefined ||
        run.threadId !== attempt.pendingRequest.threadId
      ) {
        throw new Error("Preview reply must target the exact current pending request.");
      }
      return;
    }
    case "stop": {
      const attempt = requirePreviewAttempt(item, intent);
      requirePreviewCurrentAttemptIdentity(item, attempt);
      const run = currentPreviewRun(attempt);
      if (
        run === undefined ||
        run.runId !== intent.runId ||
        run.commandId !== intent.commandId
      ) {
        throw new Error("Preview Stop must target the exact current run.");
      }
      if (attempt.status !== "running" && attempt.status !== "waiting") {
        throw new Error("Only Running or Waiting preview work can be stopped.");
      }
      return;
    }
    case "prepare_review": {
      requirePreviewPhase(item, "active", "Preview Review can admit evidence only from Active.");
      const attempt = requirePreviewAttempt(item, intent);
      requirePreviewCompletedCurrentAttempt(item, attempt);
      return;
    }
    case "accept":
    case "request_changes": {
      requirePreviewPhase(
        item,
        "review",
        intent.type === "accept"
          ? "Preview acceptance is available only from Review."
          : "Changes can be requested only from preview Review.",
      );
      const attempt = requirePreviewAttempt(item, intent);
      requirePreviewCompletedCurrentAttempt(item, attempt);
      const bundle = item.reviewBundles?.find(
        (candidate) => candidate.id === intent.bundleId,
      );
      if (
        item.currentReviewBundleId !== intent.bundleId ||
        bundle === undefined ||
        bundle.attemptId !== attempt.id ||
        bundle.candidate.candidateFingerprint !== intent.candidateFingerprint
      ) {
        throw new Error("Preview Review action must name the exact current candidate and bundle.");
      }
      return;
    }
  }
}

function requirePreviewPhase(
  item: MissionControlWorkItem,
  phase: MissionControlWorkItem["phase"],
  message: string,
): void {
  if (item.phase !== phase) throw new Error(message);
}

function requirePreviewAttempt(
  item: MissionControlWorkItem,
  intent: Extract<
    DesktopMissionControlActionIntent,
    { attemptId: string }
  >,
): MissionControlExecutionAttempt {
  const attempt = item.attempts.find((candidate) => candidate.id === intent.attemptId);
  if (attempt === undefined) throw new Error("Preview attempt is unavailable.");
  if (attempt.version !== intent.expectedAttemptVersion) {
    throw new Error("Preview Mission Control attempt version conflict.");
  }
  return attempt;
}

function requirePreviewCurrentAttempt(
  item: MissionControlWorkItem,
): MissionControlExecutionAttempt {
  const attempt = item.currentAttemptId === undefined
    ? undefined
    : item.attempts.find((candidate) => candidate.id === item.currentAttemptId);
  if (attempt === undefined) throw new Error("Preview work has no current execution attempt.");
  return attempt;
}

function requirePreviewCurrentAttemptIdentity(
  item: MissionControlWorkItem,
  attempt: MissionControlExecutionAttempt,
): void {
  if (item.currentAttemptId !== attempt.id) {
    throw new Error("Preview action cannot target a stale execution attempt.");
  }
}

function requirePreviewCompletedCurrentAttempt(
  item: MissionControlWorkItem,
  attempt: MissionControlExecutionAttempt,
): void {
  requirePreviewCurrentAttemptIdentity(item, attempt);
  if (attempt.status !== "completed" || currentPreviewRun(attempt) === undefined) {
    throw new Error("Preview Review requires the completed current implementation attempt.");
  }
}

function currentPreviewRun(attempt: MissionControlExecutionAttempt) {
  return attempt.currentRunId === undefined
    ? undefined
    : attempt.runs.find((run) => run.runId === attempt.currentRunId);
}

function activePreviewWorkCount(
  current: DesktopMissionControlProjectResponse,
): number {
  return Object.values(current.project.document.items).filter((item) => {
    const attempt = item.currentAttemptId === undefined
      ? undefined
      : item.attempts.find((candidate) => candidate.id === item.currentAttemptId);
    return attempt !== undefined && isActivePreviewAttempt(attempt);
  }).length;
}

function isActivePreviewAttempt(
  attempt: MissionControlExecutionAttempt,
): boolean {
  return attempt.status === "starting" ||
    attempt.status === "running" ||
    attempt.status === "waiting" ||
    attempt.status === "cancelling";
}

function assertCompletePhaseOrder(
  current: DesktopMissionControlProjectResponse,
  phase: MissionControlWorkItem["phase"],
  orderedItemIds: string[],
): void {
  const actualIds = Object.values(current.project.document.items)
    .filter((item) => item.phase === phase)
    .map((item) => item.id);
  const supplied = new Set(orderedItemIds);
  if (
    supplied.size !== orderedItemIds.length ||
    actualIds.length !== orderedItemIds.length ||
    actualIds.some((itemId) => supplied.has(itemId) === false)
  ) {
    throw new Error("Preview resequencing requires the complete current phase set.");
  }
}

function previewWorkItem(input: {
  id: string;
  title: string;
  instructions: string;
  createdBy: "operator" | "agent";
  phase: MissionControlWorkItem["phase"];
  order: number;
  now: string;
  attempt?: MissionControlExecutionAttempt | undefined;
}): MissionControlWorkItem {
  return {
    id: input.id,
    title: input.title,
    instructions: input.instructions,
    createdBy: input.createdBy,
    completionContract: previewCompletionContract(),
    phase: input.phase,
    order: input.order,
    attempts: input.attempt === undefined ? [] : [input.attempt],
    ...(input.attempt === undefined ? {} : { currentAttemptId: input.attempt.id }),
    reviewBundles: [],
    reviewDecisions: [],
    version: input.attempt === undefined ? 1 : 2,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

async function previewReviewWorkItem(
  projectId: string,
  now: string,
): Promise<MissionControlWorkItem> {
  const attempt = createPreviewMissionControlAttempt(
    "preview-review-attempt",
    "completed",
    now,
  );
  const item = previewWorkItem({
    id: "preview-review",
    title: "Inspect the frozen candidate",
    instructions: "Review candidate-bound proof before acceptance.",
    createdBy: "agent",
    phase: "review",
    order: 1,
    now,
    attempt,
  });
  const bundle = await createPreviewReviewBundle(projectId, item, attempt, now);
  return { ...item, reviewBundles: [bundle], currentReviewBundleId: bundle.id };
}

async function previewDoneWorkItem(
  projectId: string,
  now: string,
): Promise<MissionControlWorkItem> {
  const attempt = createPreviewMissionControlAttempt(
    "preview-done-attempt",
    "completed",
    now,
  );
  const item = previewWorkItem({
    id: "preview-done",
    title: "Document the Desktop recovery path",
    instructions: "Publish the accepted recovery guidance.",
    createdBy: "operator",
    phase: "done",
    order: 0,
    now,
    attempt,
  });
  const bundle = await createPreviewReviewBundle(projectId, item, attempt, now);
  return {
    ...item,
    reviewBundles: [bundle],
    currentReviewBundleId: bundle.id,
    reviewDecisions: [{
      decision: "accepted",
      projectId,
      itemId: item.id,
      attemptId: attempt.id,
      candidateFingerprint: bundle.candidate.candidateFingerprint,
      bundleId: bundle.id,
      operatorId: "preview-operator",
      actionId: "preview-done-accept",
      decidedAt: now,
    }],
    version: item.version + 1,
  };
}

function createPreviewMissionControlAttempt(
  id: string,
  status: MissionControlExecutionAttempt["status"],
  now: string,
): MissionControlExecutionAttempt {
  const sessionId = `preview-session-${id}`;
  const runId = `preview-run-${id}`;
  return {
    id,
    generation: 1,
    initiatedBy: "operator",
    status,
    version: 1,
    profileId: "desktop",
    requestedSessionId: sessionId,
    requestedThreadId: `thread-main:${sessionId}`,
    dispatchCommandId: `preview-command-${id}`,
    dispatchRunId: runId,
    currentRunId: runId,
    runs: [{
      sessionId,
      threadId: `thread-main:${sessionId}`,
      runId,
      commandId: `preview-command-${id}`,
      acceptedAt: now,
    }],
    ...(status === "waiting"
      ? {
          pendingRequest: {
            requestId: `preview-request-${id}`,
            threadId: `thread-main:${sessionId}`,
            kind: "user_input" as const,
            enteredAt: now,
          },
        }
      : {}),
    ...(status === "failed" || status === "cancelled" || status === "orphaned"
      ? {
          terminalReason: status === "failed"
            ? "The packaging check exited before producing the expected output."
            : "The preview attempt ended before completion.",
          terminalReasonCode: `preview_${status}`,
        }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
}

async function createPreviewReviewBundle(
  projectId: string,
  item: MissionControlWorkItem,
  attempt: MissionControlExecutionAttempt,
  now: string,
): Promise<MissionControlReviewBundle> {
  const fingerprint = `sha256:${"a".repeat(64)}`;
  const run = attempt.runs.at(-1)!;
  const content: Omit<MissionControlReviewBundle, "id"> = {
    projectId,
    itemId: item.id,
    attemptId: attempt.id,
    candidate: {
      workspaceRoot: "/workspace/kestrel",
      candidateFingerprint: fingerprint,
    },
    contract: item.completionContract ?? previewCompletionContract(),
    evidence: [
      {
        kind: "execution",
        owner: "runtime",
        referenceId: run.commandId,
        sessionId: run.sessionId,
        threadId: run.threadId,
        runId: run.runId,
        outcome: "completed",
      },
      {
        kind: "change",
        owner: "workspace_changes",
        referenceId: fingerprint,
        workspaceRoot: "/workspace/kestrel",
        candidateFingerprint: fingerprint,
        outcome: "changes",
      },
      ...["package:test", "package:build"].map((actionId) => ({
        kind: "validation" as const,
        owner: "workspace_validation" as const,
        referenceId: `preview-result-${actionId}`,
        candidateFingerprint: fingerprint,
        actionId,
        outcome: "passed" as const,
      })),
    ],
    actionId: "preview-review-admit",
    frozenAt: now,
  };
  return {
    id: `sha256:${await sha256(stableJson(content))}`,
    ...content,
  };
}

function acceptedDecision(
  projectId: string,
  itemId: string,
  intent: Extract<
    DesktopMissionControlActionIntent,
    { candidateFingerprint: string }
  >,
  now: string,
  revision: number,
) {
  return {
    decision: "accepted" as const,
    projectId,
    itemId,
    attemptId: intent.attemptId,
    candidateFingerprint: intent.candidateFingerprint,
    bundleId: intent.bundleId,
    operatorId: "preview-operator",
    actionId: `preview-action-${revision}`,
    decidedAt: now,
  };
}

function updatePreviewAttempt(
  item: MissionControlWorkItem,
  attemptId: string,
  update: (attempt: MissionControlExecutionAttempt) => MissionControlExecutionAttempt,
): MissionControlWorkItem {
  if (item.attempts.some((attempt) => attempt.id === attemptId) === false) {
    throw new Error("Preview attempt is unavailable.");
  }
  return {
    ...item,
    attempts: item.attempts.map((attempt) =>
      attempt.id === attemptId ? update(attempt) : attempt),
  };
}

function previewCompletionContract(): Extract<
  DesktopMissionControlActionIntent,
  { type: "create" }
>["completionContract"] {
  return {
    workType: "code",
    changeOutcome: "changes",
    validation: {
      mode: "required",
      actionIds: ["package:test", "package:build"],
    },
    requiredEvidence: [],
  };
}

function previewHistoryActionType(
  type: DesktopMissionControlActionIntent["type"],
): MissionControlHistoryEntry["actionType"] {
  switch (type) {
    case "create": return "item.create";
    case "update": return "item.update";
    case "resequence": return "item.resequence";
    case "approve": return "item.approve";
    case "return_to_ready": return "item.return_to_ready";
    case "discard": return "item.discard";
    case "restore": return "item.restore";
    case "start": return "execution.start";
    case "retry": return "execution.retry";
    case "reply": return "execution.reply";
    case "stop": return "execution.stop";
    case "prepare_review": return "review.admit";
    case "accept": return "review.accept";
    case "request_changes": return "review.request_changes";
    case "configure_autopilot": return "autopilot.configure";
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}
