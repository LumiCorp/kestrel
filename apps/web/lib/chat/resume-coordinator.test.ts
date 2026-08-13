import assert from "node:assert/strict";
import test from "node:test";
import {
  assertMatchingResumeTurnId,
  claimResumeRequest,
  synchronizeResumeCoordinator,
} from "./resume-coordinator";

test("resume coordination claims once per authoritative active turn", () => {
  let coordinator = synchronizeResumeCoordinator(
    { activeTurnId: null, requested: false },
    "turn-running",
    "running",
  );
  const first = claimResumeRequest(coordinator);
  assert.equal(first.turnId, "turn-running");
  coordinator = first.coordinator;
  assert.equal(claimResumeRequest(coordinator).turnId, null);

  coordinator = synchronizeResumeCoordinator(
    coordinator,
    "turn-queued",
    "queued",
  );
  assert.equal(claimResumeRequest(coordinator).turnId, "turn-queued");
  assert.deepEqual(
    synchronizeResumeCoordinator(coordinator, null, undefined),
    { activeTurnId: null, requested: false },
  );
});

test("resume responses must echo the exact requested turn", () => {
  assert.doesNotThrow(() =>
    assertMatchingResumeTurnId("turn-running", "turn-running"),
  );
  assert.throws(
    () => assertMatchingResumeTurnId("turn-running", "turn-queued"),
    /temporarily unavailable/u,
  );
});
