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
  DesktopMissionControlProjectResponse,
  DesktopProjectRegistration,
} from "../../src/contracts";
import type {
  MissionControlExecutionAttempt,
  MissionControlHistoryEntry,
  MissionControlWorkItem,
  MissionControlWorkPhase,
} from "../../../../src/missionControl/projectAuthority";

type MissionControlView = "list" | "kanban";

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
      .then((next) => {
        if (disposed) return;
        setResponse(next);
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
          <span>Read-only preview</span>
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
        {refreshing ? <span>Reconnecting to project authority…</span> : null}
      </section>

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
          <span>Canonical project authority is connected and read-only.</span>
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
          />
        </div>
      )}
    </main>
  );
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
}: {
  history: MissionControlHistoryEntry[];
  item: MissionControlWorkItem | undefined;
  projectPath: string;
  onOpenConversation: (sessionId: string) => void;
  onStartConversation: (projectPath: string) => void;
}) {
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
  const conversationIds = unique(
    item.attempts.map((candidate) => candidate.requestedSessionId),
  );
  const threadIds = unique(item.attempts.flatMap((candidate) => [
    candidate.requestedThreadId,
    ...candidate.runs.map((run) => run.threadId),
  ]));
  const runIds = unique(item.attempts.flatMap((candidate) =>
    candidate.runs.map((run) => run.runId),
  ));

  return (
    <aside className="unified-mission-inspector" aria-label="Work item inspector">
      <header>
        <span>{item.id}</span>
        <PhaseBadge phase={item.phase} />
        <h2>{item.title}</h2>
        <p>{item.instructions}</p>
      </header>

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
          <div><dt>Implementation stage</dt><dd>Not recorded</dd></div>
          <div><dt>Validation stage</dt><dd>Not recorded</dd></div>
          <div><dt>Frozen evidence</dt><dd>None</dd></div>
          <div><dt>Acceptance decision</dt><dd>None</dd></div>
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
          <LinkValues label="Reviews" values={[]} />
          <LinkValues label="Artifacts" values={[]} />
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
