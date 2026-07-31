import {
  AlertTriangle,
  ArrowLeft,
  ExternalLink,
  Kanban,
  List,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";

import type {
  DesktopMissionControlActionIntent,
  DesktopMissionControlMigrationIntent,
  DesktopMissionControlProjectResponse,
  DesktopProjectRegistration,
} from "../../src/contracts";
import type { MissionControlMigrationState } from "../../../../src/missionControl/migrationContracts";
import type {
  MissionControlExecutionAttempt,
  MissionControlHistoryEntry,
  MissionControlWorkItem,
  MissionControlWorkPhase,
} from "../../../../src/missionControl/projectAuthority";

type MissionControlView = "list" | "kanban";
type MissionControlInspectorIntent =
  DesktopMissionControlActionIntent extends infer T
    ? T extends DesktopMissionControlActionIntent
      ? Omit<T, "projectId" | "expectedRevision">
      : never
    : never;

const PHASES: ReadonlyArray<{
  phase: Exclude<MissionControlWorkPhase, "discarded">;
  label: string;
}> = [
  { phase: "proposed", label: "Proposed" },
  { phase: "ready", label: "Ready" },
  { phase: "active", label: "Active" },
  { phase: "needs_attention", label: "Needs attention" },
  { phase: "review", label: "Review" },
  { phase: "done", label: "Done" },
];

const PHASE_ORDER = new Map(
  [...PHASES, { phase: "discarded" as const, label: "Discarded" }].map(
    (entry, index) => [entry.phase, index],
  ),
);

interface UnifiedMissionControlWorkspaceProps {
  project: DesktopProjectRegistration & { id: string };
  onReturnToConversation: () => void;
  onOpenConversation: (sessionId: string) => void;
  onStartConversation: (projectPath: string) => void;
  onError: (message: string | undefined) => void;
}

export function isUnifiedMissionControlProjectEnabled(
  projectId: string | undefined,
  search: string,
): projectId is string {
  if (projectId === undefined) return false;
  return new URLSearchParams(search).get("mission-control-project")
    === projectId;
}

export function UnifiedMissionControlWorkspace({
  project,
  onReturnToConversation,
  onOpenConversation,
  onStartConversation,
  onError,
}: UnifiedMissionControlWorkspaceProps) {
  const [response, setResponse] =
    useState<DesktopMissionControlProjectResponse>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [commanding, setCommanding] = useState(false);
  const [commandError, setCommandError] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const [view, setView] = useState<MissionControlView>("list");
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string>();

  useEffect(() => {
    setResponse(undefined);
    setSelectedItemId(undefined);
    setView("list");
    setShowDiscarded(false);
    setCommandError(undefined);
  }, [project.id]);

  useEffect(() => {
    let disposed = false;
    if (response === undefined) setLoading(true);
    else setRefreshing(true);
    void window.kestrelDesktop.getMissionControlProject(project.id)
      .then(async (next) => {
        const authoritative =
          next.project.document.migration === undefined
            ? await window.kestrelDesktop.executeMissionControlMigration({
                type: "stage",
                projectId: project.id,
                expectedRevision: next.project.revision,
              })
            : next;
        if (disposed) return;
        setResponse(authoritative);
        setCommandError(undefined);
        onError(undefined);
      })
      .catch((error) => {
        if (disposed) return;
        const message = errorMessage(error);
        setCommandError(message);
        onError(message);
      })
      .finally(() => {
        if (disposed) return;
        setLoading(false);
        setRefreshing(false);
      });
    return () => {
      disposed = true;
    };
  }, [onError, project.id, reloadKey]);

  const allItems = useMemo(
    () =>
      Object.values(response?.project.document.items ?? {}).sort(compareItems),
    [response],
  );
  const visibleItems = useMemo(
    () =>
      showDiscarded
        ? allItems
        : allItems.filter((item) => item.phase !== "discarded"),
    [allItems, showDiscarded],
  );
  const selectedItem =
    allItems.find((item) => item.id === selectedItemId);
  const migration = response?.project.document.migration;
  const autopilotStatus = missionControlAutopilotStatus(
    response,
    allItems,
  );

  const executeMigration = async (
    buildIntent: (
      projectId: string,
      expectedRevision: number,
    ) => DesktopMissionControlMigrationIntent,
  ) => {
    if (response === undefined) return;
    setMigrating(true);
    try {
      const next = await window.kestrelDesktop.executeMissionControlMigration(
        buildIntent(project.id, response.project.revision),
      );
      setResponse(next);
      setCommandError(undefined);
      onError(undefined);
    } catch (error) {
      const message = errorMessage(error);
      setCommandError(message);
      onError(message);
    } finally {
      setMigrating(false);
    }
  };

  const executeAction = async (
    buildIntent: (
      projectId: string,
      expectedRevision: number,
    ) => DesktopMissionControlActionIntent,
  ) => {
    if (response === undefined) return;
    setCommanding(true);
    try {
      const next = await window.kestrelDesktop.executeMissionControlAction(
        buildIntent(project.id, response.project.revision),
      );
      setResponse(next);
      setCommandError(undefined);
      onError(undefined);
    } catch (error) {
      const message = errorMessage(error);
      setCommandError(message);
      onError(message);
    } finally {
      setCommanding(false);
    }
  };

  useEffect(() => {
    if (selectedItemId !== undefined) return;
    const first = visibleItems[0];
    if (first !== undefined) setSelectedItemId(first.id);
  }, [selectedItemId, visibleItems]);

  return (
    <main className="surface-pane unified-mission-control" id="app-main">
      <header className="surface-header unified-mission-header">
        <button
          className="icon-button"
          type="button"
          title="Back to Conversation"
          aria-label="Back to Conversation"
          onClick={onReturnToConversation}
        >
          <ArrowLeft size={17} />
        </button>
        <div>
          <h1>Mission Control</h1>
          <p>{project.label}</p>
        </div>
        <div className="unified-mission-authority">
          <span>
            {response?.project.authorityEpoch === 0
              ? "Legacy authority · read-only"
              : `Canonical authority · epoch ${response?.project.authorityEpoch}`}
          </span>
          <code>{project.id}</code>
        </div>
        <button
          className="icon-button"
          type="button"
          title="Refresh Mission Control"
          aria-label="Refresh Mission Control"
          disabled={refreshing}
          onClick={() => setReloadKey((value) => value + 1)}
        >
          <RefreshCw
            className={refreshing ? "spin" : undefined}
            size={16}
          />
        </button>
      </header>

      <section className="unified-mission-toolbar">
        <div className="mission-view-tabs" aria-label="Mission Control views">
          <button
            type="button"
            className={view === "list" ? "active" : ""}
            onClick={() => setView("list")}
          >
            <List size={15} />
            List
          </button>
          <button
            type="button"
            className={view === "kanban" ? "active" : ""}
            onClick={() => setView("kanban")}
          >
            <Kanban size={15} />
            Kanban
          </button>
        </div>
        <label className="show-discarded-control">
          <input
            type="checkbox"
            checked={showDiscarded}
            onChange={(event) => setShowDiscarded(event.target.checked)}
          />
          Show discarded
        </label>
      </section>

      <section className="unified-mission-status" aria-live="polite">
        <span>
          Autopilot {response?.project.document.autopilot.enabled === true
            ? "on"
            : "off"}
        </span>
        <span>
          WIP {activeItemCount(allItems)} /{" "}
          {response?.project.document.autopilot.wipLimit ?? 1}
        </span>
        <span>{visibleItems.length} visible items</span>
        <span>{autopilotStatus}</span>
        {refreshing ? <span>Reconnecting to project authority…</span> : null}
      </section>

      <MissionControlAutopilotControl
        enabled={response?.project.document.autopilot.enabled === true}
        wipLimit={response?.project.document.autopilot.wipLimit ?? 1}
        disabled={
          commanding ||
          response === undefined ||
          response.project.authorityEpoch === 0
        }
        onConfigure={(enabled, wipLimit, confirmed) =>
          executeAction((projectId, expectedRevision) => ({
            type: "configure_autopilot",
            projectId,
            expectedRevision,
            enabled,
            wipLimit,
            confirmed,
          }))}
      />
      <MissionControlCreateControl
        disabled={
          commanding ||
          response === undefined ||
          response.project.authorityEpoch === 0
        }
        onCreate={(title, instructions, completionContract) =>
          executeAction((projectId, expectedRevision) => ({
            type: "create",
            projectId,
            expectedRevision,
            title,
            instructions,
            completionContract,
          }))}
      />

      {migration !== undefined && response?.project.authorityEpoch === 0 ? (
        <MissionControlMigrationPanel
          migration={migration}
          disabled={migrating}
          onClear={() =>
            executeMigration((projectId, expectedRevision) => ({
              type: "clear",
              projectId,
              expectedRevision,
            }))}
          onRebind={(sourceId, sourceFingerprint) =>
            executeMigration((projectId, expectedRevision) => ({
              type: "rebind",
              projectId,
              expectedRevision,
              sourceId,
              sourceFingerprint,
            }))}
          onResolve={(candidateId) =>
            executeMigration((projectId, expectedRevision) => ({
              type: "resolve",
              projectId,
              expectedRevision,
              resolution: { type: "source", candidateId },
            }))}
          onActivate={() =>
            executeAction((projectId, expectedRevision) => ({
              type: "activate",
              projectId,
              expectedRevision,
            }))}
        />
      ) : null}
      {response !== undefined && response.project.authorityEpoch > 0 ? (
        <section className="unified-mission-migration">
          <div>
            <strong>Canonical Mission Control is active</strong>
            <span>Legacy project rows are frozen. Commands use project UUID authority.</span>
          </div>
          <button
            type="button"
            disabled={commanding || activeItemCount(allItems) > 0}
            onClick={() =>
              executeAction((projectId, expectedRevision) => ({
                type: "rollback",
                projectId,
                expectedRevision,
              }))}
          >
            Roll back project authority
          </button>
        </section>
      ) : null}

      {commandError !== undefined ? (
        <div className="unified-mission-error" role="alert">
          <AlertTriangle size={15} />
          <div>
            <strong>Mission Control could not refresh</strong>
            <p>
              {response === undefined
                ? commandError
                : "The last authoritative project state is still shown."}
            </p>
          </div>
          <button type="button" onClick={() => setReloadKey((value) => value + 1)}>
            Retry
          </button>
        </div>
      ) : null}

      {loading && response === undefined ? (
        <div className="mission-empty" role="status">
          <RefreshCw className="spin" size={20} />
          <span>Loading project Mission Control</span>
        </div>
      ) : allItems.length === 0 ? (
        <div className="mission-empty">
          <List size={22} />
          <strong>No work items in this project</strong>
          <span>
            {response?.project.authorityEpoch === 0
              ? "Resolve and activate migration to create project work."
              : "Canonical project authority is ready for new work."}
          </span>
        </div>
      ) : visibleItems.length === 0 ? (
        <div className="mission-empty">
          <List size={22} />
          <strong>Only discarded work is hidden</strong>
          <button type="button" onClick={() => setShowDiscarded(true)}>
            Show discarded
          </button>
        </div>
      ) : (
        <div className="unified-mission-body">
          <section className="unified-mission-index">
            {view === "list" ? (
              <MissionControlList
                items={visibleItems}
                selectedItemId={selectedItemId}
                onSelect={setSelectedItemId}
              />
            ) : (
              <MissionControlKanban
                items={visibleItems}
                selectedItemId={selectedItemId}
                showDiscarded={showDiscarded}
                onSelect={setSelectedItemId}
              />
            )}
          </section>
          <MissionControlInspector
            history={response?.project.document.history ?? []}
            item={selectedItem}
            projectPath={project.path}
            onOpenConversation={onOpenConversation}
            onStartConversation={onStartConversation}
            disabled={commanding || response?.project.authorityEpoch === 0}
            onAction={(intent) =>
              executeAction((projectId, expectedRevision) => ({
                ...intent,
                projectId,
                expectedRevision,
              }) as DesktopMissionControlActionIntent)}
          />
        </div>
      )}
    </main>
  );
}

function MissionControlMigrationPanel({
  migration,
  disabled,
  onClear,
  onRebind,
  onResolve,
  onActivate,
}: {
  migration: MissionControlMigrationState;
  disabled: boolean;
  onClear: () => void;
  onRebind: (sourceId: string, sourceFingerprint: string) => void;
  onResolve: (candidateId: string) => void;
  onActivate: () => void;
}) {
  const unresolvedSources = migration.sources.filter(
    (source) =>
      source.linkStatus !== "linked" && source.linkStatus !== "rebound",
  );
  return (
    <section className="unified-mission-migration" aria-label="Mission Control migration">
      <div>
        <strong>Migration: {migrationLabel(migration.status)}</strong>
        <span>
          Legacy session Mission Control remains the sole write authority until
          cutover.
        </span>
        <small>
          {migration.sources.length} source
          {migration.sources.length === 1 ? "" : "s"} ·{" "}
          {migration.candidates.length} candidate
          {migration.candidates.length === 1 ? "" : "s"}
        </small>
      </div>
      {unresolvedSources.map((source) => (
        <div className="unified-mission-migration-source" key={source.sourceId}>
          <code>{source.sourceId}</code>
          <span>{source.linkStatus.replaceAll("_", " ")}</span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRebind(source.sourceId, source.sourceFingerprint)}
          >
            Rebind to this project
          </button>
        </div>
      ))}
      {migration.status === "needs_resolution"
        ? migration.candidates.map((candidate) => (
            <div
              className="unified-mission-migration-source"
              key={candidate.id}
            >
              <code>{candidate.sourceIds.join(", ")}</code>
              {candidate.valid ? (
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onResolve(candidate.id)}
                >
                  Use this complete source
                </button>
              ) : (
                <span>{candidate.conflicts.join(", ")}</span>
              )}
            </div>
          ))
        : null}
      {migration.status === "staged_empty" ? (
        <span>No compatible legacy work exists for this project.</span>
      ) : null}
      {migration.status === "staged_empty" ||
      migration.status === "staged" ||
      migration.status === "resolved" ? (
        <button type="button" disabled={disabled} onClick={onActivate}>
          Activate Mission Control
        </button>
      ) : null}
      <button type="button" disabled={disabled} onClick={onClear}>
        Clear staged migration
      </button>
    </section>
  );
}

function MissionControlAutopilotControl({
  enabled,
  wipLimit,
  disabled,
  onConfigure,
}: {
  enabled: boolean;
  wipLimit: number;
  disabled: boolean;
  onConfigure: (
    enabled: boolean,
    wipLimit: number,
    confirmed: boolean,
  ) => void;
}) {
  const [draftLimit, setDraftLimit] = useState(wipLimit);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => setDraftLimit(wipLimit), [wipLimit]);
  return (
    <section
      className="unified-mission-toolbar"
      aria-label="Mission Control Autopilot"
    >
      <strong>Project Autopilot</strong>
      <span>{enabled ? "On" : "Off"} · starts Ready work in explicit order</span>
      <label>
        WIP limit
        <input
          type="number"
          min={1}
          max={64}
          value={draftLimit}
          disabled={disabled}
          onChange={(event) =>
            setDraftLimit(
              Math.max(1, Math.min(64, Number(event.target.value) || 1)),
            )}
        />
      </label>
      {confirming ? (
        <>
          <span>Autopilot will start eligible Ready work through the same Start path.</span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              setConfirming(false);
              onConfigure(true, draftLimit, true);
            }}
          >
            Confirm enable Autopilot
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (enabled) onConfigure(false, draftLimit, false);
              else setConfirming(true);
            }}
          >
            {enabled ? "Disable Autopilot" : "Enable Autopilot"}
          </button>
          <button
            type="button"
            disabled={disabled || draftLimit === wipLimit}
            onClick={() => onConfigure(enabled, draftLimit, enabled)}
          >
            Save WIP limit
          </button>
        </>
      )}
    </section>
  );
}

function MissionControlCreateControl({
  disabled,
  onCreate,
}: {
  disabled: boolean;
  onCreate: (
    title: string,
    instructions: string,
    completionContract:
      Extract<
        DesktopMissionControlActionIntent,
        { type: "create" }
      >["completionContract"],
  ) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [workType, setWorkType] = useState<"code" | "non_code">("code");
  const [validationActions, setValidationActions] = useState("");
  if (expanded === false) {
    return (
      <section className="unified-mission-toolbar">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setExpanded(true)}
        >
          Create work item
        </button>
      </section>
    );
  }
  const actionIds = validationActions
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return (
    <section className="unified-mission-toolbar" aria-label="Create work item">
      <label>
        Title
        <input value={title} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>
        Instructions
        <input
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
      <label>
        Work contract
        <select
          value={workType}
          onChange={(event) =>
            setWorkType(event.target.value === "non_code" ? "non_code" : "code")}
        >
          <option value="code">Code changes</option>
          <option value="non_code">Non-code, no workspace change</option>
        </select>
      </label>
      {workType === "code" ? (
        <label>
          Required validation action IDs
          <input
            value={validationActions}
            onChange={(event) => setValidationActions(event.target.value)}
          />
        </label>
      ) : null}
      <button
        type="button"
        disabled={
          disabled ||
          title.trim().length === 0 ||
          instructions.trim().length === 0 ||
          (workType === "code" && actionIds.length === 0)
        }
        onClick={() => {
          onCreate(
            title.trim(),
            instructions.trim(),
            workType === "code"
              ? {
                  workType: "code",
                  changeOutcome: "changes",
                  validation: { mode: "required", actionIds },
                  requiredEvidence: [],
                }
              : {
                  workType: "non_code",
                  changeOutcome: "no_change",
                  validation: {
                    mode: "not_applicable",
                    reason: "Operator declared a non-code work item.",
                  },
                  requiredEvidence: [],
                },
          );
          setExpanded(false);
          setTitle("");
          setInstructions("");
        }}
      >
        Add Ready work
      </button>
      <button type="button" onClick={() => setExpanded(false)}>
        Cancel
      </button>
    </section>
  );
}

function migrationLabel(status: MissionControlMigrationState["status"]): string {
  switch (status) {
    case "staged_empty":
      return "empty";
    case "needs_rebind":
      return "project identity required";
    case "needs_resolution":
      return "source selection required";
    case "staged":
      return "staged";
    case "resolved":
      return "resolved";
  }
}

function missionControlAutopilotStatus(
  response: DesktopMissionControlProjectResponse | undefined,
  items: MissionControlWorkItem[],
): string {
  if (response === undefined) return "Autopilot authority is loading.";
  if (response.project.authorityEpoch === 0) {
    return "Autopilot is blocked until migration activation.";
  }
  if (response.project.document.autopilot.enabled === false) {
    return "Autopilot is off by operator policy.";
  }
  if (
    items.some(
      (item) => currentAttempt(item)?.status === "cancelling",
    )
  ) {
    return "Autopilot is blocked while cancellation is confirmed.";
  }
  if (items.some((item) => item.phase === "needs_attention")) {
    return "Autopilot is blocked by Needs attention work.";
  }
  if (
    activeItemCount(items) >=
    response.project.document.autopilot.wipLimit
  ) {
    return "Autopilot is blocked at the project WIP limit.";
  }
  if (items.some((item) => item.phase === "ready") === false) {
    return "Autopilot is idle because no Ready work exists.";
  }
  return "Autopilot can start Ready work in explicit order.";
}

function MissionControlList({
  items,
  selectedItemId,
  onSelect,
}: {
  items: MissionControlWorkItem[];
  selectedItemId: string | undefined;
  onSelect: (itemId: string) => void;
}) {
  return (
    <div className="unified-mission-list" aria-label="Mission Control work item list">
      <div className="unified-mission-list-header">
        <span>Work item</span>
        <span>Phase</span>
        <span>Attempt</span>
      </div>
      {items.map((item) => (
        <button
          type="button"
          className={item.id === selectedItemId ? "selected" : ""}
          key={item.id}
          aria-label={item.title}
          aria-pressed={item.id === selectedItemId}
          onClick={() => onSelect(item.id)}
        >
          <span>
            <strong>{item.title}</strong>
            <small>{item.id}</small>
          </span>
          <PhaseBadge phase={item.phase} />
          <AttemptBadge attempt={currentAttempt(item)} />
        </button>
      ))}
    </div>
  );
}

function MissionControlKanban({
  items,
  selectedItemId,
  showDiscarded,
  onSelect,
}: {
  items: MissionControlWorkItem[];
  selectedItemId: string | undefined;
  showDiscarded: boolean;
  onSelect: (itemId: string) => void;
}) {
  const discarded = items.filter((item) => item.phase === "discarded");
  return (
    <>
      <div className="unified-mission-kanban" aria-label="Mission Control Kanban">
        {PHASES.map(({ phase, label }) => {
          const laneItems = items.filter((item) => item.phase === phase);
          return (
            <section key={phase} aria-label={`${label} lane`}>
              <header>
                <span>{label}</span>
                <strong>{laneItems.length}</strong>
              </header>
              <div>
                {laneItems.map((item) => (
                  <button
                    type="button"
                    className={item.id === selectedItemId ? "selected" : ""}
                    key={item.id}
                    aria-label={item.title}
                    aria-pressed={item.id === selectedItemId}
                    onClick={() => onSelect(item.id)}
                  >
                    <strong>{item.title}</strong>
                    <small>{item.id}</small>
                    <AttemptBadge attempt={currentAttempt(item)} />
                  </button>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {showDiscarded && discarded.length > 0 ? (
        <section
          className="unified-mission-discarded"
          aria-label="Discarded work items"
        >
          <header>Discarded</header>
          {discarded.map((item) => (
            <button
              type="button"
              className={item.id === selectedItemId ? "selected" : ""}
              key={item.id}
              aria-label={item.title}
              onClick={() => onSelect(item.id)}
            >
              {item.title}
            </button>
          ))}
        </section>
      ) : null}
    </>
  );
}

function MissionControlInspector({
  history,
  item,
  projectPath,
  onOpenConversation,
  onStartConversation,
  disabled,
  onAction,
}: {
  history: MissionControlHistoryEntry[];
  item: MissionControlWorkItem | undefined;
  projectPath: string;
  onOpenConversation: (sessionId: string) => void;
  onStartConversation: (projectPath: string) => void;
  disabled: boolean;
  onAction: (intent: MissionControlInspectorIntent) => void;
}) {
  const [reply, setReply] = useState("");
  if (item === undefined) {
    return (
      <aside className="unified-mission-inspector">
        <div className="mission-empty">Select a work item</div>
      </aside>
    );
  }
  const attempt = currentAttempt(item);
  const priorAttempts = item.attempts.filter(
    (candidate) => candidate.id !== item.currentAttemptId,
  );
  const itemHistory = history.filter((entry) => entry.itemId === item.id);
  const currentBundle = item.currentReviewBundleId === undefined
    ? undefined
    : item.reviewBundles?.find(
        (bundle) => bundle.id === item.currentReviewBundleId,
      );
  const latestAcceptance = [...(item.reviewDecisions ?? [])]
    .reverse()
    .find((decision) => decision.decision === "accepted");
  const validationEvidence = currentBundle?.evidence.filter(
    (entry) => entry.kind === "validation",
  ) ?? [];
  const conversationIds = unique(
    item.attempts.map((candidate) => candidate.requestedSessionId),
  );
  const threadIds = unique(item.attempts.flatMap((candidate) => [
    candidate.requestedThreadId,
    ...candidate.runs.map((run) => run.threadId),
  ]));
  const runIds = unique(item.attempts.flatMap((candidate) =>
    candidate.runs.map((run) => run.runId),
  ).concat(
    currentBundle?.evidence.flatMap((entry) =>
      "runId" in entry && entry.runId !== undefined ? [entry.runId] : []
    ) ?? [],
  ));
  const reviewIds = currentBundle?.evidence
    .filter((entry) => entry.kind === "automated_review")
    .map((entry) => entry.referenceId) ?? [];
  const artifactIds = currentBundle?.evidence
    .filter(
      (entry) =>
        entry.kind === "artifact" ||
        entry.kind === "checkpoint" ||
        entry.kind === "preview",
    )
    .map((entry) => entry.referenceId) ?? [];

  return (
    <aside className="unified-mission-inspector" aria-label="Work item inspector">
      <header>
        <span>{item.id}</span>
        <PhaseBadge phase={item.phase} />
        <h2>{item.title}</h2>
        <p>{item.instructions}</p>
      </header>

      <section>
        <h3>Actions</h3>
        <div className="mission-view-tabs" aria-label="Work item actions">
          {item.phase === "proposed" ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onAction({
                  type: "approve",
                  itemId: item.id,
                  expectedItemVersion: item.version,
                })}
            >
              Approve
            </button>
          ) : null}
          {item.phase === "ready" ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onAction({
                  type: "start",
                  itemId: item.id,
                  expectedItemVersion: item.version,
                })}
            >
              Start
            </button>
          ) : null}
          {attempt !== undefined &&
          (attempt.status === "running" || attempt.status === "waiting") &&
          attempt.currentRunId !== undefined ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                const run = attempt.runs.find(
                  (candidate) => candidate.runId === attempt.currentRunId,
                );
                if (run === undefined) return;
                onAction({
                  type: "stop",
                  itemId: item.id,
                  expectedItemVersion: item.version,
                  attemptId: attempt.id,
                  expectedAttemptVersion: attempt.version,
                  runId: run.runId,
                  commandId: run.commandId,
                });
              }}
            >
              Stop
            </button>
          ) : null}
          {item.phase === "needs_attention" ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onAction({
                  type: "return_to_ready",
                  itemId: item.id,
                  expectedItemVersion: item.version,
                })}
            >
              Return to Ready
            </button>
          ) : null}
          {item.phase === "needs_attention" &&
          attempt !== undefined &&
          (attempt.status === "failed" ||
            attempt.status === "orphaned" ||
            attempt.status === "cancelled") ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onAction({
                  type: "retry",
                  itemId: item.id,
                  expectedItemVersion: item.version,
                })}
            >
              Retry as new attempt
            </button>
          ) : null}
          {item.phase === "active" && attempt?.status === "completed" ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onAction({
                  type: "prepare_review",
                  itemId: item.id,
                  expectedItemVersion: item.version,
                  attemptId: attempt.id,
                  expectedAttemptVersion: attempt.version,
                })}
            >
              Prepare Review
            </button>
          ) : null}
          {item.phase === "review" &&
          attempt !== undefined &&
          currentBundle !== undefined ? (
            <>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  onAction({
                    type: "accept",
                    itemId: item.id,
                    expectedItemVersion: item.version,
                    attemptId: attempt.id,
                    expectedAttemptVersion: attempt.version,
                    candidateFingerprint:
                      currentBundle.candidate.candidateFingerprint,
                    bundleId: currentBundle.id,
                  })}
              >
                Accept
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() =>
                  onAction({
                    type: "request_changes",
                    itemId: item.id,
                    expectedItemVersion: item.version,
                    attemptId: attempt.id,
                    expectedAttemptVersion: attempt.version,
                    candidateFingerprint:
                      currentBundle.candidate.candidateFingerprint,
                    bundleId: currentBundle.id,
                    reason: "Operator requested changes from Mission Control.",
                  })}
              >
                Request changes
              </button>
            </>
          ) : null}
          {(item.phase === "proposed" ||
            item.phase === "ready" ||
            item.phase === "needs_attention") ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onAction({
                  type: "discard",
                  itemId: item.id,
                  expectedItemVersion: item.version,
                })}
            >
              Discard
            </button>
          ) : null}
          {item.phase === "discarded" ? (
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onAction({
                  type: "restore",
                  itemId: item.id,
                  expectedItemVersion: item.version,
                })}
            >
              Restore to Ready
            </button>
          ) : null}
        </div>
        {attempt?.status === "waiting" &&
        attempt.pendingRequest !== undefined ? (
          <div>
            <label>
              Reply to {attempt.pendingRequest.kind.replaceAll("_", " ")}
              <input
                value={reply}
                onChange={(event) => setReply(event.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={disabled || reply.trim().length === 0}
              onClick={() => {
                onAction({
                  type: "reply",
                  itemId: item.id,
                  expectedItemVersion: item.version,
                  attemptId: attempt.id,
                  expectedAttemptVersion: attempt.version,
                  requestId: attempt.pendingRequest!.requestId,
                  message: reply.trim(),
                });
                setReply("");
              }}
            >
              Send exact reply
            </button>
          </div>
        ) : null}
        {attempt?.status === "cancelling" ? (
          <p>Cancellation requested. Waiting for runner confirmation…</p>
        ) : null}
      </section>

      <section>
        <h3>Conversation</h3>
        {attempt !== undefined ? (
          <button
            type="button"
            className="mission-conversation-handoff"
            onClick={() => onOpenConversation(attempt.requestedSessionId)}
          >
            <MessageSquare size={14} />
            Open conversation
          </button>
        ) : (
          <button
            type="button"
            className="mission-conversation-handoff"
            onClick={() => onStartConversation(projectPath)}
          >
            <MessageSquare size={14} />
            Start conversation
          </button>
        )}
      </section>

      <section>
        <h3>Current attempt</h3>
        {attempt === undefined ? (
          <p className="inspector-empty">No execution attempt</p>
        ) : (
          <dl>
            <div><dt>Status</dt><dd><AttemptBadge attempt={attempt} /></dd></div>
            <div><dt>Attempt</dt><dd><code>{attempt.id}</code></dd></div>
            <div><dt>Generation</dt><dd>{attempt.generation}</dd></div>
            <div><dt>Session</dt><dd><code>{attempt.requestedSessionId}</code></dd></div>
            <div><dt>Thread</dt><dd><code>{attempt.requestedThreadId}</code></dd></div>
            <div><dt>Run</dt><dd><code>{attempt.currentRunId ?? attempt.dispatchRunId}</code></dd></div>
          </dl>
        )}
      </section>

      <section>
        <h3>Completion</h3>
        <dl>
          <div>
            <dt>Implementation stage</dt>
            <dd>{attempt?.status === "completed" ? "Completed" : "Not completed"}</dd>
          </div>
          <div>
            <dt>Validation stage</dt>
            <dd>
              {validationEvidence.length === 0
                ? "Not recorded"
                : unique(validationEvidence.map((entry) => entry.outcome)).join(", ")}
            </dd>
          </div>
          <div>
            <dt>Frozen evidence</dt>
            <dd>{currentBundle === undefined ? "None" : <code>{currentBundle.id}</code>}</dd>
          </div>
          <div>
            <dt>Acceptance decision</dt>
            <dd>
              {latestAcceptance === undefined
                ? "None"
                : (
                    <span>
                      Accepted by <code>{latestAcceptance.operatorId}</code>
                    </span>
                  )}
            </dd>
          </div>
        </dl>
      </section>

      <section>
        <h3>Prior attempts</h3>
        {priorAttempts.length === 0 ? (
          <p className="inspector-empty">No prior attempts</p>
        ) : (
          <ul>
            {priorAttempts.map((candidate) => (
              <li key={candidate.id}>
                <code>{candidate.id}</code>
                <AttemptBadge attempt={candidate} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h3>Linked work</h3>
        <dl>
          <LinkValues label="Conversations" values={conversationIds} />
          <LinkValues label="Threads" values={threadIds} />
          <LinkValues label="Runs" values={runIds} />
          <LinkValues label="Worktrees" values={[]} />
          <LinkValues label="Reviews" values={reviewIds} />
          <LinkValues label="Artifacts" values={artifactIds} />
        </dl>
      </section>

      <section>
        <h3>History</h3>
        {itemHistory.length === 0 ? (
          <p className="inspector-empty">No item history</p>
        ) : (
          <ol>
            {itemHistory.map((entry) => (
              <li key={`${entry.revision}:${entry.actionId}`}>
                <span>{entry.actionType.replaceAll("_", " ")}</span>
                <time>{formatTime(entry.timestamp)}</time>
              </li>
            ))}
          </ol>
        )}
      </section>
    </aside>
  );
}

function LinkValues({
  label,
  values,
}: {
  label: string;
  values: string[];
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {values.length === 0 ? (
          "None"
        ) : (
          <span className="mission-link-values">
            <ExternalLink size={11} />
            {values.map((value) => <code key={value}>{value}</code>)}
          </span>
        )}
      </dd>
    </div>
  );
}

function PhaseBadge({ phase }: { phase: MissionControlWorkPhase }) {
  return (
    <span className={`mission-phase-badge phase-${phase}`}>
      {phase.replaceAll("_", " ")}
    </span>
  );
}

function AttemptBadge({
  attempt,
}: {
  attempt: MissionControlExecutionAttempt | undefined;
}) {
  return (
    <span
      className={`mission-attempt-badge attempt-${attempt?.status ?? "none"}`}
      title={attempt?.id}
    >
      {attempt?.status ?? "No attempt"}
    </span>
  );
}

function currentAttempt(
  item: MissionControlWorkItem,
): MissionControlExecutionAttempt | undefined {
  return item.currentAttemptId === undefined
    ? undefined
    : item.attempts.find((attempt) => attempt.id === item.currentAttemptId);
}

function compareItems(
  left: MissionControlWorkItem,
  right: MissionControlWorkItem,
): number {
  return (PHASE_ORDER.get(left.phase) ?? Number.MAX_SAFE_INTEGER)
    - (PHASE_ORDER.get(right.phase) ?? Number.MAX_SAFE_INTEGER)
    || left.order - right.order
    || left.id.localeCompare(right.id);
}

function activeItemCount(items: MissionControlWorkItem[]): number {
  return items.filter((item) => {
    const status = currentAttempt(item)?.status;
    return status === "starting"
      || status === "running"
      || status === "waiting"
      || status === "cancelling";
  }).length;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : value;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
