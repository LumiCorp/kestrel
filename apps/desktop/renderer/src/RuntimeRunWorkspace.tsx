import { ArrowUpRight, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import type {
  DesktopRuntimeRunInspection,
  DesktopRuntimeRunTimelineEntry,
} from "../../src/contracts";

interface RuntimeRunWorkspaceProps {
  runId: string;
  onError: (message: string | undefined) => void;
  onSelectThread: (threadId: string) => void;
}

export function RuntimeRunWorkspace({
  runId,
  onError,
  onSelectThread,
}: RuntimeRunWorkspaceProps) {
  const [inspection, setInspection] = useState<DesktopRuntimeRunInspection>();
  const [loading, setLoading] = useState(true);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setInspection(undefined);
    void window.kestrelDesktop.getOperatorRun(runId)
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
  }, [onError, reloadKey, runId]);

  if (loading && inspection === undefined) {
    return (
      <div className="mission-empty runtime-thread-empty">
        <span>Loading runtime run</span>
      </div>
    );
  }

  if (inspection === undefined) {
    return (
      <div className="mission-empty runtime-thread-empty">
        <span>Runtime run unavailable</span>
        <button
          className="icon-button"
          type="button"
          title="Retry runtime run"
          aria-label="Retry runtime run"
          onClick={() => setReloadKey((value) => value + 1)}
        >
          <RefreshCw size={15} />
        </button>
      </div>
    );
  }

  const { run } = inspection;
  return (
    <section className="runtime-thread-workspace runtime-run-workspace" aria-label="Runtime run inspection">
      <header className="runtime-thread-header">
        <div>
          <span className="surface-kicker">Runtime run</span>
          <h2>{formatEventLabel(run.eventType)}</h2>
          <code title={run.runId}>{run.runId}</code>
        </div>
        <button
          className="icon-button"
          type="button"
          title="Refresh runtime run"
          aria-label="Refresh runtime run"
          onClick={() => setReloadKey((value) => value + 1)}
        >
          <RefreshCw size={15} />
        </button>
      </header>

      <section className="runtime-thread-summary" aria-label="Runtime run summary">
        <RunMetric label="Status" value={formatToken(run.status)} />
        <RunMetric label="Diagnosis" value={formatToken(inspection.diagnosis.status)} />
        <RunMetric label="Events" value={String(inspection.summary.eventCount)} />
        <RunMetric label="Duration" value={formatDuration(run.startedAt, run.completedAt)} />
      </section>

      <div className="runtime-thread-details runtime-run-details">
        <section className="runtime-thread-section">
          <h3>Execution</h3>
          <dl className="runtime-thread-fields">
            <RunField label="Session" value={run.sessionId} code />
            <RunField label="Started" value={formatDate(run.startedAt)} />
            <RunField label="Completed" value={run.completedAt === undefined ? "In progress" : formatDate(run.completedAt)} />
            <RunField label="Final step" value={inspection.diagnosis.finalStep ?? "Not recorded"} code />
            <RunField label="Terminal reason" value={inspection.diagnosis.terminalReasonCode ?? "None"} code />
            <RunField label="Replay" value={inspection.summary.truncated ? "Truncated" : "Complete"} />
          </dl>
          {inspection.threadId !== undefined ? (
            <button
              className="runtime-run-thread-link"
              type="button"
              onClick={() => onSelectThread(inspection.threadId!)}
            >
              <span>Owning thread</span>
              <code title={inspection.threadId}>{truncateId(inspection.threadId)}</code>
              <ArrowUpRight size={14} />
            </button>
          ) : null}
        </section>

        <section className="runtime-thread-section">
          <h3>Diagnosis</h3>
          <div className="runtime-thread-signal">
            <span>Dominant failure</span>
            <strong>{formatToken(inspection.diagnosis.dominantFailure?.classification ?? "none")}</strong>
            <p>{inspection.diagnosis.dominantFailure?.message ?? "No dominant failure reported."}</p>
          </div>
          <div className="runtime-thread-signal">
            <span>Wait</span>
            <strong>{formatToken(inspection.diagnosis.wait?.kind ?? "none")}</strong>
            <p>{formatWait(inspection)}</p>
          </div>
          {inspection.diagnosis.latestReasoning !== undefined ? (
            <div className="runtime-thread-signal">
              <span>Latest reasoning</span>
              <strong>{formatDate(inspection.diagnosis.latestReasoning.at)}</strong>
              <p>{inspection.diagnosis.latestReasoning.message}</p>
            </div>
          ) : null}
          {run.error !== undefined ? (
            <div className="runtime-thread-signal runtime-run-error">
              <span>Run error</span>
              <strong>{run.error.code}</strong>
              <p>{run.error.message}</p>
            </div>
          ) : null}
        </section>

        <section className="runtime-thread-section">
          <h3>Runtime plan</h3>
          <dl className="runtime-thread-fields">
            <RunField label="Phase" value={formatToken(inspection.runtimePlan?.phase ?? "not recorded")} />
            <RunField label="Status" value={formatToken(inspection.runtimePlan?.status ?? "not recorded")} />
            <RunField label="Current chunk" value={inspection.runtimePlan?.currentChunk ?? "None"} />
            <RunField label="Next command" value={inspection.runtimePlan?.expectedNextCommand ?? "None"} code />
            <RunField label="Wait reason" value={inspection.runtimePlan?.waitReason ?? "None"} />
            <RunField label="Plan blocker" value={inspection.runtimePlan?.blocker ?? "None"} />
          </dl>
          {inspection.runtimePlan?.commandNames !== undefined
            && inspection.runtimePlan.commandNames.length > 0 ? (
              <div className="runtime-thread-commands">
                {inspection.runtimePlan.commandNames.map((command) => <code key={command}>{command}</code>)}
              </div>
            ) : null}
        </section>

        <section className="runtime-thread-section">
          <h3>Model provenance</h3>
          <dl className="runtime-thread-fields">
            <RunField label="Calls" value={String(inspection.modelProvenance.callCount)} />
            <RunField label="Action calls" value={String(inspection.modelProvenance.actionCallCount)} />
            <RunField label="Maintenance calls" value={String(inspection.modelProvenance.maintenanceCallCount)} />
            <RunField label="Providers" value={inspection.modelProvenance.providers.join(", ") || "None"} />
            <RunField label="Models" value={inspection.modelProvenance.models.join(", ") || "None"} />
            <RunField label="Retention" value={formatToken(inspection.modelProvenance.retention)} />
          </dl>
        </section>

        <section className="runtime-thread-section runtime-run-timeline">
          <header>
            <h3>Timeline</h3>
            <span>{inspection.timeline.length} entries</span>
          </header>
          {inspection.timeline.length === 0 ? (
            <p className="runtime-thread-related-empty">No replay events recorded.</p>
          ) : (
            <ol>
              {inspection.timeline.map((entry) => (
                <TimelineEntry key={`${entry.seq}:${entry.at}`} entry={entry} />
              ))}
            </ol>
          )}
        </section>
      </div>
    </section>
  );
}

function RunMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RunField({
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

function TimelineEntry({ entry }: { entry: DesktopRuntimeRunTimelineEntry }) {
  return (
    <li>
      <div className="runtime-run-timeline-meta">
        <code>#{entry.seq}</code>
        <time dateTime={entry.at}>{formatTimelineTime(entry.at)}</time>
        <span data-source={entry.source}>{formatToken(entry.source)}</span>
      </div>
      <div className="runtime-run-timeline-body">
        <strong>{formatEventLabel(entry.label)}</strong>
        {entry.detail !== undefined ? <p>{entry.detail}</p> : null}
        {entry.step !== undefined ? (
          <code>{entry.step}{entry.stepIndex === undefined ? "" : ` / ${entry.stepIndex}`}</code>
        ) : null}
      </div>
    </li>
  );
}

function formatWait(inspection: DesktopRuntimeRunInspection): string {
  const wait = inspection.diagnosis.wait;
  if (wait === undefined) {
    return "No active wait reported.";
  }
  return [wait.eventType, wait.requestId, wait.delegationId]
    .filter((value): value is string => value !== undefined)
    .join(" / ") || (wait.actionable ? "Operator action required." : "Runtime is waiting.");
}

function formatEventLabel(value: string): string {
  const normalized = value.replaceAll(".", " ").replaceAll("_", " ");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
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

function formatTimelineTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : value;
}

function formatDuration(startedAt: string, completedAt: string | undefined): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt === undefined ? Date.now() : new Date(completedAt).getTime();
  if (Number.isFinite(start) === false || Number.isFinite(end) === false || end < start) {
    return "Unknown";
  }
  const seconds = Math.floor((end - start) / 1_000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function truncateId(value: string): string {
  return value.length <= 22 ? value : `${value.slice(0, 10)}...${value.slice(-8)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
