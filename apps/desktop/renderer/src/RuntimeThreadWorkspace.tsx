import { ArrowUpRight, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import type {
  DesktopRuntimeThreadInspection,
  DesktopRuntimeThreadSummary,
} from "../../src/contracts";

interface RuntimeThreadWorkspaceProps {
  threadId: string;
  onError: (message: string | undefined) => void;
  onSelectRun: (runId: string) => void;
  onSelectThread: (threadId: string) => void;
}

export function RuntimeThreadWorkspace({
  threadId,
  onError,
  onSelectRun,
  onSelectThread,
}: RuntimeThreadWorkspaceProps) {
  const [inspection, setInspection] = useState<DesktopRuntimeThreadInspection>();
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setInspection(undefined);
    void window.kestrelDesktop.getOperatorThread(threadId)
      .then((nextInspection) => {
        if (disposed === false) {
          setInspection(nextInspection);
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
  }, [onError, reloadKey, threadId]);

  if (loading && inspection === undefined) {
    return (
      <div className="mission-empty runtime-thread-empty">
        <span>Loading runtime thread</span>
      </div>
    );
  }

  if (inspection === undefined) {
    return (
      <div className="mission-empty runtime-thread-empty">
        <span>Runtime thread unavailable</span>
        <button
          className="icon-button"
          type="button"
          title="Retry runtime thread"
          aria-label="Retry runtime thread"
          onClick={() => setReloadKey((value) => value + 1)}
        >
          <RefreshCw size={15} />
        </button>
      </div>
    );
  }

  const { thread } = inspection;
  return (
    <section className="runtime-thread-workspace" aria-label="Runtime thread inspection">
      <header className="runtime-thread-header">
        <div>
          <span className="surface-kicker">Runtime thread</span>
          <h2>{thread.title}</h2>
          <code title={thread.threadId}>{thread.threadId}</code>
        </div>
        <button
          className="icon-button"
          type="button"
          title="Refresh runtime thread"
          aria-label="Refresh runtime thread"
          onClick={() => setReloadKey((value) => value + 1)}
        >
          <RefreshCw size={15} />
        </button>
      </header>

      <section className="runtime-thread-summary" aria-label="Runtime thread summary">
        <ThreadMetric label="Status" value={formatToken(thread.status)} />
        <ThreadMetric label="Operator phase" value={formatToken(inspection.operatorPhase ?? "not recorded")} />
        <ThreadMetric label="Active run" value={thread.activeRunId ?? "None"} code />
        <ThreadMetric label="Updated" value={formatDate(thread.updatedAt)} />
      </section>

      <div className="runtime-thread-details">
        <section className="runtime-thread-section">
          <h3>Execution</h3>
          <dl className="runtime-thread-fields">
            <ThreadField label="Session" value={thread.sessionId} code />
            {thread.activeRunId === undefined ? (
              <ThreadField label="Active run" value="None" code />
            ) : (
              <RunLink runId={thread.activeRunId} onSelect={onSelectRun} />
            )}
            <ThreadField label="Last run status" value={formatToken(thread.lastRunStatus ?? "not recorded")} />
            <ThreadField label="Profile" value={thread.agentProfileLabel ?? thread.agentProfileId ?? "Default"} />
            <ThreadField label="Current request" value={thread.currentRequestId ?? "None"} code />
            <ThreadField label="Created" value={formatDate(thread.createdAt)} />
          </dl>
        </section>

        <section className="runtime-thread-section">
          <h3>Operator state</h3>
          <div className="runtime-thread-signal">
            <span>Blocker</span>
            <strong>{inspection.blocker === undefined ? "None" : formatToken(inspection.blocker.kind)}</strong>
            <p>{inspection.blocker?.summary ?? "No active blocker reported."}</p>
          </div>
          <div className="runtime-thread-signal">
            <span>Next action</span>
            <strong>{formatToken(inspection.nextAction?.kind ?? "not recorded")}</strong>
            <p>{inspection.nextAction?.summary ?? "No next action reported."}</p>
          </div>
          {inspection.latestSteering !== undefined ? (
            <div className="runtime-thread-signal">
              <span>Latest steering</span>
              <strong>{inspection.latestSteering.issuedBy ?? "Operator"}</strong>
              <p>{inspection.latestSteering.message}</p>
            </div>
          ) : null}
        </section>

        <section className="runtime-thread-section">
          <h3>Runtime plan</h3>
          <dl className="runtime-thread-fields">
            <ThreadField label="Phase" value={formatToken(inspection.runtimePlan?.phase ?? "not recorded")} />
            <ThreadField label="Status" value={formatToken(inspection.runtimePlan?.status ?? "not recorded")} />
            <ThreadField label="Current chunk" value={inspection.runtimePlan?.currentChunk ?? "None"} />
            <ThreadField label="Next command" value={inspection.runtimePlan?.expectedNextCommand ?? "None"} code />
            <ThreadField label="Wait reason" value={inspection.runtimePlan?.waitReason ?? "None"} />
            <ThreadField label="Plan blocker" value={inspection.runtimePlan?.blocker ?? "None"} />
          </dl>
          {inspection.runtimePlan?.commandNames !== undefined
            && inspection.runtimePlan.commandNames.length > 0 ? (
              <div className="runtime-thread-commands">
                {inspection.runtimePlan.commandNames.map((command) => <code key={command}>{command}</code>)}
              </div>
            ) : null}
        </section>

        <section className="runtime-thread-section">
          <h3>Related threads</h3>
          <div className="runtime-thread-related">
            {inspection.parentThread !== undefined ? (
              <ThreadLink
                label="Parent"
                thread={inspection.parentThread}
                onSelect={onSelectThread}
              />
            ) : null}
            {inspection.childThreads.map((child) => (
              <ThreadLink
                key={child.threadId}
                label="Child"
                thread={child}
                onSelect={onSelectThread}
              />
            ))}
            {inspection.parentThread === undefined && inspection.childThreads.length === 0 ? (
              <p className="runtime-thread-related-empty">No related runtime threads.</p>
            ) : null}
          </div>
        </section>
      </div>
    </section>
  );
}

function RunLink({
  runId,
  onSelect,
}: {
  runId: string;
  onSelect: (runId: string) => void;
}) {
  return (
    <div className="runtime-thread-run-link">
      <dt>Active run</dt>
      <dd>
        <button
          type="button"
          title="Inspect active runtime run"
          onClick={() => onSelect(runId)}
        >
          <code title={runId}>{runId}</code>
          <ArrowUpRight size={14} />
        </button>
      </dd>
    </div>
  );
}

function ThreadMetric({
  label,
  value,
  code = false,
}: {
  label: string;
  value: string;
  code?: boolean | undefined;
}) {
  return (
    <div>
      <span>{label}</span>
      {code ? <code title={value}>{truncateId(value)}</code> : <strong>{value}</strong>}
    </div>
  );
}

function ThreadField({
  label,
  value,
  code = false,
}: {
  label: string;
  value: string;
  code?: boolean | undefined;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{code ? <code title={value}>{value}</code> : value}</dd>
    </div>
  );
}

function ThreadLink({
  label,
  thread,
  onSelect,
}: {
  label: string;
  thread: DesktopRuntimeThreadSummary;
  onSelect: (threadId: string) => void;
}) {
  return (
    <button type="button" onClick={() => onSelect(thread.threadId)}>
      <span>{label}</span>
      <strong>{thread.title}</strong>
      <code>{truncateId(thread.threadId)}</code>
      <em>{formatToken(thread.status)}</em>
      <ArrowUpRight size={14} />
    </button>
  );
}

function formatToken(value: string): string {
  return value.replaceAll("_", " ").toLowerCase();
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
    : value;
}

function truncateId(value: string): string {
  return value.length <= 22 ? value : `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
