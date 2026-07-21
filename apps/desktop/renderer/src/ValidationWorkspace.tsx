import { CheckCircle2, CircleStop, FlaskConical, Play, RefreshCw, Send, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { DesktopWorkspaceValidationSnapshot } from "../../src/contracts";

export function ValidationWorkspace(props: {
  sessionId: string;
  threadId: string;
  onOpenFile: (path: string, line?: number) => void;
  onError: (message: string | undefined) => void;
}) {
  const [snapshot, setSnapshot] = useState<DesktopWorkspaceValidationSnapshot>();
  const [selectedResultId, setSelectedResultId] = useState<string>();
  const [selectedFailures, setSelectedFailures] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [followUpRunId, setFollowUpRunId] = useState<string>();
  const refresh = async (quiet = false) => {
    if (!quiet) setBusy(true);
    try {
      setSnapshot(await window.kestrelDesktop.inspectWorkspaceValidation({ sessionId: props.sessionId, threadId: props.threadId }));
      if (!quiet) props.onError(undefined);
    } catch (cause) {
      if (!quiet) props.onError(message(cause));
    } finally {
      if (!quiet) setBusy(false);
    }
  };
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 1_000);
    return () => window.clearInterval(timer);
  }, [props.sessionId, props.threadId]);
  const run = async (target: { actionId: string } | { suiteId: string }) => {
    if (!snapshot) return;
    setBusy(true);
    try {
      setSnapshot(await window.kestrelDesktop.runWorkspaceValidation({ sessionId: props.sessionId, threadId: props.threadId, candidateFingerprint: snapshot.candidateFingerprint, ...target }));
      props.onError(undefined);
    } catch (cause) {
      props.onError(message(cause));
      await refresh(true);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (resultId: string) => {
    setBusy(true);
    try {
      setSnapshot(await window.kestrelDesktop.cancelWorkspaceValidation({ sessionId: props.sessionId, threadId: props.threadId, resultId }));
    } catch (cause) {
      props.onError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const submit = async () => {
    if (selectedFailures.length === 0) return;
    setBusy(true);
    try {
      const response = await window.kestrelDesktop.submitWorkspaceValidationFailures({ sessionId: props.sessionId, threadId: props.threadId, resultIds: selectedFailures });
      setSnapshot(response.snapshot);
      setFollowUpRunId(response.runId);
      setSelectedFailures([]);
    } catch (cause) {
      props.onError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const latestByAction = useMemo(() => {
    const result = new Map<string, DesktopWorkspaceValidationSnapshot["results"][number]>();
    for (const candidate of snapshot?.results ?? []) if (!result.has(candidate.actionId)) result.set(candidate.actionId, candidate);
    return result;
  }, [snapshot]);
  const activeResult = snapshot?.results.find((result) => result.resultId === selectedResultId) ?? snapshot?.results[0];
  return <section className="validation-workspace">
    <header className="diff-toolbar">
      <div className={`validation-readiness state-${snapshot?.readiness.state ?? "not_run"}`}>
        <FlaskConical size={15} />
        <strong>{snapshot?.readiness.state.replace("_", " ") ?? "loading"}</strong>
        <span>{snapshot?.readiness.message}</span>
      </div>
      <button disabled={busy} type="button" onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</button>
      <button disabled={busy || selectedFailures.length === 0} type="button" onClick={() => void submit()}><Send size={14} /> Send selected failures</button>
    </header>
    {snapshot ? <div className="diff-identity">
      <span>{snapshot.actions.length} actions · {snapshot.readiness.passed}/{snapshot.readiness.required} required passed</span>
      <code title={snapshot.candidateFingerprint}>{snapshot.candidateFingerprint.slice(0, 22)}…</code>
    </div> : null}
    {followUpRunId ? <div className="notice-strip">Failure follow-up is traceable to run {followUpRunId}.</div> : null}
    <div className="validation-layout">
      <aside className="validation-actions">
        {snapshot?.suites.map((suite) => <article key={suite.suiteId}>
          <div><strong>{suite.label}</strong><small>{suite.actionIds.length} ordered actions</small></div>
          <button disabled={busy} type="button" onClick={() => void run({ suiteId: suite.suiteId })}><Play size={13} /> Run suite</button>
        </article>)}
        {snapshot?.actions.map((action) => {
          const latest = latestByAction.get(action.actionId);
          return <article key={action.actionId} className={`status-${latest?.outcome ?? "not_run"}`}>
            <button className="validation-action-name" type="button" onClick={() => latest && setSelectedResultId(latest.resultId)}>
              <strong>{action.label}</strong><small>{action.kind} · {latest?.outcome.replace("_", " ") ?? "not run"}</small>
            </button>
            <button disabled={busy || latest?.outcome === "running"} type="button" onClick={() => void run({ actionId: action.actionId })}><Play size={13} /> Run</button>
          </article>;
        })}
        {snapshot?.actions.length === 0 ? <p className="rail-empty">Configure .kestrel/validation.json or add package scripts.</p> : null}
      </aside>
      <main className="validation-results">
        {activeResult ? <article className={`validation-result status-${activeResult.outcome}`}>
          <header>
            <div>
              {activeResult.outcome === "passed" ? <CheckCircle2 size={16} /> : activeResult.outcome === "failed" ? <XCircle size={16} /> : <FlaskConical size={16} />}
              <strong>{activeResult.actionLabel}</strong><span>{activeResult.outcome.replace("_", " ")}</span>
            </div>
            {activeResult.outcome === "running" ? <button disabled={busy} type="button" onClick={() => void cancel(activeResult.resultId)}><CircleStop size={14} /> Cancel</button> : null}
            {activeResult.outcome === "failed" || activeResult.outcome === "stale" ? <label><input type="checkbox" checked={selectedFailures.includes(activeResult.resultId)} onChange={(event) => setSelectedFailures((current) => event.target.checked ? [...current, activeResult.resultId] : current.filter((id) => id !== activeResult.resultId))} /> Send to coding thread</label> : null}
          </header>
          <dl className="status-list">
            <div><dt>Command</dt><dd><code>{activeResult.command} {activeResult.args.join(" ")}</code></dd></div>
            <div><dt>Exit</dt><dd>{activeResult.exitCode ?? "—"}{activeResult.signal ? ` · ${activeResult.signal}` : ""}</dd></div>
            <div><dt>Duration</dt><dd>{activeResult.durationMs === undefined ? "running" : `${activeResult.durationMs} ms`}</dd></div>
            <div><dt>Candidate</dt><dd><code>{activeResult.candidateFingerprint.slice(0, 22)}…</code></dd></div>
            {activeResult.submissionRunId ? <div><dt>Follow-up</dt><dd>{activeResult.submissionRunId}</dd></div> : null}
          </dl>
          {activeResult.evidence.length > 0 ? <section className="validation-evidence"><strong>Evidence</strong>{activeResult.evidence.map((entry) => <button key={entry.path} disabled={!entry.exists} type="button" onClick={() => props.onOpenFile(entry.path)}>{entry.exists ? "Available" : "Missing"} · {entry.path}</button>)}</section> : null}
          {activeResult.locations.length > 0 ? <section className="validation-evidence"><strong>Source locations</strong>{activeResult.locations.map((entry, index) => <button key={`${entry.path}:${entry.line}:${index}`} type="button" onClick={() => props.onOpenFile(entry.path, entry.line)}>{entry.path}:{entry.line}{entry.column ? `:${entry.column}` : ""}{entry.message ? ` · ${entry.message}` : ""}</button>)}</section> : null}
          {activeResult.outputTruncated ? <div className="notice-strip">Earlier output was truncated; the latest 512 KiB is retained.</div> : null}
          <pre>{activeResult.output.map((entry) => `[${entry.stream}] ${entry.text}`).join("") || "No output yet."}</pre>
        </article> : <p className="rail-empty">Run an action to collect candidate-bound validation evidence.</p>}
      </main>
    </div>
  </section>;
}

function message(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
