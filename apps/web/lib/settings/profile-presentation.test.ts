import assert from "node:assert/strict";
import test from "node:test";
import { partitionProfileSessions } from "./profile-presentation";

test("Profile separates the current session from disclosed other devices", () => {
  const current = { id: "current", userAgent: "Current browser" };
  const other = { id: "other", userAgent: "Other browser" };
  const unidentified = { id: "unknown", userAgent: null };

  assert.deepEqual(
    partitionProfileSessions([other, unidentified, current], current.id),
    {
      currentSession: current,
      otherSessions: [other],
    },
  );
});

test("Profile presents a stable empty-other-session state", () => {
  const current = { id: "current", userAgent: "Current browser" };

  assert.deepEqual(partitionProfileSessions([current], current.id), {
    currentSession: current,
    otherSessions: [],
  });
});
