import assert from "node:assert/strict";
import test from "node:test";
import { resolveHostedBrowserViewerPolicyAccess, resolveHostedBrowserViewerRequester } from "./viewer-composition-access";

const origin = {
  organizationId: "org-1",
  environmentId: "env-1",
  projectId: "project-1",
  threadId: "thread-1",
  runId: "run-1",
  turnId: "turn-1",
  userId: "origin-actor",
  effectiveAllowlistRevision: "revision-1",
};

test("viewer policy requires exact adopted authority and distinguishes denied access", () => {
  const current = { ...origin, decision: "allow" as const };
  assert.equal(resolveHostedBrowserViewerPolicyAccess({ origin, session: origin, current }), true);
  assert.throws(() => resolveHostedBrowserViewerPolicyAccess({
    origin, session: origin, current: { ...current, effectiveAllowlistRevision: "revision-2" },
  }), /BROWSER_ALLOWLIST_ADOPTION_UNCONFIRMED/u);
  for (const decision of ["deny", "approval_required"] as const) {
    assert.equal(resolveHostedBrowserViewerPolicyAccess({
      origin, session: origin,
      current: { ...current, decision, effectiveAllowlistRevision: "revision-2" },
    }), false);
  }
  for (const field of ["environmentId", "projectId", "userId"] as const) {
    assert.equal(resolveHostedBrowserViewerPolicyAccess({
      origin, session: origin,
      current: { ...current, [field]: "other", effectiveAllowlistRevision: "revision-2" },
    }), false);
  }
});

test("viewer composition admits an authorized replacement only for fail-close", () => {
  assert.deepEqual(resolveHostedBrowserViewerRequester({
    organizationId: "org-1",
    actorId: "replacement-actor",
    threadId: "thread-1",
    origin,
    accessibleProjectId: "project-1",
  }), {
    requestMatchesOriginActor: false,
    requestMatchesAuthorizedReplacement: true,
    cleanupBypass: true,
  });
});

test("viewer composition rejects replacement actors without exact Thread access", () => {
  for (const accessibleProjectId of [undefined, "other-project"]) {
    assert.throws(() => resolveHostedBrowserViewerRequester({
      organizationId: "org-1",
      actorId: "replacement-actor",
      threadId: "thread-1",
      origin,
      accessibleProjectId,
    }), /BROWSER_SESSION_LOST/u);
  }
});

test("viewer composition preserves the exact origin actor cleanup path after access loss", () => {
  assert.equal(resolveHostedBrowserViewerRequester({
    organizationId: "org-1",
    actorId: "origin-actor",
    threadId: "thread-1",
    origin,
  }).requestMatchesOriginActor, true);
});
