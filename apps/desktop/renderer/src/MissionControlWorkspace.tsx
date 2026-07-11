import {
  AlertTriangle,
  Activity,
  ArrowLeft,
  Check,
  ExternalLink,
  Kanban,
  ListChecks,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useMemo, useState } from "react";

import type {
  DesktopProjectAction,
  DesktopProjectRegistration,
  DesktopProjectSnapshotResponse,
} from "../../src/contracts";
import { ProjectBoardWorkspace } from "./ProjectBoardWorkspace";
import { RuntimeRunWorkspace } from "./RuntimeRunWorkspace";
import { RuntimeRunsWorkspace } from "./RuntimeRunsWorkspace";
import { RuntimeThreadWorkspace } from "./RuntimeThreadWorkspace";

type ProjectSnapshot = DesktopProjectSnapshotResponse["snapshot"];
type MissionTask = ProjectSnapshot["taskQueue"]["tasks"][string];
type MissionTaskStatus = MissionTask["status"];
type MissionView = "tasks" | "board" | "runs";

interface MissionControlWorkspaceProps {
  sessionId: string;
  project: DesktopProjectRegistration | undefined;
  refreshVersion: number;
  onError: (message: string | undefined) => void;
}

const LANES: Array<{
  id: string;
  label: string;
  statuses: MissionTaskStatus[];
}> = [
  { id: "proposed", label: "Proposed", statuses: ["proposed"] },
  { id: "queue", label: "Queue", statuses: ["queued"] },
  { id: "active", label: "Active", statuses: ["running", "needs_attention"] },
  { id: "review", label: "Review", statuses: ["ready_for_review"] },
  { id: "closed", label: "Closed", statuses: ["done", "discarded"] },
];

export function MissionControlWorkspace({
  sessionId,
  project,
  refreshVersion,
  onError,
}: MissionControlWorkspaceProps) {
  const [snapshot, setSnapshot] = useState<ProjectSnapshot>();
  const [loading, setLoading] = useState(true);
  const [actionPending, setActionPending] = useState(false);
  const [view, setView] = useState<MissionView>("tasks");
  const [showCreate, setShowCreate] = useState(false);
  const [title, setTitle] = useState("");
  const [instructions, setInstructions] = useState("");
  const [priority, setPriority] = useState<"low" | "medium" | "high" | "urgent">("medium");
  const [cardTitle, setCardTitle] = useState("");
  const [cardPrompt, setCardPrompt] = useState("");
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    setSelectedThreadId(undefined);
    setSelectedRunId(undefined);
    setShowCreate(false);
  }, [sessionId]);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    void window.kestrelDesktop.getProjectSnapshot(sessionId)
      .then((response) => {
        if (disposed === false) {
          setSnapshot(response.snapshot);
          onError(undefined);
        }
      })
      .catch((error) => {
        if (disposed === false) {
          onError(errorMessage(error));
        }
      })
      .finally(() => {
        if (disposed === false) {
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
    };
  }, [onError, refreshVersion, reloadKey, sessionId]);

  const tasks = useMemo(
    () => Object.values(snapshot?.taskQueue.tasks ?? {}).sort(compareTasks),
    [snapshot],
  );
  const counts = useMemo(() => ({
    queued: tasks.filter((task) => task.status === "queued" || task.status === "proposed").length,
    active: tasks.filter((task) => task.status === "running" || task.status === "needs_attention").length,
    review: tasks.filter((task) => task.status === "ready_for_review").length,
    done: tasks.filter((task) => task.status === "done").length,
  }), [tasks]);
  const boardCounts = useMemo(() => {
    const cards = Object.values(snapshot?.board.cards ?? {});
    return {
      idea: cards.filter((card) => card.lane === "idea").length,
      planned: cards.filter((card) => card.lane === "planned").length,
      wip: cards.filter((card) => card.lane === "wip").length,
      testing: cards.filter((card) => card.lane === "testing").length,
    };
  }, [snapshot]);

  async function runAction(action: DesktopProjectAction): Promise<boolean> {
    setActionPending(true);
    onError(undefined);
    try {
      const response = await window.kestrelDesktop.runProjectAction(action);
      setSnapshot(response.snapshot);
      return true;
    } catch (error) {
      onError(errorMessage(error));
      return false;
    } finally {
      setActionPending(false);
    }
  }

  async function createTask(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (title.trim().length === 0 || instructions.trim().length === 0) {
      return;
    }
    const created = await runAction({
      ...actionBase(sessionId),
      type: "task.create",
      title: title.trim(),
      instructions: instructions.trim(),
      priority,
      ...(project !== undefined
        ? { projectPath: project.path, projectLabel: project.label }
        : {}),
    });
    if (created === false) {
      return;
    }
    setTitle("");
    setInstructions("");
    setPriority("medium");
    setShowCreate(false);
  }

  async function createBoardCard(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (
      snapshot === undefined
      || cardTitle.trim().length === 0
      || cardPrompt.trim().length === 0
    ) {
      return;
    }
    const created = await runAction({
      ...actionBase(sessionId),
      type: "board.card.create",
      expectedBoardVersion: snapshot.board.boardVersion,
      title: cardTitle.trim(),
      prompt: cardPrompt.trim(),
      source: "operator",
    });
    if (created === false) {
      return;
    }
    setCardTitle("");
    setCardPrompt("");
    setShowCreate(false);
  }

  function selectView(nextView: MissionView): void {
    setView(nextView);
    setShowCreate(false);
    setSelectedThreadId(undefined);
    setSelectedRunId(undefined);
  }

  function inspectThread(threadId: string): void {
    setShowCreate(false);
    setSelectedThreadId(threadId);
    setSelectedRunId(undefined);
  }

  function inspectRun(runId: string): void {
    setShowCreate(false);
    setSelectedRunId(runId);
  }

  function returnFromInspection(): void {
    if (selectedRunId !== undefined) {
      setSelectedRunId(undefined);
      return;
    }
    setSelectedThreadId(undefined);
  }

  return (
    <main className="surface-pane mission-control-surface" id="app-main">
      <header className="surface-header">
        <div>
          <span className="surface-kicker">Session operations</span>
          <h1>Mission control</h1>
          <p>{project?.label ?? "Current conversation"}</p>
        </div>
        <div className="surface-header-actions">
          {selectedThreadId !== undefined || selectedRunId !== undefined ? (
            <button
              className="icon-button"
              type="button"
              title={selectedRunId === undefined
                ? "Back to Mission Control"
                : selectedThreadId === undefined
                  ? "Back to runtime runs"
                  : "Back to runtime thread"}
              aria-label={selectedRunId === undefined
                ? "Back to Mission Control"
                : selectedThreadId === undefined
                  ? "Back to runtime runs"
                  : "Back to runtime thread"}
              onClick={returnFromInspection}
            >
              <ArrowLeft size={17} />
            </button>
          ) : (
            <>
              <button
                className="icon-button"
                type="button"
                title="Refresh mission control"
                aria-label="Refresh mission control"
                onClick={() => setReloadKey((value) => value + 1)}
              >
                <RefreshCw size={16} />
              </button>
              {view !== "runs" ? (
                <button
                  className="icon-button"
                  type="button"
                  title={showCreate
                    ? `Close ${view === "tasks" ? "task" : "card"} form`
                    : `Create ${view === "tasks" ? "task" : "card"}`}
                  aria-label={showCreate
                    ? `Close ${view === "tasks" ? "task" : "card"} form`
                    : `Create ${view === "tasks" ? "task" : "card"}`}
                  onClick={() => setShowCreate((visible) => !visible)}
                >
                  {showCreate ? <X size={17} /> : <Plus size={17} />}
                </button>
              ) : null}
            </>
          )}
        </div>
      </header>

      <nav className="mission-view-tabs" aria-label="Mission control views">
        <button
          type="button"
          className={view === "tasks" ? "active" : ""}
          onClick={() => selectView("tasks")}
        >
          <ListChecks size={15} />
          Task queue
        </button>
        <button
          type="button"
          className={view === "board" ? "active" : ""}
          onClick={() => selectView("board")}
        >
          <Kanban size={15} />
          Product board
        </button>
        <button
          type="button"
          className={view === "runs" ? "active" : ""}
          onClick={() => selectView("runs")}
        >
          <Activity size={15} />
          Runs
        </button>
      </nav>

      {selectedRunId !== undefined ? (
        <RuntimeRunWorkspace
          runId={selectedRunId}
          onError={onError}
          onSelectThread={inspectThread}
        />
      ) : selectedThreadId !== undefined ? (
        <RuntimeThreadWorkspace
          threadId={selectedThreadId}
          onError={onError}
          onSelectRun={inspectRun}
          onSelectThread={inspectThread}
        />
      ) : (
        <>
          {view === "tasks" ? (
            <section className="mission-summary" aria-label="Task status summary">
              <SummaryMetric label="Queued" value={counts.queued} />
              <SummaryMetric label="Active" value={counts.active} />
              <SummaryMetric label="Review" value={counts.review} />
              <SummaryMetric label="Done" value={counts.done} />
              <SummaryMetric label="Queue version" value={snapshot?.taskQueue.queueVersion ?? 0} />
            </section>
          ) : view === "board" ? (
            <section className="mission-summary" aria-label="Product board summary">
              <SummaryMetric label="Ideas" value={boardCounts.idea} />
              <SummaryMetric label="Planned" value={boardCounts.planned} />
              <SummaryMetric label="In progress" value={boardCounts.wip} />
              <SummaryMetric label="Testing" value={boardCounts.testing} />
              <SummaryMetric label="Board version" value={snapshot?.board.boardVersion ?? 0} />
            </section>
          ) : null}

          {showCreate ? (
            view === "tasks" ? (
              <form className="mission-create" onSubmit={(event) => void createTask(event)}>
                <input
                  aria-label="Task title"
                  placeholder="Task title"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
                <textarea
                  aria-label="Task instructions"
                  placeholder="Instructions"
                  rows={2}
                  value={instructions}
                  onChange={(event) => setInstructions(event.target.value)}
                />
                <select
                  aria-label="Task priority"
                  value={priority}
                  onChange={(event) => setPriority(event.target.value as typeof priority)}
                >
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                  <option value="urgent">Urgent</option>
                </select>
                <button
                  type="submit"
                  disabled={actionPending || title.trim().length === 0 || instructions.trim().length === 0}
                >
                  <Plus size={15} />
                  Create
                </button>
              </form>
            ) : (
              <form className="mission-create board-create" onSubmit={(event) => void createBoardCard(event)}>
                <input
                  aria-label="Card title"
                  placeholder="Card title"
                  value={cardTitle}
                  onChange={(event) => setCardTitle(event.target.value)}
                />
                <textarea
                  aria-label="Card prompt"
                  placeholder="Implementation prompt"
                  rows={2}
                  value={cardPrompt}
                  onChange={(event) => setCardPrompt(event.target.value)}
                />
                <button
                  type="submit"
                  disabled={actionPending || cardTitle.trim().length === 0 || cardPrompt.trim().length === 0}
                >
                  <Plus size={15} />
                  Create
                </button>
              </form>
            )
          ) : null}

          {view === "runs" ? (
            <RuntimeRunsWorkspace
              sessionId={sessionId}
              refreshVersion={reloadKey + refreshVersion}
              onError={onError}
              onSelectRun={inspectRun}
            />
          ) : loading && snapshot === undefined ? (
            <div className="mission-empty">
              <ListChecks size={22} />
              <span>Loading tasks</span>
            </div>
          ) : view === "board" && snapshot !== undefined ? (
            <ProjectBoardWorkspace
              sessionId={sessionId}
              board={snapshot.board}
              actionPending={actionPending}
              onAction={runAction}
              onInspectThread={inspectThread}
            />
          ) : tasks.length === 0 ? (
            <div className="mission-empty">
              <ListChecks size={22} />
              <span>No tasks in this session</span>
            </div>
          ) : (
            <section className="mission-lanes" aria-label="Mission control task lanes">
              {LANES.map((lane) => {
                const laneTasks = tasks.filter((task) => lane.statuses.includes(task.status));
                return (
                  <section className="mission-lane" key={lane.id} aria-label={`${lane.label} tasks`}>
                    <header>
                      <span>{lane.label}</span>
                      <strong>{laneTasks.length}</strong>
                    </header>
                    <div className="mission-task-list">
                      {laneTasks.map((task) => (
                        <TaskCard
                          actionPending={actionPending}
                          key={task.id}
                          sessionId={sessionId}
                          task={task}
                          onAction={runAction}
                          onInspectThread={inspectThread}
                        />
                      ))}
                    </div>
                  </section>
                );
              })}
            </section>
          )}
        </>
      )}
    </main>
  );
}

function SummaryMetric({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function TaskCard({
  task,
  sessionId,
  actionPending,
  onAction,
  onInspectThread,
}: {
  task: MissionTask;
  sessionId: string;
  actionPending: boolean;
  onAction: (action: DesktopProjectAction) => Promise<boolean>;
  onInspectThread: (threadId: string) => void;
}) {
  const latestEvidence = task.evidence.at(-1);
  const base = actionBase(sessionId);
  return (
    <article className={`mission-task task-${task.status}`}>
      <div className="mission-task-heading">
        <span>{task.id}</span>
        <span className={`priority priority-${task.priority}`}>{task.priority}</span>
      </div>
      <h2>{task.title}</h2>
      <p>{task.instructions}</p>
      <div className="mission-task-meta">
        {task.status === "needs_attention" ? <AlertTriangle size={13} /> : null}
        <span>{statusLabel(task.status)}</span>
        {task.threadId !== undefined ? <code>{truncateId(task.threadId)}</code> : null}
      </div>
      {latestEvidence !== undefined ? (
        <div className="mission-evidence" title={latestEvidence.summary}>
          <span>{latestEvidence.summary}</span>
          <time>{formatTime(latestEvidence.timestamp)}</time>
        </div>
      ) : null}
      <div className="mission-task-actions">
        {task.threadId !== undefined ? (
          <TaskActionButton
            disabled={actionPending}
            label="Inspect runtime thread"
            icon={<ExternalLink size={14} />}
            onClick={async () => onInspectThread(task.threadId!)}
          />
        ) : null}
        {task.status === "proposed" ? (
          <>
            <TaskActionButton
              disabled={actionPending}
              label="Approve task"
              icon={<Check size={14} />}
              onClick={() => onAction({ ...base, type: "task.approve", taskId: task.id })}
            />
            <TaskActionButton
              disabled={actionPending}
              label="Discard task"
              icon={<Trash2 size={14} />}
              onClick={() => onAction({ ...base, type: "task.discard", taskId: task.id })}
            />
          </>
        ) : null}
        {task.status === "queued" ? (
          <TaskActionButton
            disabled={actionPending}
            label="Mark task running"
            icon={<Play size={14} />}
            onClick={() => onAction({ ...base, type: "task.mark_running", taskId: task.id })}
          />
        ) : null}
        {task.status === "running" ? (
          <TaskActionButton
            disabled={actionPending}
            label="Stop task"
            icon={<Square size={13} fill="currentColor" />}
            onClick={() => onAction({ ...base, type: "task.stop", taskId: task.id })}
          />
        ) : null}
        {task.status === "needs_attention" ? (
          <>
            <TaskActionButton
              disabled={actionPending}
              label="Retry task"
              icon={<RotateCcw size={14} />}
              onClick={() => onAction({ ...base, type: "task.retry", taskId: task.id })}
            />
            <TaskActionButton
              disabled={actionPending}
              label="Discard task"
              icon={<Trash2 size={14} />}
              onClick={() => onAction({ ...base, type: "task.discard", taskId: task.id })}
            />
          </>
        ) : null}
        {task.status === "ready_for_review" ? (
          <>
            <TaskActionButton
              disabled={actionPending}
              label="Accept task"
              icon={<Check size={14} />}
              onClick={() => onAction({ ...base, type: "task.accept", taskId: task.id })}
            />
            <TaskActionButton
              disabled={actionPending}
              label="Request changes"
              icon={<Undo2 size={14} />}
              onClick={() => onAction({ ...base, type: "task.request_changes", taskId: task.id })}
            />
          </>
        ) : null}
      </div>
    </article>
  );
}

function TaskActionButton({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  disabled: boolean;
  onClick: () => Promise<unknown>;
}) {
  return (
    <button
      className="icon-button"
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={() => void onClick()}
    >
      {icon}
    </button>
  );
}

function actionBase(sessionId: string) {
  return {
    sessionId,
    actionId: crypto.randomUUID(),
    actionTs: new Date().toISOString(),
  };
}

function compareTasks(left: MissionTask, right: MissionTask): number {
  return left.order - right.order
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id);
}

function statusLabel(status: MissionTaskStatus): string {
  return status.replaceAll("_", " ");
}

function truncateId(value: string): string {
  return value.length <= 18 ? value : `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : "";
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
