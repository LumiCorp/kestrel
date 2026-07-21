import {
  CheckCircle2,
  RefreshCw,
  SearchCheck,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type {
  DesktopWorkspaceChangeScope,
  DesktopWorkspaceReviewSnapshot,
} from "../../src/contracts";

export function ReviewWorkspace(props: {
  sessionId: string;
  threadId: string;
  defaultBaseRef?: string;
  onOpenFile: (path: string, line?: number) => void;
  onError: (message: string | undefined) => void;
}) {
  const [scopeKind, setScopeKind] =
    useState<DesktopWorkspaceChangeScope["kind"]>("uncommitted");
  const [revision, setRevision] = useState(props.defaultBaseRef ?? "main");
  const [snapshot, setSnapshot] = useState<DesktopWorkspaceReviewSnapshot>();
  const [selectedReviewId, setSelectedReviewId] = useState<string>();
  const [selected, setSelected] = useState<string[]>([]);
  const [reviewMode, setReviewMode] = useState<
    "current_thread" | "detached_thread"
  >("current_thread");
  const [reviewerProfileId, setReviewerProfileId] = useState("");
  const [reviewerModel, setReviewerModel] = useState("");
  const [followUpRunId, setFollowUpRunId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const scope = useMemo<DesktopWorkspaceChangeScope>(
    () =>
      scopeKind === "branch"
        ? { kind: "branch", baseRef: revision || "main" }
        : scopeKind === "commit"
          ? { kind: "commit", commitSha: revision || "HEAD" }
          : scopeKind === "pull_request"
            ? {
                kind: "pull_request",
                ...(Number.isInteger(Number(revision)) && Number(revision) > 0
                  ? { number: Number(revision) }
                  : {}),
              }
            : scopeKind === "latest_run"
              ? {
                  kind: "latest_run",
                  ...(revision.trim() ? { runId: revision.trim() } : {}),
                }
              : scopeKind === "latest_turn"
                ? {
                    kind: "latest_turn",
                    ...(revision.trim() ? { turnId: revision.trim() } : {}),
                  }
                : scopeKind === "promotion"
                  ? { kind: "promotion", promotionId: revision.trim() }
                  : { kind: scopeKind },
    [scopeKind, revision],
  );
  const refresh = async () => {
    try {
      setSnapshot(
        await window.kestrelDesktop.listWorkspaceReviews({
          sessionId: props.sessionId,
          threadId: props.threadId,
        }),
      );
    } catch (cause) {
      props.onError(message(cause));
    }
  };
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3_000);
    return () => window.clearInterval(timer);
  }, [props.sessionId, props.threadId]);
  const run = async () => {
    setBusy(true);
    try {
      setSnapshot(
        await window.kestrelDesktop.runWorkspaceReview({
          sessionId: props.sessionId,
          threadId: props.threadId,
          scope,
          mode: reviewMode,
          ...(reviewerProfileId.trim()
            ? { reviewerProfileId: reviewerProfileId.trim() }
            : {}),
          ...(reviewerModel.trim()
            ? { reviewerModel: reviewerModel.trim() }
            : {}),
        }),
      );
      props.onError(undefined);
    } catch (cause) {
      props.onError(message(cause));
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const update = async (
    reviewId: string,
    findingId: string,
    action: "accept" | "dismiss" | "reopen" | "mark_fixed",
  ) => {
    if (!snapshot) return;
    const review = snapshot.reviews.find(
      (candidate) => candidate.reviewId === reviewId,
    );
    if (!review) return;
    const reason =
      action === "dismiss"
        ? window.prompt("Why is this finding being dismissed?")
        : undefined;
    if (action === "dismiss" && !reason?.trim()) return;
    try {
      setSnapshot(
        await window.kestrelDesktop.updateWorkspaceReviewFinding({
          sessionId: props.sessionId,
          threadId: props.threadId,
          candidateFingerprint: review.candidateFingerprint,
          reviewId,
          findingId,
          action,
          ...(reason ? { reason } : {}),
        }),
      );
    } catch (cause) {
      props.onError(message(cause));
      await refresh();
    }
  };
  const submit = async (
    reviewId: string,
    request: "address" | "more_evidence" | "verify",
  ) => {
    if (!snapshot || selected.length === 0) return;
    const review = snapshot.reviews.find(
      (candidate) => candidate.reviewId === reviewId,
    );
    if (!review) return;
    setBusy(true);
    try {
      const result = await window.kestrelDesktop.submitWorkspaceReviewFindings({
        sessionId: props.sessionId,
        threadId: props.threadId,
        candidateFingerprint:
          request === "verify" && review.status === "stale"
            ? snapshot.candidateFingerprint
            : review.candidateFingerprint,
        reviewId,
        findingIds: selected,
        request,
      });
      setSnapshot(result.snapshot);
      setFollowUpRunId(result.runId);
      setSelected([]);
    } catch (cause) {
      props.onError(message(cause));
      await refresh();
    } finally {
      setBusy(false);
    }
  };
  const active =
    snapshot?.reviews.find((review) => review.reviewId === selectedReviewId) ??
    snapshot?.reviews[0];
  return (
    <section className="review-workspace">
      <header className="diff-toolbar">
        <select
          aria-label="Review scope"
          value={scopeKind}
          onChange={(event) => {
            const next = event.target
              .value as DesktopWorkspaceChangeScope["kind"];
            setScopeKind(next);
            if (
              next === "pull_request" ||
              next === "latest_run" ||
              next === "latest_turn" ||
              next === "promotion"
            )
              setRevision("");
          }}
        >
          <option value="uncommitted">Uncommitted</option>
          <option value="unstaged">Unstaged</option>
          <option value="staged">Staged</option>
          <option value="latest_turn">Latest agent turn</option>
          <option value="latest_run">Latest agent run</option>
          <option value="branch">Branch against base</option>
          <option value="commit">Selected commit</option>
          <option value="promotion">Promotion candidate</option>
          <option value="pull_request">Pull request</option>
        </select>
        {scopeKind === "branch" ||
        scopeKind === "commit" ||
        scopeKind === "pull_request" ||
        scopeKind === "latest_run" ||
        scopeKind === "latest_turn" ||
        scopeKind === "promotion" ? (
          <input
            value={revision}
            onChange={(event) => setRevision(event.target.value)}
          />
        ) : null}
        <select
          aria-label="Review execution"
          value={reviewMode}
          onChange={(event) =>
            setReviewMode(event.target.value as typeof reviewMode)
          }
        >
          <option value="current_thread">Current thread</option>
          <option value="detached_thread">Bounded detached thread</option>
        </select>
        {reviewMode === "detached_thread" ? (
          <>
            <input
              aria-label="Reviewer profile"
              placeholder="Reviewer profile (optional)"
              value={reviewerProfileId}
              onChange={(event) => setReviewerProfileId(event.target.value)}
            />
            <input
              aria-label="Reviewer model"
              placeholder="Reviewer model (optional)"
              value={reviewerModel}
              onChange={(event) => setReviewerModel(event.target.value)}
            />
          </>
        ) : null}
        <button disabled={busy} type="button" onClick={() => void run()}>
          <SearchCheck size={14} /> Run read-only review
        </button>
        <button disabled={busy} type="button" onClick={() => void refresh()}>
          <RefreshCw size={14} /> Refresh
        </button>
      </header>
      {snapshot ? (
        <div className="diff-identity">
          <span>
            {snapshot.reviews.length} reviews · candidate{" "}
            {snapshot.candidateFingerprint.slice(0, 20)}…
          </span>
          {snapshot.reviews.length > 0 ? (
            <select
              aria-label="Review history"
              value={active?.reviewId}
              onChange={(event) => {
                setSelectedReviewId(event.target.value);
                setSelected([]);
              }}
            >
              {snapshot.reviews.map((review) => (
                <option value={review.reviewId} key={review.reviewId}>
                  {review.scopeLabel} · {review.status} ·{" "}
                  {new Date(review.createdAt).toLocaleString()}
                </option>
              ))}
            </select>
          ) : (
            <span>not run</span>
          )}
        </div>
      ) : null}
      <main className="review-findings">
        {active ? (
          <>
            <header>
              <strong>{active.scopeLabel}</strong>
              <div>
                <button
                  disabled={busy || selected.length === 0}
                  onClick={() => void submit(active.reviewId, "more_evidence")}
                >
                  Ask for evidence
                </button>
                <button
                  disabled={busy || selected.length === 0}
                  onClick={() => void submit(active.reviewId, "address")}
                >
                  Send to coding agent
                </button>
                <button
                  disabled={busy || selected.length === 0}
                  onClick={() => void submit(active.reviewId, "verify")}
                >
                  Verify selected
                </button>
              </div>
            </header>
            {active.error ? (
              <div className="notice-strip">{active.error}</div>
            ) : null}
            {followUpRunId ? (
              <div className="notice-strip">
                Follow-up is traceable to run {followUpRunId}.
              </div>
            ) : null}
            {active.findings.map((finding) => (
              <article
                className={`review-finding severity-${finding.severity} status-${finding.status}`}
                key={finding.findingId}
              >
                <header>
                  <label>
                    <input
                      type="checkbox"
                      disabled={
                        (finding.status === "stale" &&
                          finding.staleFromStatus !== "accepted") ||
                        finding.status === "dismissed"
                      }
                      checked={selected.includes(finding.findingId)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? [...current, finding.findingId]
                            : current.filter((id) => id !== finding.findingId),
                        )
                      }
                    />
                    <strong>{finding.severity}</strong> ·{" "}
                    {Math.round(finding.confidence * 100)}% · {finding.status}
                    {finding.staleFromStatus
                      ? ` (was ${finding.staleFromStatus})`
                      : ""}
                  </label>
                  <button
                    type="button"
                    onClick={() => props.onOpenFile(finding.path, finding.line)}
                  >
                    {finding.path}:{finding.line}
                  </button>
                </header>
                <h3>{finding.problem}</h3>
                <p>
                  <b>Impact:</b> {finding.impact}
                </p>
                <p>
                  <b>Evidence:</b> {finding.evidence}
                </p>
                <p>
                  <b>Remediation:</b> {finding.remediation}
                </p>
                <p>
                  <b>Verify:</b> {finding.verification}
                </p>
                {finding.submissionRunId ? (
                  <p>
                    <b>Latest follow-up run:</b> {finding.submissionRunId}
                  </p>
                ) : null}
                <footer>
                  {finding.status === "open" ? (
                    <button
                      onClick={() =>
                        void update(
                          active.reviewId,
                          finding.findingId,
                          "accept",
                        )
                      }
                    >
                      <CheckCircle2 size={13} /> Accept
                    </button>
                  ) : null}
                  {finding.status === "accepted" ? (
                    <button
                      onClick={() =>
                        void update(
                          active.reviewId,
                          finding.findingId,
                          "mark_fixed",
                        )
                      }
                    >
                      Mark fixed
                    </button>
                  ) : null}
                  {finding.status !== "stale" &&
                  finding.status !== "dismissed" ? (
                    <button
                      onClick={() =>
                        void update(
                          active.reviewId,
                          finding.findingId,
                          "dismiss",
                        )
                      }
                    >
                      <XCircle size={13} /> Dismiss
                    </button>
                  ) : null}
                  {finding.status === "dismissed" ||
                  finding.status === "fixed" ? (
                    <button
                      onClick={() =>
                        void update(
                          active.reviewId,
                          finding.findingId,
                          "reopen",
                        )
                      }
                    >
                      Reopen
                    </button>
                  ) : null}
                </footer>
              </article>
            ))}
            {active.findings.length === 0 && active.status === "completed" ? (
              <p className="rail-empty">
                <CheckCircle2 size={16} /> No actionable findings.
              </p>
            ) : null}
          </>
        ) : (
          <p className="rail-empty">
            <ShieldAlert size={16} /> Run a read-only review for this workspace.
          </p>
        )}
      </main>
    </section>
  );
}
function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
