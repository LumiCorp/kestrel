import assert from "node:assert/strict";
import test from "node:test";
import { mergePinnedFlyImageReleaseHistory } from "./history";

test("release history retains active and stable releases outside the recent window", () => {
  const recent = [{ id: "recent-2" }, { id: "recent-1" }];
  const pinned = [
    { id: "active-old" },
    { id: "stable-old" },
    { id: "recent-1" },
  ];

  assert.deepEqual(
    mergePinnedFlyImageReleaseHistory(recent, pinned).map(
      (release) => release.id,
    ),
    ["recent-2", "recent-1", "active-old", "stable-old"],
  );
});
