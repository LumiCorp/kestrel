import {
  AlertTriangle,
  ArrowLeft,
  Kanban,
  List,
  MessageSquare,
  RefreshCw,
} from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";

import type {
  DesktopMissionControlActionIntent,
  DesktopMissionControlProjectSetup,
  DesktopMissionControlProjectResponse,
  DesktopProjectRegistration,
  DesktopRuntimeHealth,
} from "../../src/contracts";
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
  { phase: "proposed", label: "Suggested" },
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
  projects?: Array<DesktopProjectRegistration & { id: string }>;
  runtimeHealth: DesktopRuntimeHealth;
  onProjectChange?: (projectPath: string) => void;
  onProjectResponse?: (response: DesktopMissionControlProjectResponse) => void;
  onReturnToConversation: () => void;
  onOpenConversation: (sessionId: string) => void;
  onError: (message: string | undefined) => void;
}

export function UnifiedMissionControlWorkspace({
  project,
  projects,
  runtimeHealth,
  onProjectChange,
  onProjectResponse,
  onReturnToConversation,
  onOpenConversation,
  onError,
}: UnifiedMissionControlWorkspaceProps) {
  const availableProjects = projects ?? [project];
  const [response, setResponse] =
    useState<DesktopMissionControlProjectResponse>();
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [commandError, setCommandError] = useState<{
    command: string;
    message: string;
  }>();
  const [authorityAvailable, setAuthorityAvailable] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);
  const [setupRetryKey, setSetupRetryKey] = useState(0);
  const [, setRelativeTimeTick] = useState(0);
  const [view, setView] = useState<MissionControlView>(readMissionControlView);
  const [showDiscarded, setShowDiscarded] = useState(false);
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const [projectSetup, setProjectSetup] = useState<DesktopMissionControlProjectSetup>();
  const [projectSetupState, setProjectSetupState] = useState<
    "loading" | "ready" | "failed"
  >("loading");
  const [projectSetupError, setProjectSetupError] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(false);
  const responseRef = useRef<DesktopMissionControlProjectResponse | undefined>(undefined);
  const onErrorRef = useRef(onError);
  const onProjectResponseRef = useRef(onProjectResponse ?? (() => {}));

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setRelativeTimeTick((value) => value + 1);
    }, 30_000);
    return () => window.clearInterval(intervalId);
  }, [project.id]);

  useEffect(() => {
    onErrorRef.current = onError;
  }, [onError]);

  useEffect(() => {
    onProjectResponseRef.current = onProjectResponse ?? (() => {});
  }, [onProjectResponse]);

  useEffect(() => {
    try {
      window.localStorage.setItem("kestrel:mission-control:view:v1", view);
    } catch {
      // The selected view is a preference, so restricted storage must not block work.
    }
  }, [view]);

  useEffect(() => {
    responseRef.current = undefined;
    setResponse(undefined);
    setSelectedItemId(undefined);
    setLoadError(undefined);
    setCommandError(undefined);
    setAuthorityAvailable(false);
    setLastUpdatedAt(undefined);
    setProjectSetup(undefined);
    setProjectSetupState("loading");
    setProjectSetupError(undefined);
    setCreating(false);
    setLoading(true);
    setRefreshing(false);
  }, [project.id]);

  useEffect(() => {
    let disposed = false;
    const inspectProjectSetup = window.kestrelDesktop.inspectMissionControlProjectSetup;
    setProjectSetup(undefined);
    setProjectSetupState("loading");
    setProjectSetupError(undefined);
    if (typeof inspectProjectSetup !== "function") {
      setProjectSetupState("failed");
      setProjectSetupError("Project check discovery is unavailable.");
      return;
    }
    void inspectProjectSetup(project.id)
      .then((setup) => {
        if (disposed === false) {
          setProjectSetup(setup);
          setProjectSetupState("ready");
        }
      })
      .catch((error) => {
        if (disposed === false) {
          setProjectSetupState("failed");
          setProjectSetupError(errorMessage(error));
        }
      });
    return () => { disposed = true; };
  }, [project.id, reloadKey, setupRetryKey]);

  useEffect(() => {
    let disposed = false;
    const applyProject = (next: DesktopMissionControlProjectResponse) => {
      if (disposed || next.projectId !== project.id) return;
      setAuthorityAvailable(true);
      setLoadError(undefined);
      onErrorRef.current(undefined);
      const current = responseRef.current;
      if (
        current !== undefined &&
        next.project.revision <= current.project.revision
      ) return;
      responseRef.current = next;
      setResponse(next);
      setLastUpdatedAt(next.project.updatedAt);
      onProjectResponseRef.current(next);
    };
    const unsubscribe = typeof window.kestrelDesktop.onMissionControlProject === "function"
      ? window.kestrelDesktop.onMissionControlProject(applyProject)
      : () => {};
    if (responseRef.current === undefined) setLoading(true);
    else setRefreshing(true);
    void window.kestrelDesktop.getMissionControlProject(project.id)
      .then((next) => {
        if (disposed) return;
        applyProject(next);
      })
      .catch((error) => {
        if (disposed) return;
        const cause = errorMessage(error);
        const message = cause.includes("Mission Control project authority is unavailable")
          ? "Mission Control is reconnecting to its project authority. Retry in a moment."
          : cause;
        setLoadError(message);
        setAuthorityAvailable(false);
        // This workspace owns the actionable retry state; reporting it to the
        // shell as well creates a duplicate raw runner error.
        onErrorRef.current(undefined);
      })
      .finally(() => {
        if (disposed) return;
        setLoading(false);
        setRefreshing(false);
      });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [project.id, reloadKey]);

  const connectionState = runtimeHealth.connection === "connecting"
    ? "connecting"
    : runtimeHealth.connection === "connected" && authorityAvailable
      ? "live"
      : "stale";

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
    visibleItems.find((item) => item.id === selectedItemId);
  const autopilotStatus = missionControlAutopilotStatus(
    response,
    allItems,
  );

  const executeAction = async (
    command: string,
    buildIntent: (
      projectId: string,
      expectedRevision: number,
    ) => DesktopMissionControlActionIntent,
  ): Promise<boolean> => {
    if (response === undefined) return false;
    setPendingCommand(command);
    try {
      const next = await window.kestrelDesktop.executeMissionControlAction(
        buildIntent(project.id, response.project.revision),
      );
      setAuthorityAvailable(true);
      const current = responseRef.current;
      if (
        current === undefined ||
        next.project.revision > current.project.revision
      ) {
        responseRef.current = next;
        setResponse(next);
        setLastUpdatedAt(next.project.updatedAt);
        onProjectResponseRef.current(next);
      }
      setCommandError(undefined);
      onErrorRef.current(undefined);
      return true;
    } catch (error) {
      const message = errorMessage(error);
      setCommandError({ command, message });
      onErrorRef.current(message);
      setReloadKey((value) => value + 1);
      return false;
    } finally {
      setPendingCommand(undefined);
    }
  };

  useEffect(() => {
    if (
      selectedItemId !== undefined &&
      visibleItems.some((item) => item.id === selectedItemId)
    ) return;
    const first = visibleItems[0];
    setSelectedItemId(first?.id);
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
        <div className="unified-mission-title">
          <h1>Mission Control</h1>
          <label>
            <span className="sr-only">Mission Control project</span>
            <select
              aria-label="Mission Control project"
              value={project.path}
              onChange={(event) => onProjectChange?.(event.target.value)}
            >
              {availableProjects.map((candidate) => (
                <option key={candidate.id} value={candidate.path}>
                  {candidate.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className={`mission-live-state ${connectionState}`} role="status">
          <span aria-hidden="true" />
          {connectionState === "live"
            ? "Live"
            : connectionState === "connecting"
              ? "Reconnecting"
              : lastUpdatedAt === undefined
                ? "Disconnected"
                : `Last updated ${formatRelativeTime(lastUpdatedAt)}`}
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
          pendingCommand !== undefined ||
          response === undefined
        }
        onConfigure={(enabled, wipLimit, confirmed) =>
          executeAction("Configure Autopilot", (projectId, expectedRevision) => ({
            type: "configure_autopilot",
            projectId,
            expectedRevision,
            enabled,
            wipLimit,
            confirmed,
          }))}
      />
      <section className="unified-mission-toolbar mission-primary-actions">
        <button
          type="button"
          disabled={pendingCommand !== undefined || response === undefined}
          onClick={() => {
            setCreating(true);
            setSelectedItemId(undefined);
            setInspectorCollapsed(false);
          }}
        >
          Create work
        </button>
        <button
          type="button"
          aria-expanded={inspectorCollapsed === false}
          onClick={() => setInspectorCollapsed((value) => !value)}
        >
          {inspectorCollapsed ? "Show details" : "Hide details"}
        </button>
      </section>

      {loadError !== undefined ? (
        <div className="unified-mission-error" role="alert">
          <AlertTriangle size={15} />
          <div>
            <strong>Mission Control could not {response === undefined ? "load" : "refresh"}</strong>
            <p>
              {response === undefined
                ? loadError
                : "The last authoritative project state is still shown."}
            </p>
          </div>
          <button type="button" onClick={() => setReloadKey((value) => value + 1)}>
            Retry
          </button>
        </div>
      ) : null}

      {commandError !== undefined ? (
        <div className="unified-mission-error" role="alert">
          <AlertTriangle size={15} />
          <div>
            <strong>{commandError.command} failed</strong>
            <p>{commandError.message}</p>
          </div>
          <button type="button" onClick={() => setCommandError(undefined)}>
            Dismiss
          </button>
        </div>
      ) : null}

      {loading && response === undefined ? (
        <div className="mission-empty" role="status">
          <RefreshCw className="spin" size={20} />
          <span>Loading project Mission Control</span>
        </div>
      ) : allItems.length === 0 && creating === false ? (
        <div className="mission-empty">
          <List size={22} />
          <strong>No work items in this project</strong>
          <span>Add work when you are ready.</span>
        </div>
      ) : visibleItems.length === 0 && creating === false ? (
        <div className="mission-empty">
          <List size={22} />
          <strong>Only discarded work is hidden</strong>
          <button type="button" onClick={() => setShowDiscarded(true)}>
            Show discarded
          </button>
        </div>
      ) : (
        <div className={`unified-mission-body ${inspectorCollapsed ? "inspector-collapsed" : ""}`}>
          <section className="unified-mission-index">
            {view === "list" ? (
              <MissionControlList
                items={visibleItems}
                selectedItemId={selectedItemId}
                onSelect={(itemId) => {
                  setCreating(false);
                  setSelectedItemId(itemId);
                }}
                onMoveReady={(itemId, direction) => {
                  const ready = visibleItems.filter((item) => item.phase === "ready");
                  const currentIndex = ready.findIndex((item) => item.id === itemId);
                  const targetIndex = currentIndex + direction;
                  if (currentIndex < 0 || targetIndex < 0 || targetIndex >= ready.length) return;
                  const ordered = ready.map((item) => item.id);
                  [ordered[currentIndex], ordered[targetIndex]] = [ordered[targetIndex]!, ordered[currentIndex]!];
                  void executeAction("Reorder Ready work", (projectId, expectedRevision) => ({
                    type: "resequence",
                    projectId,
                    expectedRevision,
                    targetPhase: "ready",
                    orderedItemIds: ordered,
                  }));
                }}
              />
            ) : (
              <MissionControlKanban
                items={visibleItems}
                selectedItemId={selectedItemId}
                showDiscarded={showDiscarded}
                onSelect={(itemId) => {
                  setCreating(false);
                  setSelectedItemId(itemId);
                }}
                onResequenceReady={(orderedItemIds) =>
                  executeAction("Reorder Ready work", (projectId, expectedRevision) => ({
                    type: "resequence",
                    projectId,
                    expectedRevision,
                    targetPhase: "ready",
                    orderedItemIds,
                  }))}
              />
            )}
          </section>
          {inspectorCollapsed ? null : (
            <MissionControlInspector
              history={response?.project.document.history ?? []}
              item={selectedItem}
              creating={creating}
              projectSetup={projectSetup}
              projectSetupState={projectSetupState}
              projectSetupError={projectSetupError}
              onRetryProjectSetup={() => setSetupRetryKey((value) => value + 1)}
              onCancelCreate={() => {
                setCreating(false);
                setSelectedItemId(visibleItems[0]?.id);
              }}
              onCreate={async (title, instructions, completionContract, followUpToItemId) => {
                const created = await executeAction("Create work item", (projectId, expectedRevision) => ({
                  type: "create",
                  projectId,
                  expectedRevision,
                  title,
                  instructions,
                  completionContract,
                  ...(followUpToItemId === undefined ? {} : { followUpToItemId }),
                }));
                if (created) setCreating(false);
                return created;
              }}
              onOpenConversation={onOpenConversation}
              disabled={pendingCommand !== undefined}
              onAction={(intent) =>
                executeAction(commandLabel(intent), (projectId, expectedRevision) => ({
                  ...intent,
                  projectId,
                  expectedRevision,
                }) as DesktopMissionControlActionIntent)}
            />
          )}
        </div>
      )}
    </main>
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

function missionControlAutopilotStatus(
  response: DesktopMissionControlProjectResponse | undefined,
  items: MissionControlWorkItem[],
): string {
  if (response === undefined) return "Autopilot authority is loading.";
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
  onMoveReady,
}: {
  items: MissionControlWorkItem[];
  selectedItemId: string | undefined;
  onSelect: (itemId: string) => void;
  onMoveReady: (itemId: string, direction: -1 | 1) => void;
}) {
  const groups: Array<{ label: string; items: MissionControlWorkItem[] }> = [
    {
      label: "Needs your input",
      items: items.filter((item) =>
        item.phase === "needs_attention" || currentAttempt(item)?.status === "waiting"),
    },
    {
      label: "In progress",
      items: items.filter((item) =>
        item.phase === "active" && currentAttempt(item)?.status !== "waiting"),
    },
    { label: "Ready to review", items: items.filter((item) => item.phase === "review") },
    { label: "Ready to start", items: items.filter((item) => item.phase === "ready") },
    { label: "Suggestions", items: items.filter((item) => item.phase === "proposed") },
    { label: "Completed", items: items.filter((item) => item.phase === "done") },
    { label: "Discarded", items: items.filter((item) => item.phase === "discarded") },
  ];
  return (
    <div className="unified-mission-list" aria-label="Mission Control work item list">
      {groups.filter((group) => group.items.length > 0).map((group) => (
        <section className="mission-list-group" key={group.label}>
          <header>
            <h2>{group.label}</h2>
            <span>{group.items.length}</span>
          </header>
          {group.items.map((item, index) => (
            <div className="mission-list-row" key={item.id}>
              <button
                type="button"
                className={item.id === selectedItemId ? "selected" : ""}
                aria-label={item.title}
                aria-pressed={item.id === selectedItemId}
                onClick={() => onSelect(item.id)}
              >
                <span>
                  <strong>{item.title}</strong>
                  <small>{friendlyItemStatus(item)} · {formatRelativeTime(item.updatedAt)}</small>
                </span>
                {item.attentionReason !== undefined ? (
                  <AlertTriangle size={14} aria-label={friendlyAttentionReason(item.attentionReason)} />
                ) : null}
              </button>
              {item.phase === "ready" ? (
                <div className="mission-order-controls" aria-label={`Reorder ${item.title}`}>
                  <button
                    type="button"
                    disabled={index === 0}
                    aria-label={`Move ${item.title} up`}
                    onClick={() => onMoveReady(item.id, -1)}
                  >↑</button>
                  <button
                    type="button"
                    disabled={index === group.items.length - 1}
                    aria-label={`Move ${item.title} down`}
                    onClick={() => onMoveReady(item.id, 1)}
                  >↓</button>
                </div>
              ) : null}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

function MissionControlKanban({
  items,
  selectedItemId,
  showDiscarded,
  onSelect,
  onResequenceReady,
}: {
  items: MissionControlWorkItem[];
  selectedItemId: string | undefined;
  showDiscarded: boolean;
  onSelect: (itemId: string) => void;
  onResequenceReady: (orderedItemIds: string[]) => void;
}) {
  const discarded = items.filter((item) => item.phase === "discarded");
  const [draggedReadyId, setDraggedReadyId] = useState<string>();
  const readyIds = items.filter((item) => item.phase === "ready").map((item) => item.id);
  const moveReady = (itemId: string, direction: -1 | 1) => {
    const index = readyIds.indexOf(itemId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= readyIds.length) return;
    const ordered = [...readyIds];
    [ordered[index], ordered[target]] = [ordered[target]!, ordered[index]!];
    onResequenceReady(ordered);
  };
  return (
    <>
      <p className="mission-board-overflow-hint">Scroll horizontally to see the complete lifecycle, including Done.</p>
      <div className="unified-mission-kanban" aria-label="Mission Control Kanban" tabIndex={0}>
        {PHASES.map(({ phase, label }) => {
          const laneItems = items.filter((item) => item.phase === phase);
          return (
            <section key={phase} aria-label={`${label} lane`}>
              <header>
                <span>{label}</span>
                <strong>{laneItems.length}</strong>
              </header>
              <div>
                {laneItems.map((item, index) => (
                  <div
                    className="mission-kanban-card"
                    key={item.id}
                    draggable={item.phase === "ready"}
                    onDragStart={() => {
                      if (item.phase === "ready") setDraggedReadyId(item.id);
                    }}
                    onDragEnd={() => setDraggedReadyId(undefined)}
                    onDragOver={(event) => {
                      if (item.phase === "ready" && draggedReadyId !== undefined) event.preventDefault();
                    }}
                    onDrop={() => {
                      if (item.phase !== "ready" || draggedReadyId === undefined || draggedReadyId === item.id) return;
                      const ordered = readyIds.filter((id) => id !== draggedReadyId);
                      ordered.splice(ordered.indexOf(item.id), 0, draggedReadyId);
                      setDraggedReadyId(undefined);
                      onResequenceReady(ordered);
                    }}
                  >
                    <button
                      type="button"
                      className={item.id === selectedItemId ? "selected" : ""}
                      aria-label={item.title}
                      aria-pressed={item.id === selectedItemId}
                      onClick={() => onSelect(item.id)}
                    >
                      <strong>{item.title}</strong>
                      <small>{friendlyItemStatus(item)} · {formatRelativeTime(item.updatedAt)}</small>
                      {item.attentionReason !== undefined ? <AlertTriangle size={14} /> : null}
                    </button>
                    {item.phase === "ready" ? (
                      <div className="mission-order-controls">
                        <button type="button" disabled={index === 0} aria-label={`Move ${item.title} up`} onClick={() => moveReady(item.id, -1)}>↑</button>
                        <button type="button" disabled={index === laneItems.length - 1} aria-label={`Move ${item.title} down`} onClick={() => moveReady(item.id, 1)}>↓</button>
                      </div>
                    ) : null}
                  </div>
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
  creating,
  projectSetup,
  projectSetupState,
  projectSetupError,
  onRetryProjectSetup,
  onCancelCreate,
  onCreate,
  onOpenConversation,
  disabled,
  onAction,
}: {
  history: MissionControlHistoryEntry[];
  item: MissionControlWorkItem | undefined;
  creating: boolean;
  projectSetup: DesktopMissionControlProjectSetup | undefined;
  projectSetupState: "loading" | "ready" | "failed";
  projectSetupError: string | undefined;
  onRetryProjectSetup: () => void;
  onCancelCreate: () => void;
  onCreate: (
    title: string,
    instructions: string,
    completionContract: Extract<DesktopMissionControlActionIntent, { type: "create" }>["completionContract"],
    followUpToItemId?: string,
  ) => Promise<boolean>;
  onOpenConversation: (sessionId: string) => void;
  disabled: boolean;
  onAction: (intent: MissionControlInspectorIntent) => Promise<boolean>;
}) {
  const [reply, setReply] = useState("");
  const [editing, setEditing] = useState(false);
  const [creatingFollowUp, setCreatingFollowUp] = useState(false);
  const [requestChangesReason, setRequestChangesReason] = useState("");
  const [showRequestChanges, setShowRequestChanges] = useState(false);
  const [confirmAccept, setConfirmAccept] = useState(false);

  useEffect(() => {
    setReply("");
    setEditing(false);
    setCreatingFollowUp(false);
    setRequestChangesReason("");
    setShowRequestChanges(false);
    setConfirmAccept(false);
  }, [item?.id]);

  if (creating) {
    return (
      <aside className="unified-mission-inspector mission-form-inspector" aria-label="Create work">
        <WorkItemForm
          key="create-work"
          heading="Create work"
          projectSetup={projectSetup}
          projectSetupState={projectSetupState}
          projectSetupError={projectSetupError}
          onRetryProjectSetup={onRetryProjectSetup}
          disabled={disabled}
          submitLabel="Add to Ready"
          onCancel={onCancelCreate}
          onSubmit={async (title, instructions, completionContract) => {
            await onCreate(title, instructions, completionContract);
          }}
        />
      </aside>
    );
  }
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

  if (editing) {
    return (
      <aside className="unified-mission-inspector mission-form-inspector" aria-label="Edit work">
        <WorkItemForm
          key={`edit-${item.id}-${item.version}`}
          heading="Edit work"
          projectSetup={projectSetup}
          projectSetupState={projectSetupState}
          projectSetupError={projectSetupError}
          onRetryProjectSetup={onRetryProjectSetup}
          disabled={disabled}
          submitLabel="Save changes"
          initialTitle={item.title}
          initialInstructions={item.instructions}
          initialContract={item.completionContract}
          onCancel={() => setEditing(false)}
          onSubmit={async (title, instructions, completionContract) => {
            const updated = await onAction({
              type: "update",
              itemId: item.id,
              expectedItemVersion: item.version,
              title,
              instructions,
              completionContract,
            });
            if (updated) setEditing(false);
          }}
        />
      </aside>
    );
  }

  if (creatingFollowUp) {
    return (
      <aside className="unified-mission-inspector mission-form-inspector" aria-label="Create follow-up work">
        <WorkItemForm
          key={`follow-up-${item.id}`}
          heading="Create follow-up"
          description="The completed result stays unchanged. Describe the new correction or extension below."
          projectSetup={projectSetup}
          projectSetupState={projectSetupState}
          projectSetupError={projectSetupError}
          onRetryProjectSetup={onRetryProjectSetup}
          disabled={disabled}
          submitLabel="Create follow-up"
          initialTitle={`Follow up: ${item.title}`}
          initialInstructions=""
          initialContract={item.completionContract}
          onCancel={() => setCreatingFollowUp(false)}
          onSubmit={async (title, instructions, completionContract) => {
            const created = await onCreate(title, instructions, completionContract, item.id);
            if (created) setCreatingFollowUp(false);
          }}
        />
      </aside>
    );
  }

  return (
    <aside className="unified-mission-inspector" aria-label="Work item inspector">
      <header>
        <PhaseBadge phase={item.phase} />
        <h2>{item.title}</h2>
        <p>{item.instructions}</p>
      </header>

      {item.phase === "needs_attention" ? (
        <section className="mission-attention-summary" role="status">
          <h3>Needs your attention</h3>
          <strong>{friendlyAttentionReason(item.attentionReason)}</strong>
          <p>{attempt?.terminalReason ?? "The attempt stopped before this work could be reviewed."}</p>
        </section>
      ) : null}

      <section>
        <h3>Actions</h3>
        <div className="mission-view-tabs" aria-label="Work item actions">
          {(item.phase === "proposed" || item.phase === "ready") && item.attempts.length === 0 ? (
            <button type="button" disabled={disabled} onClick={() => setEditing(true)}>
              Edit
            </button>
          ) : null}
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
                onClick={() => setConfirmAccept(true)}
              >
                Accept
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => setShowRequestChanges(true)}
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
          {item.phase === "done" ? (
            <button type="button" disabled={disabled} onClick={() => setCreatingFollowUp(true)}>
              Create follow-up
            </button>
          ) : null}
        </div>
        {confirmAccept && attempt !== undefined && currentBundle !== undefined ? (
          <div className="mission-confirmation" role="dialog" aria-label="Confirm acceptance">
            <strong>Accept this result?</strong>
            <p>Accepted work becomes immutable. Any later correction must be created as linked follow-up work.</p>
            <button type="button" disabled={disabled} onClick={() => {
              void (async () => {
                const accepted = await onAction({
                  type: "accept",
                  itemId: item.id,
                  expectedItemVersion: item.version,
                  attemptId: attempt.id,
                  expectedAttemptVersion: attempt.version,
                  candidateFingerprint: currentBundle.candidate.candidateFingerprint,
                  bundleId: currentBundle.id,
                });
                if (shouldClearMissionControlOperatorInput(accepted)) {
                  setConfirmAccept(false);
                }
              })();
            }}>Accept and complete</button>
            <button type="button" onClick={() => setConfirmAccept(false)}>Cancel</button>
          </div>
        ) : null}
        {showRequestChanges && attempt !== undefined && currentBundle !== undefined ? (
          <div className="mission-request-changes">
            <label>
              What needs to change?
              <textarea
                value={requestChangesReason}
                onChange={(event) => setRequestChangesReason(event.target.value)}
                autoFocus
              />
            </label>
            <button type="button" disabled={disabled || requestChangesReason.trim().length === 0} onClick={() => {
              void (async () => {
                const reason = requestChangesReason.trim();
                const sent = await onAction({
                  type: "request_changes",
                  itemId: item.id,
                  expectedItemVersion: item.version,
                  attemptId: attempt.id,
                  expectedAttemptVersion: attempt.version,
                  candidateFingerprint: currentBundle.candidate.candidateFingerprint,
                  bundleId: currentBundle.id,
                  reason,
                });
                if (shouldClearMissionControlOperatorInput(sent)) {
                  setShowRequestChanges(false);
                  setRequestChangesReason("");
                }
              })();
            }}>Send feedback</button>
            <button type="button" onClick={() => setShowRequestChanges(false)}>Cancel</button>
          </div>
        ) : null}
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
                void (async () => {
                  const message = reply.trim();
                  const sent = await onAction({
                    type: "reply",
                    itemId: item.id,
                    expectedItemVersion: item.version,
                    attemptId: attempt.id,
                    expectedAttemptVersion: attempt.version,
                    requestId: attempt.pendingRequest!.requestId,
                    message,
                  });
                  if (shouldClearMissionControlOperatorInput(sent)) setReply("");
                })();
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
        ) : <p>A conversation appears here when this work starts.</p>}
      </section>

      <section>
        <h3>Current progress</h3>
        {attempt === undefined ? (
          <p className="inspector-empty">No execution attempt</p>
        ) : (
          <p>{friendlyItemStatus(item)}</p>
        )}
      </section>

      <section>
        <h3>Completion checklist</h3>
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
                : validationEvidence.map((entry) =>
                    `${entry.actionId ?? "Project check"}: ${entry.outcome.replaceAll("_", " ")}`
                  ).join(", ")}
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

      <details className="mission-technical-details">
        <summary>Technical details</summary>
        <dl>
          <LinkValues label="Work item ID" values={[item.id]} />
          <LinkValues label="Current attempt" values={attempt === undefined ? [] : [attempt.id]} />
          <LinkValues label="Conversations" values={conversationIds} />
          <LinkValues label="Threads" values={threadIds} />
          <LinkValues label="Runs" values={runIds} />
          <LinkValues label="Reviews" values={reviewIds} />
          <LinkValues label="Artifacts" values={artifactIds} />
          <LinkValues label="Prior attempts" values={priorAttempts.map((candidate) => candidate.id)} />
        </dl>
      </details>

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

type MissionControlCompletionContract = Extract<
  DesktopMissionControlActionIntent,
  { type: "create" }
>["completionContract"];

function WorkItemForm({
  heading,
  description,
  projectSetup,
  projectSetupState,
  projectSetupError,
  onRetryProjectSetup,
  initialTitle = "",
  initialInstructions = "",
  initialContract,
  submitLabel,
  disabled,
  onCancel,
  onSubmit,
}: {
  heading: string;
  description?: string | undefined;
  projectSetup: DesktopMissionControlProjectSetup | undefined;
  projectSetupState: "loading" | "ready" | "failed";
  projectSetupError: string | undefined;
  onRetryProjectSetup: () => void;
  initialTitle?: string | undefined;
  initialInstructions?: string | undefined;
  initialContract?: MissionControlCompletionContract | undefined;
  submitLabel: string;
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (
    title: string,
    instructions: string,
    completionContract: MissionControlCompletionContract,
  ) => void | Promise<void>;
}) {
  const requiredActionIds = projectSetup?.actions
    .filter((action) => action.required)
    .map((action) => action.actionId) ?? [];
  const [title, setTitle] = useState(initialTitle);
  const [instructions, setInstructions] = useState(initialInstructions);
  const [willChangeFiles, setWillChangeFiles] = useState(
    initialContract?.changeOutcome !== "no_change",
  );
  const [requiredEvidence, setRequiredEvidence] = useState<
    MissionControlCompletionContract["requiredEvidence"]
  >(initialContract?.requiredEvidence ?? []);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  const completionContract: MissionControlCompletionContract = willChangeFiles
    ? {
        workType: "code",
        changeOutcome: "changes",
        validation: requiredActionIds.length > 0
          ? { mode: "required", actionIds: requiredActionIds }
          : {
              mode: "not_applicable",
              reason: "No required project checks are configured for this project.",
            },
        requiredEvidence,
      }
    : {
        workType: "non_code",
        changeOutcome: "no_change",
        validation: {
          mode: "not_applicable",
          reason: "This work is not expected to change project files.",
        },
        requiredEvidence,
      };
  const evidenceOptions: Array<{
    value: MissionControlCompletionContract["requiredEvidence"][number];
    label: string;
  }> = [
    { value: "automated_review", label: "Automated review" },
    { value: "delivery", label: "Delivery evidence" },
    { value: "artifact", label: "Artifact" },
    { value: "checkpoint", label: "Checkpoint" },
    { value: "preview", label: "Preview evidence" },
  ];

  return (
    <form className="mission-work-form" onSubmit={(event) => {
      event.preventDefault();
      if (title.trim().length === 0 || instructions.trim().length === 0) return;
      void onSubmit(title.trim(), instructions.trim(), completionContract);
    }}>
      <header>
        <h2>{heading}</h2>
        {description === undefined ? null : <p>{description}</p>}
      </header>
      <label>
        What needs doing?
        <input
          ref={titleRef}
          value={title}
          maxLength={512}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        Outcome and instructions
        <textarea
          value={instructions}
          rows={7}
          maxLength={32_000}
          onChange={(event) => setInstructions(event.target.value)}
        />
      </label>
      <fieldset>
        <legend>Will this change project files?</legend>
        <label>
          <input
            type="radio"
            name="will-change-files"
            checked={willChangeFiles}
            onChange={() => setWillChangeFiles(true)}
          />
          Yes, project files may change
        </label>
        <label>
          <input
            type="radio"
            name="will-change-files"
            checked={willChangeFiles === false}
            onChange={() => setWillChangeFiles(false)}
          />
          No project file changes
        </label>
      </fieldset>
      {willChangeFiles ? (
        <section className="mission-project-checks">
          <strong>Project-required checks</strong>
          {projectSetupState === "loading" ? (
            <span>Discovering project checks…</span>
          ) : projectSetupState === "failed" ? (
            <div role="alert">
              <span>{projectSetupError ?? "Project checks are unavailable."}</span>
              <button type="button" onClick={onRetryProjectSetup}>Retry</button>
            </div>
          ) : requiredActionIds.length === 0 ? (
            <span>No required project checks are configured.</span>
          ) : (
            <ul>
              {(projectSetup?.actions ?? []).filter((action) => action.required).map((action) => (
                <li key={action.actionId}>{action.label}</li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      <details>
        <summary>Advanced evidence</summary>
        <div className="mission-evidence-options">
          {evidenceOptions.map((option) => (
            <label key={option.value}>
              <input
                type="checkbox"
                checked={requiredEvidence.includes(option.value)}
                onChange={(event) => setRequiredEvidence((current) =>
                  event.target.checked
                    ? unique([...current, option.value]) as MissionControlCompletionContract["requiredEvidence"]
                    : current.filter((value) => value !== option.value))}
              />
              {option.label}
            </label>
          ))}
        </div>
      </details>
      <div className="mission-form-actions">
        <button
          type="submit"
          disabled={isMissionWorkItemSubmitDisabled({
            disabled,
            willChangeFiles,
            projectSetupState,
            title,
            instructions,
          })}
        >
          {submitLabel}
        </button>
        <button type="button" disabled={disabled} onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

export function isMissionWorkItemSubmitDisabled(input: {
  disabled: boolean;
  willChangeFiles: boolean;
  projectSetupState: "loading" | "ready" | "failed";
  title: string;
  instructions: string;
}): boolean {
  return input.disabled ||
    (input.willChangeFiles && input.projectSetupState !== "ready") ||
    input.title.trim().length === 0 ||
    input.instructions.trim().length === 0;
}

export function shouldClearMissionControlOperatorInput(
  actionSucceeded: boolean,
): boolean {
  return actionSucceeded;
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

function friendlyItemStatus(item: MissionControlWorkItem): string {
  const attempt = currentAttempt(item);
  if (attempt?.status === "waiting") return "Waiting for your reply";
  if (attempt?.status === "cancelling") return "Stopping";
  if (attempt?.status === "starting") return "Starting";
  if (attempt?.status === "running") return "In progress";
  if (attempt?.status === "completed" && item.phase === "active") {
    return "Ready to prepare for review";
  }
  switch (item.phase) {
    case "proposed": return "Suggestion";
    case "ready": return "Ready to start";
    case "active": return "In progress";
    case "needs_attention": return "Needs your attention";
    case "review": return "Ready for review";
    case "done": return "Completed";
    case "discarded": return "Discarded";
  }
}

function friendlyAttentionReason(
  reason: MissionControlWorkItem["attentionReason"],
): string {
  switch (reason) {
    case "start_rejected": return "Work could not start";
    case "execution_failed": return "The work run failed";
    case "operator_stopped": return "The work was stopped";
    case "runner_orphaned": return "The work lost its runtime connection";
    case "runtime_authority_changed": return "The runtime restarted during this work";
    default: return "This work needs a decision";
  }
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

export function formatRelativeTime(
  value: string,
  now = Date.now(),
): string {
  const timestamp = new Date(value).getTime();
  if (Number.isFinite(timestamp) === false) return "previously";
  const elapsedSeconds = Math.max(0, Math.round((now - timestamp) / 1_000));
  if (elapsedSeconds < 60) return "just now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return formatTime(value);
}

function readMissionControlView(): MissionControlView {
  try {
    return window.localStorage.getItem("kestrel:mission-control:view:v1") === "kanban"
      ? "kanban"
      : "list";
  } catch {
    return "list";
  }
}

function commandLabel(intent: MissionControlInspectorIntent): string {
  switch (intent.type) {
    case "approve": return "Approve work";
    case "start": return "Start work";
    case "stop": return "Stop work";
    case "retry": return "Retry work";
    case "return_to_ready": return "Return work to Ready";
    case "prepare_review": return "Prepare review";
    case "accept": return "Accept work";
    case "request_changes": return "Request changes";
    case "discard": return "Discard work";
    case "restore": return "Restore work";
    case "reply": return "Send reply";
    case "update": return "Save work changes";
    case "resequence": return "Reorder work";
    default: return "Update work";
  }
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
