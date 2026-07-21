import {
  GitBranch,
  GitCommit,
  GitPullRequest,
  MessageSquare,
  RefreshCw,
  Send,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type {
  DesktopExecutionSelection,
  DesktopWorkspaceGitAction,
  DesktopWorkspaceGitSnapshot,
} from "../../src/contracts";

export function GitWorkspace(props: {
  sessionId: string;
  threadId: string;
  defaultBaseRef: string;
  executionSelection: DesktopExecutionSelection;
  onError: (message: string | undefined) => void;
}) {
  const [snapshot, setSnapshot] = useState<DesktopWorkspaceGitSnapshot>();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [branchName, setBranchName] = useState("");
  const [commitMessage, setCommitMessage] = useState("");
  const [remote, setRemote] = useState("origin");
  const [baseBranch, setBaseBranch] = useState(props.defaultBaseRef || "main");
  const [prTitle, setPrTitle] = useState("");
  const [prBody, setPrBody] = useState("");
  const [draft, setDraft] = useState(true);
  const [comment, setComment] = useState("");
  const [commentPath, setCommentPath] = useState("");
  const [commentLine, setCommentLine] = useState("");
  const [commentSide, setCommentSide] = useState<"LEFT" | "RIGHT">("RIGHT");
  const refresh = async (quiet = false) => {
    if (!quiet) setBusy(true);
    try {
      const next = await window.kestrelDesktop.inspectWorkspaceGit({
        sessionId: props.sessionId,
        threadId: props.threadId,
      });
      setSnapshot(next);
      if (!quiet) props.onError(undefined);
    } catch (cause) {
      if (!quiet) props.onError(message(cause));
    } finally {
      if (!quiet) setBusy(false);
    }
  };
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 5000);
    return () => window.clearInterval(timer);
  }, [props.sessionId, props.threadId]);
  useEffect(() => {
    if (
      snapshot?.remotes.length &&
      !snapshot.remotes.some((entry) => entry.name === remote)
    )
      setRemote(snapshot.remotes[0]!.name);
  }, [snapshot?.remotes]);
  const action = async (value: DesktopWorkspaceGitAction) => {
    if (!snapshot) return;
    setBusy(true);
    try {
      setSnapshot(
        await window.kestrelDesktop.performWorkspaceGitAction({
          sessionId: props.sessionId,
          threadId: props.threadId,
          candidateFingerprint: snapshot.candidateFingerprint,
          ...(snapshot.headSha ? { expectedHeadSha: snapshot.headSha } : {}),
          action: value,
        }),
      );
      props.onError(undefined);
    } catch (cause) {
      props.onError(message(cause));
      await refresh(true);
    } finally {
      setBusy(false);
    }
  };
  const mutate = async (
    path: string,
    operation: "stage_file" | "unstage_file",
  ) => {
    if (!snapshot) return;
    setBusy(true);
    try {
      await window.kestrelDesktop.mutateWorkspaceChanges({
        sessionId: props.sessionId,
        threadId: props.threadId,
        expectedFingerprint: snapshot.candidateFingerprint,
        scope: { kind: "uncommitted" },
        mutation: { operation, path },
      });
      await refresh(true);
    } catch (cause) {
      props.onError(message(cause));
      await refresh(true);
    } finally {
      setBusy(false);
    }
  };
  const stagedPaths = useMemo(
    () =>
      snapshot?.files.filter((file) => file.staged).map((file) => file.path) ??
      [],
    [snapshot],
  );
  const sendChecks = async () => {
    if (!snapshot?.pullRequest) return;
    const failed = snapshot.pullRequest.checks.filter(
      (check) =>
        check.conclusion &&
        !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion),
    );
    if (!failed.length) return;
    setBusy(true);
    try {
      await window.kestrelDesktop.runTurn({
        sessionId: props.sessionId,
        eventType: "desktop.workspace.git.address_checks",
        interactionMode: "build",
        actSubmode: "safe",
        workspaceMode: "local",
        projectPath: snapshot.workspaceRoot,
        executionSelection: props.executionSelection,
        message: [
          "Address these failing pull request checks and validate the exact current candidate.",
          "",
          ...failed.map(
            (check) =>
              `- ${check.name}: ${check.status}/${check.conclusion}${check.detailsUrl ? ` (${check.detailsUrl})` : ""}`,
          ),
          "",
          `PR: ${snapshot.pullRequest.url}`,
          `Candidate: ${snapshot.candidateFingerprint}`,
        ].join("\n"),
      });
    } catch (cause) {
      props.onError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  const failedChecks =
    snapshot?.pullRequest?.checks.filter(
      (check) =>
        check.conclusion &&
        !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(check.conclusion),
    ) ?? [];
  return (
    <section className="git-workspace">
      <header className="diff-toolbar">
        <div
          className={`validation-readiness state-${snapshot?.deliveryReady ? "ready" : "blocked"}`}
        >
          <GitPullRequest size={15} />
          <strong>
            {snapshot?.deliveryReady ? "delivery ready" : "not ready"}
          </strong>
          <span>
            {snapshot?.deliveryReadinessMessage ?? "Loading Git state…"}
          </span>
        </div>
        <button disabled={busy} type="button" onClick={() => void refresh()}>
          <RefreshCw size={14} /> Refresh
        </button>
      </header>
      {snapshot ? (
        <div className="diff-identity">
          <span>
            {snapshot.branch ?? "detached HEAD"} ·{" "}
          {snapshot.relation.replaceAll("_", " ")} · push {snapshot.pushState.replaceAll("_", " ")}
            {snapshot.upstream ? ` · ${snapshot.upstream}` : ""} · ↑
            {snapshot.ahead} ↓{snapshot.behind}
          </span>
          <code title={snapshot.candidateFingerprint}>
            {snapshot.candidateFingerprint.slice(0, 22)}…
          </code>
        </div>
      ) : null}
      <div className="git-layout">
        <main className="git-main">
          <section className="git-card">
            <h3>
              <GitBranch size={15} /> Branch and remote
            </h3>
            <div className="git-row">
              <input
                value={branchName}
                placeholder="feature/branch"
                onChange={(event) => setBranchName(event.target.value)}
              />
              <button
                disabled={busy || !branchName.trim()}
                type="button"
                onClick={() =>
                  void action({ kind: "branch_create", branchName })
                }
              >
                Create branch
              </button>
            </div>
            <div className="git-row">
              <select
                value={remote}
                onChange={(event) => setRemote(event.target.value)}
              >
                {snapshot?.remotes.map((entry) => (
                  <option key={entry.name}>{entry.name}</option>
                ))}
              </select>
              <button
                disabled={busy || !remote}
                type="button"
                onClick={() => void action({ kind: "fetch", remote })}
              >
                Fetch
              </button>
              <button
                disabled={busy || !remote || !snapshot?.branch || !snapshot.deliveryReady}
                type="button"
                onClick={() =>
                  snapshot?.branch &&
                  void action({
                    kind: "push",
                    remote,
                    branch: snapshot.branch,
                    setUpstream: !snapshot.upstream,
                  })
                }
              >
                <Send size={13} /> Push{" "}
                {snapshot?.upstream ? "branch" : "and set upstream"}
              </button>
            </div>
          </section>
          <section className="git-card">
            <h3>
              <GitCommit size={15} /> Exact commit
            </h3>
            {snapshot?.files.map((file) => (
              <div className="git-file" key={file.path}>
                <label>
                  <input
                    type="checkbox"
                    checked={selected.includes(file.path)}
                    onChange={(event) =>
                      setSelected((current) =>
                        event.target.checked
                          ? [...new Set([...current, file.path])]
                          : current.filter((path) => path !== file.path),
                      )
                    }
                  />
                  <code>{file.path}</code>
                  <span>
                    {file.status}
                    {file.staged ? " · staged" : ""}
                    {file.unstaged ? " · unstaged" : ""}
                  </span>
                </label>
                {file.unstaged ? (
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() => void mutate(file.path, "stage_file")}
                  >
                    Stage
                  </button>
                ) : null}
                {file.staged ? (
                  <button
                    disabled={busy}
                    type="button"
                    onClick={() => void mutate(file.path, "unstage_file")}
                  >
                    Unstage
                  </button>
                ) : null}
              </div>
            ))}
            <textarea
              value={commitMessage}
              placeholder="Commit message"
              onChange={(event) => setCommitMessage(event.target.value)}
            />
            <button
              disabled={
                busy ||
                !snapshot?.deliveryReady ||
                !commitMessage.trim() ||
                selected.length === 0 ||
                selected.some((path) => !stagedPaths.includes(path)) ||
                selected.length !== stagedPaths.length
              }
              type="button"
              onClick={() =>
                void action({
                  kind: "commit",
                  message: commitMessage,
                  paths: selected,
                })
              }
            >
              Commit exactly {selected.length} selected staged file(s)
            </button>
            {selected.length !== stagedPaths.length ? (
              <small>
                The selection must exactly match all currently staged paths.
              </small>
            ) : null}
          </section>
          <section className="git-card">
            <h3>
              <GitPullRequest size={15} /> Pull request
            </h3>
            {snapshot?.github.available &&
            snapshot.github.authenticated ? null : (
              <div className="notice-strip">
                {snapshot?.github.guidance ??
                  "GitHub CLI status is unavailable."}
              </div>
            )}
            {snapshot?.pullRequest ? (
              <>
                <button
                  className="link-button"
                  type="button"
                  onClick={() =>
                    void window.kestrelDesktop.openExternal(
                      snapshot.pullRequest!.url,
                    )
                  }
                >
                  {snapshot.pullRequest.title} · #{snapshot.pullRequest.number}
                </button>
                <p>
                  {snapshot.pullRequest.state} ·{" "}
                  {snapshot.pullRequest.isDraft ? "draft" : "ready"} ·{" "}
                  {snapshot.pullRequest.mergeState ?? "merge state unknown"} ·{" "}
                  {snapshot.pullRequest.reviewDecision ?? "review pending"}
                </p>
                {snapshot.pullRequest.isDraft ? (
                  <button
                    disabled={busy || !snapshot.deliveryReady}
                    type="button"
                    onClick={() =>
                      void action({
                        kind: "pr_ready",
                        number: snapshot.pullRequest!.number,
                      })
                    }
                  >
                    Mark ready for review
                  </button>
                ) : null}
                <div className="git-checks">
                  {snapshot.pullRequest.checks.map((check) => (
                    <div key={check.id}>
                      <span>{check.name}</span>
                      <strong>
                        {check.status}
                        {check.conclusion ? ` / ${check.conclusion}` : ""}
                      </strong>
                    </div>
                  ))}
                </div>
                <button
                  disabled={busy || failedChecks.length === 0}
                  type="button"
                  onClick={() => void sendChecks()}
                >
                  Send {failedChecks.length} failed check(s) to coding thread
                </button>
                <div className="git-row">
                  <textarea
                    value={comment}
                    placeholder="PR comment"
                    onChange={(event) => setComment(event.target.value)}
                  />
                  <button
                    disabled={
                      busy ||
                      !comment.trim() ||
                  (Boolean(commentPath.trim()) && !(Number(commentLine) > 0))
                    }
                    type="button"
                    onClick={() =>
                      void action({
                        kind: "pr_comment",
                        number: snapshot.pullRequest!.number,
                        body: comment,
                        ...(commentPath.trim() && Number(commentLine) > 0
                          ? {
                              path: commentPath,
                              line: Number(commentLine),
                              side: commentSide,
                            }
                          : {}),
                      })
                    }
                  >
                    <MessageSquare size={13} /> Comment
                  </button>
                </div>
                <div className="git-row">
                  <select
                    value={commentPath}
                    onChange={(event) => setCommentPath(event.target.value)}
                  >
                    <option value="">General comment</option>
                    {snapshot.pullRequest.changedFiles.map((file) => (
                      <option key={file.path} value={file.path}>
                        {file.path}
                      </option>
                    ))}
                  </select>
                  <input
                    value={commentLine}
                    disabled={!commentPath}
                    inputMode="numeric"
                    placeholder="Line"
                    onChange={(event) => setCommentLine(event.target.value)}
                  />
                  <select
                    disabled={!commentPath}
                    value={commentSide}
                    onChange={(event) =>
                      setCommentSide(event.target.value as "LEFT" | "RIGHT")
                    }
                  >
                    <option value="RIGHT">New line</option>
                    <option value="LEFT">Old line</option>
                  </select>
                </div>
                {snapshot.pullRequest.comments.map((entry) => (
                  <blockquote key={entry.id}>
                    <strong>{entry.author}</strong>
                    {entry.path ? ` · ${entry.path}:${entry.line ?? ""}` : ""}
                    <p>{entry.body}</p>
                  </blockquote>
                ))}
              </>
            ) : (
              <>
                <input
                  value={prTitle}
                  placeholder="PR title"
                  onChange={(event) => setPrTitle(event.target.value)}
                />
                <textarea
                  value={prBody}
                  placeholder="Summary and validation"
                  onChange={(event) => setPrBody(event.target.value)}
                />
                <div className="git-row">
                  <input
                    value={baseBranch}
                    placeholder="Base branch"
                    onChange={(event) => setBaseBranch(event.target.value)}
                  />
                  <label>
                    <input
                      type="checkbox"
                      checked={draft}
                      onChange={(event) => setDraft(event.target.checked)}
                    />{" "}
                    Draft
                  </label>
                  <button
                    disabled={busy || !snapshot?.github.authenticated || !prTitle.trim() || !baseBranch.trim() || (!(draft || snapshot?.deliveryReady))}
                    type="button"
                    onClick={() =>
                      void action({
                        kind: "pr_create",
                        title: prTitle,
                        body: prBody,
                        baseBranch,
                        draft,
                      })
                    }
                  >
                    Create PR
                  </button>
                </div>
              </>
            )}
          </section>
        </main>
        <aside className="git-history">
          <h3>Recent commits</h3>
          {snapshot?.recentCommits.map((commit) => (
            <article key={commit.sha}>
              <code>{commit.sha.slice(0, 8)}</code>
              <strong>{commit.summary}</strong>
              <small>{commit.authoredAt}</small>
            </article>
          ))}
          <h3>Audit</h3>
          {snapshot?.audits.map((audit) => (
            <article key={audit.auditId}>
              <strong>
                {audit.operation} · {audit.status}
              </strong>
              <small>{audit.at}</small>
              {audit.error ? <p>{audit.error}</p> : null}
            </article>
          ))}
        </aside>
      </div>
    </section>
  );
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
