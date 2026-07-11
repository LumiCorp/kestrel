import { ExternalLink, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type {
  DesktopRuntimeRunIndex,
  DesktopRuntimeRunIndexEntry,
  DesktopRuntimeRunStatus,
} from "../../src/contracts";

type RuntimeRunScope = "all" | "current";
type RuntimeRunStatusFilter = "ALL" | DesktopRuntimeRunStatus;

interface RuntimeRunsWorkspaceProps {
  sessionId: string;
  refreshVersion: number;
  onError: (message: string | undefined) => void;
  onSelectRun: (runId: string) => void;
}

export function RuntimeRunsWorkspace({
  sessionId,
  refreshVersion,
  onError,
  onSelectRun,
}: RuntimeRunsWorkspaceProps) {
  const [index, setIndex] = useState<DesktopRuntimeRunIndex>();
  const [loading, setLoading] = useState(true);
  const [scope, setScope] = useState<RuntimeRunScope>("all");
  const [status, setStatus] = useState<RuntimeRunStatusFilter>("ALL");
  const [query, setQuery] = useState("");

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    void window.kestrelDesktop.listOperatorRuns({
      ...(scope === "current" ? { sessionId } : {}),
      ...(status !== "ALL" ? { status } : {}),
      limit: 40,
    })
      .then((nextIndex) => {
        if (disposed === false) {
          setIndex(nextIndex);
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
  }, [onError, refreshVersion, scope, sessionId, status]);

  const runs = useMemo(
    () => filterRuntimeRunIndexEntries(index?.runs ?? [], query),
    [index, query],
  );
  const activeCount = index?.runs.filter((entry) => entry.run.status === "RUNNING").length ?? 0;
  const waitingCount = index?.runs.filter((entry) => entry.run.status === "WAITING").length ?? 0;
  const failedCount = index?.runs.filter((entry) => entry.run.status === "FAILED").length ?? 0;

  return (
    <section className="runtime-index-workspace" aria-label="Runtime runs">
      <section className="mission-summary runtime-index-summary" aria-label="Runtime run summary">
        <SummaryMetric label="Runs" value={index?.runs.length ?? 0} />
        <SummaryMetric label="Active" value={activeCount} />
        <SummaryMetric label="Waiting" value={waitingCount} />
        <SummaryMetric label="Failed" value={failedCount} />
        <SummaryMetric label="Sessions" value={index?.sessions.length ?? 0} />
      </section>

      <div className="runtime-index-toolbar">
        <div className="runtime-index-segmented" aria-label="Runtime run scope">
          <button
            type="button"
            className={scope === "current" ? "active" : ""}
            onClick={() => setScope("current")}
          >
            Current session
          </button>
          <button
            type="button"
            className={scope === "all" ? "active" : ""}
            onClick={() => setScope("all")}
          >
            All sessions
          </button>
        </div>
        <label className="runtime-index-search">
          <Search size={14} />
          <input
            type="search"
            aria-label="Search runtime runs"
            placeholder="Search runs"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <select
          aria-label="Filter runtime runs by status"
          value={status}
          onChange={(event) => setStatus(event.target.value as RuntimeRunStatusFilter)}
        >
          <option value="ALL">All statuses</option>
          <option value="RUNNING">Running</option>
          <option value="WAITING">Waiting</option>
          <option value="COMPLETED">Completed</option>
          <option value="FAILED">Failed</option>
        </select>
      </div>

      {scope === "all" && (index?.sessions.length ?? 0) > 0 ? (
        <div className="runtime-session-index">
          <table>
            <thead>
              <tr>
                <th>Session</th>
                <th>Runs</th>
                <th>Active</th>
                <th>Waiting</th>
                <th>Failed</th>
                <th>Latest</th>
              </tr>
            </thead>
            <tbody>
              {index?.sessions.map((session) => (
                <tr key={session.sessionId}>
                  <td><code title={session.sessionId}>{truncateId(session.sessionId)}</code></td>
                  <td>{session.runCount}</td>
                  <td>{session.statusCounts.RUNNING}</td>
                  <td>{session.statusCounts.WAITING}</td>
                  <td>{session.statusCounts.FAILED}</td>
                  <td>
                    <button
                      className="icon-button"
                      type="button"
                      title="Open latest run"
                      aria-label={`Open latest run for ${session.sessionId}`}
                      onClick={() => onSelectRun(session.latestRunId)}
                    >
                      <ExternalLink size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {loading && index === undefined ? (
        <div className="mission-empty"><span>Loading runtime runs</span></div>
      ) : runs.length === 0 ? (
        <div className="mission-empty"><span>No runtime runs</span></div>
      ) : (
        <div className="runtime-run-index">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
                <th>Session</th>
                <th>Started</th>
                <th>Final step</th>
                <th>Events</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {runs.map((entry) => (
                <tr key={entry.run.runId}>
                  <td><code title={entry.run.runId}>{truncateId(entry.run.runId)}</code></td>
                  <td><span className={`runtime-status status-${entry.run.status.toLowerCase()}`}>{entry.run.status}</span></td>
                  <td><code title={entry.run.sessionId}>{truncateId(entry.run.sessionId)}</code></td>
                  <td><time dateTime={entry.run.startedAt}>{formatDateTime(entry.run.startedAt)}</time></td>
                  <td>{entry.diagnosis.finalStep ?? entry.diagnosis.terminalReasonCode ?? "-"}</td>
                  <td>{entry.summary.eventCount}{entry.summary.truncated ? "+" : ""}</td>
                  <td>
                    <button
                      className="icon-button"
                      type="button"
                      title="Inspect runtime run"
                      aria-label={`Inspect runtime run ${entry.run.runId}`}
                      onClick={() => onSelectRun(entry.run.runId)}
                    >
                      <ExternalLink size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {index?.hasMore === true ? <p className="runtime-index-note">More runs are available.</p> : null}
    </section>
  );
}

export function filterRuntimeRunIndexEntries(
  runs: DesktopRuntimeRunIndexEntry[],
  query: string,
): DesktopRuntimeRunIndexEntry[] {
  const normalized = query.trim().toLowerCase();
  if (normalized.length === 0) {
    return runs;
  }
  return runs.filter((entry) => [
    entry.run.runId,
    entry.run.sessionId,
    entry.run.eventType,
    entry.run.status,
    entry.threadId ?? "",
    entry.diagnosis.finalStep ?? "",
    entry.diagnosis.terminalReasonCode ?? "",
    entry.diagnosis.dominantFailure?.classification ?? "",
    entry.diagnosis.dominantFailure?.message ?? "",
  ].join(" ").toLowerCase().includes(normalized));
}

function SummaryMetric({ label, value }: { label: string; value: number }) {
  return <div><span>{label}</span><strong>{value}</strong></div>;
}

function truncateId(value: string): string {
  return value.length <= 20 ? value : `${value.slice(0, 9)}...${value.slice(-7)}`;
}

function formatDateTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : value;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}
