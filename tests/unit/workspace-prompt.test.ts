import test from "node:test";
import assert from "node:assert/strict";

import {
  buildWorkspaceModelContext,
  buildWorkspaceSystemMessages,
  readActiveWorkspaceContext,
} from "../../agents/reference-react/src/prompt/workspace.js";

test("workspace prompt helper reads lean runtime context", () => {
  const context = readActiveWorkspaceContext({
    workspaceId: "ws-1",
    workspaceRoot: "/tmp/project",
    appRoot: ".",
    commands: {},
    label: "Project",
  });

  assert.equal(context?.workspaceId, "ws-1");
  const messages = buildWorkspaceSystemMessages(context);
  assert.equal(messages.length, 1);
  assert.match(messages[0] ?? "", /Workspace: ws-1 \(Project\)/u);
  assert.match(messages[0] ?? "", /- root: \/tmp\/project/u);
  assert.doesNotMatch(messages[0] ?? "", /Workspace core instructions/u);
  assert.deepEqual(buildWorkspaceModelContext(context), {
    workspaceId: "ws-1",
    workspaceRoot: "/tmp/project",
    appRoot: ".",
    commands: {},
    label: "Project",
  });
});

test("workspace prompt helper returns no messages for incomplete context", () => {
  assert.deepEqual(buildWorkspaceSystemMessages({ workspaceId: "missing-root" }), []);
});
