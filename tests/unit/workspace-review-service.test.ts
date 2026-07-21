import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkspaceReviewService } from "../../src/review/WorkspaceReviewService.js";
import { contractTest } from "../helpers/contract-test.js";


const fp = (value: string) => `sha256:${value.repeat(64)}`;
const finding = { severity: "high" as const, confidence: 0.9, path: "src/app.ts", line: 12, problem: "Unsafe state transition", impact: "The candidate can lose work.", evidence: "The transition clears state before persistence succeeds.", remediation: "Persist before clearing state.", verification: "Force persistence failure and assert state remains." };

contractTest("runtime.hermetic", "WorkspaceReviewService persists typed findings and explicit dispositions", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-review-"));
  const metadataPath = path.join(root, "reviews.json");
  const service = new WorkspaceReviewService(metadataPath); await service.initialize();
  const review = await service.begin({ sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fp("a"), scopeLabel: "uncommitted", scope: { kind: "uncommitted" }, mode: "current_thread" });
  const completed = await service.complete({ reviewId: review.reviewId, sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fp("a"), runId: "run-1", findings: [finding] });
  assert.equal(completed.reviews[0]?.findings[0]?.severity, "high");
  assert.equal(completed.reviews[0]?.findings[0]?.status, "open");
  const findingId = completed.reviews[0]!.findings[0]!.findingId;
  const accepted = await service.updateFinding({ reviewId: review.reviewId, findingId, sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fp("a"), action: "accept" });
  assert.equal(accepted.reviews[0]?.findings[0]?.status, "accepted");

  const relaunched = new WorkspaceReviewService(metadataPath); await relaunched.initialize();
  assert.equal((await relaunched.list({ sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fp("a") })).reviews[0]?.findings[0]?.status, "accepted");
});

contractTest("runtime.hermetic", "WorkspaceReviewService marks current findings stale when candidate identity changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-review-stale-"));
  const service = new WorkspaceReviewService(path.join(root, "reviews.json")); await service.initialize();
  const review = await service.begin({ sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fp("a"), scopeLabel: "branch:main", scope: { kind: "branch", baseRef: "main" }, mode: "current_thread" });
  await service.complete({ reviewId: review.reviewId, sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fp("a"), runId: "run-1", findings: [finding] });
  const stale = await service.list({ sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fp("b") });
  assert.equal(stale.reviews[0]?.status, "stale");
  assert.equal(stale.reviews[0]?.findings[0]?.status, "stale");
  assert.equal(stale.reviews[0]?.findings[0]?.staleFromStatus, "open");
  await assert.rejects(service.updateFinding({ reviewId: review.reviewId, findingId: stale.reviews[0]!.findings[0]!.findingId, sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fp("b"), action: "accept" }), /no longer matches/u);
});

contractTest("runtime.hermetic", "WorkspaceReviewService reconciles each historical review against its own scope fingerprint", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-review-scope-")); const service = new WorkspaceReviewService(path.join(root, "reviews.json")); await service.initialize();
  const review = await service.begin({ sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fp("a"), scopeLabel: "commit:abc", scope: { kind: "commit", commitSha: "abc" }, mode: "current_thread" });
  await service.complete({ reviewId: review.reviewId, sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fp("a"), runId: "run-1", findings: [finding] });
  const current = await service.list({ sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fp("b"), reviewFingerprints: { [review.reviewId]: fp("a") } });
  assert.equal(current.candidateFingerprint, fp("b")); assert.equal(current.reviews[0]?.status, "completed");
  const changed = await service.list({ sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fp("b"), reviewFingerprints: { [review.reviewId]: fp("c") } });
  assert.equal(changed.reviews[0]?.status, "stale");
});

contractTest("runtime.hermetic", "WorkspaceReviewService persists bounded detached review identity", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-review-detached-")); const service = new WorkspaceReviewService(path.join(root, "reviews.json")); await service.initialize();
  const review = await service.begin({ sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fp("a"), scopeLabel: "uncommitted", scope: { kind: "uncommitted" }, mode: "detached_thread", reviewerProfileId: "reviewer" });
  const attached = await service.attachDelegation({ reviewId: review.reviewId, sessionId: "session-1", threadId: "thread-1", delegationId: "delegation-1", childThreadId: "child-1" });
  assert.equal(attached.delegationId, "delegation-1"); assert.equal(attached.childThreadId, "child-1"); assert.equal(attached.status, "running");
});

contractTest("runtime.hermetic", "WorkspaceReviewService records the coding or verification run on selected findings", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-review-follow-up-"));
  const service = new WorkspaceReviewService(path.join(root, "reviews.json"));
  await service.initialize();
  const review = await service.begin({ sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fp("a"), scopeLabel: "uncommitted", scope: { kind: "uncommitted" }, mode: "current_thread" });
  const completed = await service.complete({ reviewId: review.reviewId, sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fp("a"), runId: "review-run", findings: [finding] });
  const findingId = completed.reviews[0]!.findings[0]!.findingId;
  await service.recordSubmission({ reviewId: review.reviewId, findingIds: [findingId], sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fp("a"), runId: "follow-up-run" });
  const current = await service.list({ sessionId: "session-1", threadId: "thread-1", candidateFingerprint: fp("a") });
  assert.equal(current.reviews[0]?.findings[0]?.submissionRunId, "follow-up-run");
});
