import assert from "node:assert/strict";
import test from "node:test";
import {
  getProjectSavePresentation,
  getProjectSurfaceAccess,
  partitionProjectThreads,
} from "./project-presentation";

test("Project Overview preserves role and lifecycle permissions", () => {
  assert.deepEqual(
    getProjectSurfaceAccess({ role: "member", archivedAt: null }),
    {
      canEdit: false,
      canCreateThread: true,
      canConfigureWorkspace: false,
      canArchive: false,
      canRestore: false,
      canDelete: false,
      hasProjectActions: false,
    },
  );
  assert.equal(
    getProjectSurfaceAccess({ role: "editor", archivedAt: null })
      .canConfigureWorkspace,
    true,
  );
  assert.deepEqual(
    getProjectSurfaceAccess({
      role: "owner",
      archivedAt: "2026-08-12T00:00:00.000Z",
    }),
    {
      canEdit: true,
      canCreateThread: false,
      canConfigureWorkspace: false,
      canArchive: false,
      canRestore: true,
      canDelete: true,
      hasProjectActions: true,
    },
  );
});

test("Project Overview partitions active and archived Threads", () => {
  const active = { id: "active", archivedAt: null };
  const archived = {
    id: "archived",
    archivedAt: "2026-08-12T00:00:00.000Z",
  };

  assert.deepEqual(partitionProjectThreads([archived, active]), {
    activeThreads: [active],
    archivedThreads: [archived],
  });
  assert.deepEqual(partitionProjectThreads([]), {
    activeThreads: [],
    archivedThreads: [],
  });
});

test("Project save state blocks invalid and in-progress revisions", () => {
  assert.deepEqual(
    getProjectSavePresentation({
      canEdit: true,
      saving: true,
      name: "Kestrel",
      revision: 7,
    }),
    { disabled: true, label: "Saving…" },
  );
  assert.equal(
    getProjectSavePresentation({
      canEdit: true,
      saving: false,
      name: "  ",
      revision: 7,
    }).disabled,
    true,
  );
  assert.deepEqual(
    getProjectSavePresentation({
      canEdit: true,
      saving: false,
      name: "Kestrel",
      revision: 7,
    }),
    { disabled: false, label: "Save revision 8" },
  );
});
