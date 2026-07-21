import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { WorkspaceFeedbackService } from "../../src/review/WorkspaceFeedbackService.js";
import { contractTest } from "../helpers/contract-test.js";


const first = `sha256:${"a".repeat(64)}`;
const second = `sha256:${"b".repeat(64)}`;

contractTest("runtime.hermetic", "WorkspaceFeedbackService persists candidate-bound feedback without workspace contents", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-feedback-"));
  const metadataPath = path.join(root, "feedback.json");
  const service = new WorkspaceFeedbackService(metadataPath);
  await service.initialize();
  const added = await service.add({ sessionId: "session-1", threadId: "thread-1", candidateFingerprint: first, path: "src/app.ts", line: 12, side: "RIGHT", body: "Handle the failure." });
  assert.equal(added.comments[0]?.status, "pending");
  const submitted = await service.markSubmitted({ sessionId: "session-1", threadId: "thread-1", candidateFingerprint: first, commentIds: [added.comments[0]!.commentId], runId: "run-1" });
  assert.equal(submitted.comments[0]?.submissionRunId, "run-1");
  const persisted = await readFile(metadataPath, "utf8");
  assert.doesNotMatch(persisted, /file contents/u);
  const relaunched = new WorkspaceFeedbackService(metadataPath);
  await relaunched.initialize();
  assert.equal((await relaunched.list({ sessionId: "session-1", threadId: "thread-1", candidateFingerprint: first })).comments[0]?.status, "submitted");
});

contractTest("runtime.hermetic", "WorkspaceFeedbackService marks unsent feedback stale when the candidate changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "kestrel-feedback-stale-"));
  const service = new WorkspaceFeedbackService(path.join(root, "feedback.json"));
  await service.initialize();
  const added = await service.add({ sessionId: "session-1", threadId: "thread-1", candidateFingerprint: first, path: "src/app.ts", line: 1, side: "RIGHT", body: "Question" });
  const stale = await service.list({ sessionId: "session-1", threadId: "thread-1", candidateFingerprint: second });
  assert.equal(stale.comments[0]?.status, "stale");
  await assert.rejects(service.prepareSubmission({ sessionId: "session-1", threadId: "thread-1", candidateFingerprint: second, commentIds: [added.comments[0]!.commentId] }), /no longer matches/u);
});
