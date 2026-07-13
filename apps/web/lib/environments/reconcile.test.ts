import assert from "node:assert/strict";
import test from "node:test";
import { selectDueDailyBackupCandidate } from "./reconcile-selection";

test("daily backup selection skips recently protected Workspaces without starving the next due Workspace", () => {
  const candidates = [
    { id: "oldest-recent", organizationId: "org-1" },
    { id: "next-due", organizationId: "org-2" },
    { id: "later-due", organizationId: "org-3" },
  ];

  assert.deepEqual(
    selectDueDailyBackupCandidate(candidates, ["oldest-recent"]),
    candidates[1]
  );
});

test("daily backup selection returns no candidate when every ready Workspace is protected", () => {
  assert.equal(
    selectDueDailyBackupCandidate(
      [{ id: "workspace-1" }, { id: "workspace-2" }],
      ["workspace-1", "workspace-2"]
    ),
    undefined
  );
});
