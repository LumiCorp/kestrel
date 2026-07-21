import { Columns2, FileCode2, RefreshCw, RotateCcw, Rows3, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { DesktopWorkspaceChangeMutation, DesktopWorkspaceChangeScope, DesktopWorkspaceChangeSnapshot, DesktopWorkspaceFeedbackSnapshot } from "../../src/contracts";

export function DiffWorkspace(props: {
  sessionId: string;
  threadId: string;
  defaultBaseRef?: string | undefined;
  initialScopeKind?: DesktopWorkspaceChangeScope["kind"] | undefined;
  initialRevision?: string | undefined;
  initialView?: "unified" | "side-by-side" | undefined;
  onPreferencesChange?: ((value: { scopeKind: DesktopWorkspaceChangeScope["kind"]; revision: string; view: "unified" | "side-by-side" }) => void) | undefined;
  onOpenFile: (path: string, line?: number) => void;
  onError: (message: string | undefined) => void;
}) {
  const [scopeKind, setScopeKind] = useState<DesktopWorkspaceChangeScope["kind"]>(props.initialScopeKind ?? "uncommitted");
  const [revision, setRevision] = useState(props.initialRevision || props.defaultBaseRef || "main");
  const [snapshot, setSnapshot] = useState<DesktopWorkspaceChangeSnapshot>();
  const [view, setView] = useState<"unified" | "side-by-side">(props.initialView ?? "unified");
  const [filter, setFilter] = useState("");
  const [contextLines, setContextLines] = useState(3);
  const [whitespace, setWhitespace] = useState<"show" | "ignore_all" | "ignore_eol">("show");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<DesktopWorkspaceFeedbackSnapshot>();
  const [commentTarget, setCommentTarget] = useState<{ path: string; line: number }>();
  const [commentDraft, setCommentDraft] = useState("");
  const [selectedComments, setSelectedComments] = useState<string[]>([]);

  const scope = useMemo<DesktopWorkspaceChangeScope>(() => scopeKind === "branch"
    ? { kind: "branch", baseRef: revision || "main" }
    : scopeKind === "commit"
      ? { kind: "commit", commitSha: revision || "HEAD" }
      : scopeKind === "pull_request"
        ? { kind: "pull_request", ...(Number.isInteger(Number(revision)) && Number(revision) > 0 ? { number: Number(revision) } : {}) }
        : scopeKind === "latest_run"
          ? { kind: "latest_run", ...(revision.trim() ? { runId: revision.trim() } : {}) }
          : scopeKind === "latest_turn"
            ? { kind: "latest_turn", ...(revision.trim() ? { turnId: revision.trim() } : {}) }
          : scopeKind === "promotion"
            ? { kind: "promotion", promotionId: revision.trim() }
      : { kind: scopeKind }, [revision, scopeKind]);

  useEffect(() => { props.onPreferencesChange?.({ scopeKind, revision, view }); }, [scopeKind, revision, view]);

  const refresh = async (quiet = false) => {
    if (!quiet) setBusy(true);
    try {
      const next = await window.kestrelDesktop.inspectWorkspaceChanges({ sessionId: props.sessionId, threadId: props.threadId, scope, options: { contextLines, whitespace } });
      setSnapshot(next);
      setFeedback(await window.kestrelDesktop.listWorkspaceFeedback({ sessionId: props.sessionId, threadId: props.threadId }));
      props.onError(undefined);
    } catch (cause) {
      if (!quiet) props.onError(errorMessage(cause));
    } finally {
      if (!quiet) setBusy(false);
    }
  };

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 2000);
    return () => window.clearInterval(timer);
  }, [props.sessionId, props.threadId, scopeKind, revision, contextLines, whitespace]);

  const mutate = async (mutation: DesktopWorkspaceChangeMutation) => {
    if (!snapshot) return;
    if (mutation.operation === "revert_file" && !window.confirm(`Revert all unstaged changes in ${mutation.path}? This cannot be undone from the Diff pane.`)) return;
    if (mutation.operation === "revert_hunk" && !window.confirm(`Revert the selected unstaged hunk in ${mutation.path}? This cannot be undone from the Diff pane.`)) return;
    setBusy(true);
    try {
      const result = await window.kestrelDesktop.mutateWorkspaceChanges({
        sessionId: props.sessionId,
        threadId: props.threadId,
        expectedFingerprint: snapshot.candidateFingerprint,
        scope,
        options: { contextLines, whitespace },
        mutation,
      });
      setSnapshot(result.snapshot);
      props.onError(undefined);
    } catch (cause) {
      props.onError(errorMessage(cause));
      await refresh(true);
    } finally { setBusy(false); }
  };

  const files = snapshot?.files.filter((file) => !filter || file.path.toLocaleLowerCase().includes(filter.toLocaleLowerCase())) ?? [];
  const addComment = async () => {
    if (!((snapshot && commentTarget ) && commentDraft.trim())) return;
    setBusy(true);
    try {
      setFeedback(await window.kestrelDesktop.addWorkspaceFeedback({ sessionId: props.sessionId, threadId: props.threadId, candidateFingerprint: snapshot.candidateFingerprint, path: commentTarget.path, line: commentTarget.line, side: "RIGHT", body: commentDraft }));
      setCommentDraft("");
      setCommentTarget(undefined);
    } catch (cause) { props.onError(errorMessage(cause)); await refresh(true); } finally { setBusy(false); }
  };
  const removeComment = async (commentId: string) => {
    if (!snapshot) return;
    try { setFeedback(await window.kestrelDesktop.removeWorkspaceFeedback({ sessionId: props.sessionId, threadId: props.threadId, candidateFingerprint: snapshot.candidateFingerprint, commentId })); }
    catch (cause) { props.onError(errorMessage(cause)); await refresh(true); }
  };
  const submitFeedback = async () => {
    if (!snapshot || selectedComments.length === 0) return;
    setBusy(true);
    try {
      const result = await window.kestrelDesktop.submitWorkspaceFeedback({ sessionId: props.sessionId, threadId: props.threadId, candidateFingerprint: snapshot.candidateFingerprint, commentIds: selectedComments });
      setFeedback(result.snapshot);
      setSelectedComments([]);
      await refresh(true);
    } catch (cause) { props.onError(errorMessage(cause)); await refresh(true); } finally { setBusy(false); }
  };
  return <section className="diff-workspace">
    <header className="diff-toolbar">
      <select aria-label="Diff scope" value={scopeKind} onChange={(event) => { const next = event.target.value as DesktopWorkspaceChangeScope["kind"]; setScopeKind(next); if (next === "pull_request" || next === "latest_run" || next === "latest_turn" || next === "promotion") setRevision(""); }}>
        <option value="uncommitted">All uncommitted</option><option value="unstaged">Unstaged</option><option value="staged">Staged</option><option value="latest_turn">Latest agent turn</option><option value="latest_run">Latest agent run</option><option value="branch">Branch vs merge base</option><option value="commit">Commit</option><option value="promotion">Promotion candidate</option><option value="pull_request">Pull request</option>
      </select>
      {scopeKind === "branch" || scopeKind === "commit" || scopeKind === "pull_request" || scopeKind === "latest_run" || scopeKind === "latest_turn" || scopeKind === "promotion" ? <input aria-label={scopeKind === "branch" ? "Base ref" : scopeKind === "commit" ? "Commit SHA" : scopeKind === "pull_request" ? "Pull request number (blank for current)" : scopeKind === "latest_run" ? "Run ID (blank for latest)" : scopeKind === "latest_turn" ? "Turn ID (blank for latest)" : "Promotion ID"} value={revision} onChange={(event) => setRevision(event.target.value)} /> : null}
      <label className="diff-filter"><span className="sr-only">Filter files</span><Search size={14} /><input placeholder="Filter files" value={filter} onChange={(event) => setFilter(event.target.value)} /></label>
      <label>Context <input aria-label="Diff context lines" min={0} max={100} type="number" value={contextLines} onChange={(event) => setContextLines(Math.max(0, Math.min(100, Number(event.target.value) || 0)))} /></label>
      <select aria-label="Whitespace display" value={whitespace} onChange={(event) => setWhitespace(event.target.value as typeof whitespace)}><option value="show">Show whitespace</option><option value="ignore_eol">Ignore end whitespace</option><option value="ignore_all">Ignore all whitespace</option></select>
      <button className={view === "unified" ? "active" : ""} type="button" onClick={() => setView("unified")}><Rows3 size={14} /> Unified</button>
      <button className={view === "side-by-side" ? "active" : ""} type="button" onClick={() => setView("side-by-side")}><Columns2 size={14} /> Side by side</button>
      <button type="button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={14} /> Refresh</button>
    </header>
    {snapshot ? <div className="diff-identity">
      <span>{snapshot.currentBranch || "detached"} · {snapshot.headSha?.slice(0, 10) || "unborn"}</span>
      <span>{snapshot.files.length} files · +{snapshot.files.reduce((sum, file) => sum + file.additions, 0)} −{snapshot.files.reduce((sum, file) => sum + file.deletions, 0)} · ahead {snapshot.ahead} / behind {snapshot.behind}{snapshot.conflicted ? " · conflicts" : ""}</span>
      <code title={snapshot.candidateFingerprint}>{snapshot.candidateFingerprint.slice(0, 22)}…</code>
    </div> : null}
    <div className="diff-layout">
      <aside className="diff-files">
        {files.map((file) => <article key={`${file.path}:${file.staged}:${file.unstaged}`}>
          <button className="diff-file-name" type="button" onClick={() => props.onOpenFile(file.path)}><FileCode2 size={14} /><span>{file.path}</span></button>
          <div><span>{file.status}</span><span>+{file.additions} −{file.deletions}{file.binary ? " · binary" : ""}</span></div>
          <div className="diff-file-actions">
            {snapshot?.readOnly === false && file.unstaged && (scopeKind === "uncommitted" || scopeKind === "unstaged") ? <button disabled={busy} type="button" onClick={() => void mutate({ operation: "stage_file", path: file.path })}>Stage</button> : null}
            {snapshot?.readOnly === false && file.staged ? <button disabled={busy} type="button" onClick={() => void mutate({ operation: "unstage_file", path: file.path })}>Unstage</button> : null}
            {snapshot?.readOnly === false && file.unstaged && file.status !== "untracked" ? <button className="danger" disabled={busy} type="button" onClick={() => void mutate({ operation: "revert_file", path: file.path, confirmation: "revert_file" })}><RotateCcw size={12} /> Revert</button> : null}
          </div>
          {snapshot?.hunks.filter((hunk) => hunk.filePath === file.path).map((hunk) => <div className="diff-hunk-actions" key={hunk.hunkId}>
            <button className="diff-hunk-link" type="button" onClick={() => document.getElementById(`diff-hunk-${hunk.hunkId}`)?.scrollIntoView({ behavior: "smooth", block: "center" })}>View hunk {hunk.newStart}</button>
            {snapshot.readOnly ? null : <button className="diff-hunk-link" type="button" onClick={() => setCommentTarget({ path: hunk.filePath, line: hunk.newStart })}>Comment at line {hunk.newStart}</button>}
            {hunk.origin === "unstaged" && file.status !== "untracked" ? <button disabled={busy} type="button" onClick={() => void mutate({ operation: "stage_hunk", path: hunk.filePath, hunkId: hunk.hunkId })}>Stage hunk</button> : null}
            {hunk.origin === "staged" ? <button disabled={busy} type="button" onClick={() => void mutate({ operation: "unstage_hunk", path: hunk.filePath, hunkId: hunk.hunkId })}>Unstage hunk</button> : null}
            {hunk.origin === "unstaged" && file.status !== "untracked" ? <button className="danger" disabled={busy} type="button" onClick={() => void mutate({ operation: "revert_hunk", path: hunk.filePath, hunkId: hunk.hunkId, confirmation: "revert_hunk" })}>Revert hunk</button> : null}
          </div>)}
        </article>)}
        {files.length === 0 ? <p className="rail-empty">No changes in this scope.</p> : null}
      </aside>
      <main className={`diff-view diff-view-${view}`}>
        <section className="diff-feedback">
          <header><strong>Candidate feedback</strong><button type="button" disabled={busy || selectedComments.length === 0} onClick={() => void submitFeedback()}>Send selected to coding thread</button></header>
          {commentTarget ? <div className="diff-comment-compose"><span>{commentTarget.path}:{commentTarget.line}</span><textarea value={commentDraft} onChange={(event) => setCommentDraft(event.target.value)} placeholder="Line-specific feedback" /><button type="button" disabled={busy || !commentDraft.trim()} onClick={() => void addComment()}>Add feedback</button><button type="button" onClick={() => setCommentTarget(undefined)}>Cancel</button></div> : null}
          {feedback?.comments.map((comment) => <article className={`diff-feedback-comment status-${comment.status}`} key={comment.commentId}>
            <label><input type="checkbox" disabled={comment.status !== "pending" || comment.candidateFingerprint !== snapshot?.candidateFingerprint} checked={selectedComments.includes(comment.commentId)} onChange={(event) => setSelectedComments((current) => event.target.checked ? [...current, comment.commentId] : current.filter((id) => id !== comment.commentId))} /><span>{comment.path}:{comment.line}</span></label>
            <p>{comment.body}</p><span>{comment.status}{comment.submissionRunId ? ` · run ${comment.submissionRunId}` : ""}</span>
            {comment.status === "pending" ? <button type="button" onClick={() => void removeComment(comment.commentId)}>Remove</button> : null}
          </article>)}
          {feedback?.comments.length === 0 ? <p>No candidate feedback.</p> : null}
        </section>
        {snapshot?.truncated ? <div className="notice-strip">Diff output is truncated at 4 MiB. File counts and fingerprint cover the full candidate.</div> : null}
        {snapshot?.hunks.length ? <section className="diff-hunk-index" aria-label="Diff hunks">{snapshot.hunks.map((hunk) => <article id={`diff-hunk-${hunk.hunkId}`} key={hunk.hunkId}><header><button type="button" onClick={() => props.onOpenFile(hunk.filePath, hunk.newStart)}>{hunk.filePath}:{hunk.newStart}</button><span>{hunk.origin}</span></header><code>{hunk.header}</code><pre>{hunk.lines.join("\n")}</pre></article>)}</section> : null}
        {view === "unified" ? <pre>{snapshot?.diff || "No textual diff."}</pre> : <SideBySideDiff diff={snapshot?.diff ?? ""} />}
      </main>
    </div>
  </section>;
}

function SideBySideDiff({ diff }: { diff: string }) {
  const rows = diff.split("\n").map((line, index) => line.startsWith("-") && !line.startsWith("---")
    ? { key: index, left: line, right: "" }
    : line.startsWith("+") && !line.startsWith("+++")
      ? { key: index, left: "", right: line }
      : { key: index, left: line, right: line });
  return <div className="side-by-side-diff">{rows.map((row) => <div key={row.key}><code>{row.left}</code><code>{row.right}</code></div>)}</div>;
}

function errorMessage(cause: unknown): string { return cause instanceof Error ? cause.message : String(cause); }
