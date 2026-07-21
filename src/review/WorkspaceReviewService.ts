import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import type { WorkspaceChangeScope } from "../changes/contracts.js";
import { createRuntimeFailure } from "../runtime/RuntimeFailure.js";
import type {
  WorkspaceReviewFinding,
  WorkspaceReviewRecord,
  WorkspaceReviewSnapshot,
} from "./contracts.js";

interface Store {
  version: 1;
  reviews: WorkspaceReviewRecord[];
}
export interface ProposedWorkspaceReviewFinding {
  severity: WorkspaceReviewFinding["severity"];
  confidence: number;
  path: string;
  line: number;
  problem: string;
  impact: string;
  evidence: string;
  remediation: string;
  verification: string;
}

export class WorkspaceReviewService {
  private reviews = new Map<string, WorkspaceReviewRecord>();
  private persistTail: Promise<void> = Promise.resolve();
  constructor(private readonly metadataPath: string) {}

  async initialize(): Promise<void> {
    await mkdir(path.dirname(this.metadataPath), { recursive: true });
    try {
      const parsed = JSON.parse(
        await readFile(this.metadataPath, "utf8"),
      ) as Partial<Store>;
      if (parsed.version === 1 && Array.isArray(parsed.reviews))
        for (const review of parsed.reviews)
          if (isReview(review)) this.reviews.set(review.reviewId, review);
    } catch {
      /* Missing or invalid Local Core metadata starts empty. */
    }
    await this.persist();
  }

  async begin(input: {
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    scopeLabel: string;
    scope: WorkspaceChangeScope;
    mode: WorkspaceReviewRecord["mode"];
    reviewerProfileId?: string | undefined;
    reviewerModel?: string | undefined;
  }): Promise<WorkspaceReviewRecord> {
    const now = new Date().toISOString();
    const review: WorkspaceReviewRecord = {
      reviewId: randomUUID(),
      sessionId: text(input.sessionId, "sessionId", 256),
      threadId: text(input.threadId, "threadId", 256),
      candidateFingerprint: fingerprint(input.candidateFingerprint),
      scopeLabel: text(input.scopeLabel, "scopeLabel", 1024),
      scope: structuredClone(input.scope),
      mode: input.mode,
      status: "running",
      findings: [],
      createdAt: now,
      updatedAt: now,
      ...(input.reviewerProfileId
        ? {
            reviewerProfileId: text(
              input.reviewerProfileId,
              "reviewerProfileId",
              256,
            ),
          }
        : {}),
      ...(input.reviewerModel
        ? { reviewerModel: text(input.reviewerModel, "reviewerModel", 512) }
        : {}),
    };
    this.reviews.set(review.reviewId, review);
    await this.persist();
    return clone(review);
  }

  async complete(input: {
    reviewId: string;
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    runId: string;
    findings: ProposedWorkspaceReviewFinding[];
  }): Promise<WorkspaceReviewSnapshot> {
    const review = this.requireOwned(
      input.reviewId,
      input.sessionId,
      input.threadId,
    );
    if (
      review.status !== "running" ||
      review.candidateFingerprint !== input.candidateFingerprint
    )
      throw failure(
        "WORKSPACE_REVIEW_STALE",
        "The review no longer matches the candidate.",
      );
    if (!Array.isArray(input.findings) || input.findings.length > 200)
      throw failure(
        "WORKSPACE_REVIEW_FINDINGS_INVALID",
        "A review may contain at most 200 findings.",
      );
    const now = new Date().toISOString();
    const findings = input.findings.map((finding) =>
      normalizeFinding(review.reviewId, finding, now),
    );
    this.reviews.set(review.reviewId, {
      ...review,
      status: "completed",
      runId: text(input.runId, "runId", 256),
      findings,
      updatedAt: now,
      completedAt: now,
    });
    await this.persist();
    return this.list(input);
  }

  async fail(input: {
    reviewId: string;
    sessionId: string;
    threadId: string;
    error: string;
  }): Promise<WorkspaceReviewRecord> {
    const review = this.requireOwned(
      input.reviewId,
      input.sessionId,
      input.threadId,
    );
    const now = new Date().toISOString();
    const failed = {
      ...review,
      status: "failed" as const,
      error: text(input.error, "error", 16_384),
      updatedAt: now,
      completedAt: now,
    };
    this.reviews.set(review.reviewId, failed);
    await this.persist();
    return clone(failed);
  }

  async attachDelegation(input: { reviewId: string; sessionId: string; threadId: string; delegationId: string; childThreadId: string }): Promise<WorkspaceReviewRecord> {
    const review = this.requireOwned(input.reviewId, input.sessionId, input.threadId); if (review.status !== "running" || review.mode !== "detached_thread") throw failure("WORKSPACE_REVIEW_STATE_INVALID", "Only a running detached review can receive delegation identity.");
    const updated = { ...review, delegationId: text(input.delegationId, "delegationId", 256), childThreadId: text(input.childThreadId, "childThreadId", 256), updatedAt: new Date().toISOString() }; this.reviews.set(review.reviewId, updated); await this.persist(); return clone(updated);
  }

  async list(input: {
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    reviewFingerprints?: Record<string, string> | undefined;
  }): Promise<WorkspaceReviewSnapshot> {
    const sessionId = text(input.sessionId, "sessionId", 256);
    const threadId = text(input.threadId, "threadId", 256);
    const current = fingerprint(input.candidateFingerprint);
    let changed = false;
    for (const [id, review] of this.reviews) {
      const actual = input.reviewFingerprints?.[review.reviewId] ?? current;
      if (
        review.sessionId !== sessionId ||
        review.threadId !== threadId ||
        review.candidateFingerprint === actual ||
        review.status === "failed" ||
        review.status === "stale"
      )
        continue;
      const now = new Date().toISOString();
      this.reviews.set(id, {
        ...review,
        status: "stale",
        findings: review.findings.map((finding) =>
          finding.status === "dismissed" ||
          finding.status === "fixed" ||
          finding.status === "stale"
            ? finding
            : {
                ...finding,
                staleFromStatus: finding.status,
                status: "stale",
                updatedAt: now,
              },
        ),
        updatedAt: now,
      });
      changed = true;
    }
    if (changed) await this.persist();
    return {
      sessionId,
      threadId,
      candidateFingerprint: current,
      reviews: [...this.reviews.values()]
        .filter(
          (review) =>
            review.sessionId === sessionId && review.threadId === threadId,
        )
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(clone),
    };
  }

  records(input: {
    sessionId: string;
    threadId: string;
  }): WorkspaceReviewRecord[] {
    return [...this.reviews.values()]
      .filter(
        (review) =>
          review.sessionId === input.sessionId &&
          review.threadId === input.threadId,
      )
      .map(clone);
  }
  get(input: {
    reviewId: string;
    sessionId: string;
    threadId: string;
  }): WorkspaceReviewRecord {
    return clone(
      this.requireOwned(input.reviewId, input.sessionId, input.threadId),
    );
  }

  async updateFinding(input: {
    reviewId: string;
    findingId: string;
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    action: "accept" | "dismiss" | "reopen" | "mark_fixed";
    reason?: string | undefined;
  }): Promise<WorkspaceReviewSnapshot> {
    const review = this.requireCurrent(input);
    const index = review.findings.findIndex(
      (finding) => finding.findingId === input.findingId,
    );
    if (index < 0)
      throw failure(
        "WORKSPACE_REVIEW_FINDING_NOT_FOUND",
        "Review finding is unavailable.",
      );
    const finding = review.findings[index]!;
    const now = new Date().toISOString();
    if (finding.status === "stale")
      throw failure(
        "WORKSPACE_REVIEW_STALE",
        "Stale findings cannot be changed.",
      );
    const status: WorkspaceReviewFinding["status"] =
      input.action === "accept"
        ? "accepted"
        : input.action === "dismiss"
          ? "dismissed"
          : input.action === "mark_fixed"
            ? "fixed"
            : "open";
    const { dismissalReason: _dismissalReason, ...withoutDismissal } = finding;
    const next: WorkspaceReviewFinding = {
      ...withoutDismissal,
      status,
      updatedAt: now,
      ...(input.action === "dismiss"
        ? { dismissalReason: text(input.reason ?? "", "reason", 4096) }
        : {}),
    };
    const findings = [...review.findings];
    findings[index] = next;
    this.reviews.set(review.reviewId, { ...review, findings, updatedAt: now });
    await this.persist();
    return this.list(input);
  }

  selected(input: {
    reviewId: string;
    findingIds: string[];
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    allowStaleAccepted?: boolean | undefined;
  }): WorkspaceReviewFinding[] {
    const review = input.allowStaleAccepted
      ? this.requireOwned(input.reviewId, input.sessionId, input.threadId)
      : this.requireCurrent(input);
    if (
      !Array.isArray(input.findingIds) ||
      input.findingIds.length === 0 ||
      input.findingIds.length > 100
    )
      throw failure(
        "WORKSPACE_REVIEW_SELECTION_INVALID",
        "Select between 1 and 100 findings.",
      );
    return [...new Set(input.findingIds)].map((id) => {
      const finding = review.findings.find(
        (candidate) => candidate.findingId === id,
      );
      const staleAccepted =
        input.allowStaleAccepted &&
        finding?.status === "stale" &&
        finding.staleFromStatus === "accepted";
      if (
        !finding ||
        (!staleAccepted &&
          (finding.status === "stale" || finding.status === "dismissed"))
      )
        throw failure(
          "WORKSPACE_REVIEW_FINDING_NOT_FOUND",
          "Selected finding is unavailable.",
          { findingId: id },
        );
      return { ...finding };
    });
  }

  async recordSubmission(input: {
    reviewId: string;
    findingIds: string[];
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
    runId: string;
    allowStaleAccepted?: boolean | undefined;
  }): Promise<void> {
    const selected = this.selected(input);
    const selectedIds = new Set(selected.map((finding) => finding.findingId));
    const review = this.requireOwned(
      input.reviewId,
      input.sessionId,
      input.threadId,
    );
    const now = new Date().toISOString();
    const runId = text(input.runId, "runId", 256);
    this.reviews.set(review.reviewId, {
      ...review,
      findings: review.findings.map((finding) =>
        selectedIds.has(finding.findingId)
          ? { ...finding, submissionRunId: runId, updatedAt: now }
          : finding,
      ),
      updatedAt: now,
    });
    await this.persist();
  }

  private requireCurrent(input: {
    reviewId: string;
    sessionId: string;
    threadId: string;
    candidateFingerprint: string;
  }): WorkspaceReviewRecord {
    const review = this.requireOwned(
      input.reviewId,
      input.sessionId,
      input.threadId,
    );
    if (
      review.status !== "completed" ||
      review.candidateFingerprint !== input.candidateFingerprint
    )
      throw failure(
        "WORKSPACE_REVIEW_STALE",
        "The review no longer matches the current candidate.",
      );
    return review;
  }
  private requireOwned(
    reviewId: string,
    sessionId: string,
    threadId: string,
  ): WorkspaceReviewRecord {
    const review = this.reviews.get(text(reviewId, "reviewId", 256));
    if (
      !review ||
      review.sessionId !== sessionId ||
      review.threadId !== threadId
    )
      throw failure(
        "WORKSPACE_REVIEW_NOT_FOUND",
        "Workspace review is unavailable.",
      );
    return review;
  }
  private async persist(): Promise<void> {
    const retained = [...this.reviews.values()]
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(-200);
    if (retained.length !== this.reviews.size)
      this.reviews = new Map(
        retained.map((review) => [review.reviewId, review]),
      );
    const value: Store = { version: 1, reviews: retained };
    const temp = `${this.metadataPath}.tmp`;
    this.persistTail = this.persistTail.then(async () => {
      await writeFile(temp, `${JSON.stringify(value)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temp, this.metadataPath);
    });
    await this.persistTail;
  }
}

function normalizeFinding(
  reviewId: string,
  input: ProposedWorkspaceReviewFinding,
  now: string,
): WorkspaceReviewFinding {
  const severity = input.severity;
  if (
    severity !== "critical" &&
    severity !== "high" &&
    severity !== "medium" &&
    severity !== "low"
  )
    throw failure(
      "WORKSPACE_REVIEW_FINDINGS_INVALID",
      "Finding severity is invalid.",
    );
  if (
    typeof input.confidence !== "number" ||
    !Number.isFinite(input.confidence) ||
    input.confidence < 0 ||
    input.confidence > 1
  )
    throw failure(
      "WORKSPACE_REVIEW_FINDINGS_INVALID",
      "Finding confidence must be between 0 and 1.",
    );
  return {
    findingId: randomUUID(),
    reviewId,
    severity,
    confidence: input.confidence,
    path: filePath(input.path),
    line: positiveInteger(input.line, "line"),
    problem: text(input.problem, "problem", 16_384),
    impact: text(input.impact, "impact", 16_384),
    evidence: text(input.evidence, "evidence", 32_768),
    remediation: text(input.remediation, "remediation", 16_384),
    verification: text(input.verification, "verification", 16_384),
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
}
function clone<T>(value: T): T {
  return structuredClone(value);
}
function text(value: string, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    value.includes("\0")
  )
    throw failure("WORKSPACE_REVIEW_INPUT_INVALID", `${label} is invalid.`);
  return value.trim();
}
function fingerprint(value: string): string {
  const normalized = text(value, "candidateFingerprint", 256);
  if (!/^sha256:[a-f0-9]{64}$/u.test(normalized))
    throw failure(
      "WORKSPACE_REVIEW_INPUT_INVALID",
      "candidateFingerprint is invalid.",
    );
  return normalized;
}
function filePath(value: string): string {
  const normalized = text(value, "path", 4096).replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../")
  )
    throw failure("WORKSPACE_REVIEW_INPUT_INVALID", "path is invalid.");
  return normalized;
}
function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0)
    throw failure("WORKSPACE_REVIEW_INPUT_INVALID", `${label} is invalid.`);
  return value;
}
function isReview(value: unknown): value is WorkspaceReviewRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.reviewId === "string" &&
    typeof record.sessionId === "string" &&
    typeof record.threadId === "string" &&
    typeof record.candidateFingerprint === "string" &&
    typeof record.scope === "object" &&
    record.scope !== null &&
    Array.isArray(record.findings) &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string"
  );
}
function failure(
  code: string,
  message: string,
  details: Record<string, unknown> = {},
): Error {
  return createRuntimeFailure(code, message, {
    subsystem: "review",
    classification: "state",
    recoverable: true,
    ...details,
  });
}
