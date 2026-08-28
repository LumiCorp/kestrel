import assert from "node:assert/strict";
import test from "node:test";

import type { PreparedToolCallV1 } from "../../src/kestrel/contracts/tool-invocation.js";
import type { SharedToolContext } from "../../tools/contracts.js";
import { withPreparedExecCommandApprovalContext } from "../../tools/runtime/approvedExecCommandContext.js";

function preparedExecCommand(): PreparedToolCallV1 {
  return {
    callId: "approval:run-1:call-1",
    effectiveInput: { command: "pnpm run demo", cwd: "apps/web" },
    activation: { descriptor: { toolId: "exec_command" } },
    policy: { decision: "approval_required" },
    approval: {
      externalApprovalBinding: {
        version: "runner_external_approval_binding_v2",
        preparedInvocationId: "approval:run-1:call-1",
        expiresAt: "2026-08-27T20:00:00.000Z",
      },
    },
    stableAuthority: {},
    stableToolIdentity: {},
  } as unknown as PreparedToolCallV1;
}

test("prepared exec approval grants only its exact command in the active workspace", () => {
  const context: SharedToolContext = {
    fileSystem: { workspaceRoot: "/workspace", tempRoots: [], readOnlyRoots: [] },
    devShell: { enabled: true, sourceWriteGuard: { enabled: true } },
  };

  const scoped = withPreparedExecCommandApprovalContext(
    context,
    preparedExecCommand(),
  );

  assert.equal(scoped.devShell?.sourceWriteAuthority, "source_write");
  assert.deepEqual(scoped.devShell?.sourceWriteGuard?.approvalGrants, [
    {
      grantId: "approval:run-1:call-1",
      command: "pnpm run demo",
      cwd: "apps/web",
      writablePaths: ["/workspace"],
      expiresAt: "2026-08-27T20:00:00.000Z",
    },
  ]);
  assert.equal(context.devShell?.sourceWriteAuthority, undefined);
});

test("unapproved exec commands do not receive source-write authority", () => {
  const context: SharedToolContext = {
    fileSystem: { workspaceRoot: "/workspace", tempRoots: [], readOnlyRoots: [] },
    devShell: { enabled: true },
  };
  const prepared = preparedExecCommand();
  delete (prepared as { stableAuthority?: unknown }).stableAuthority;

  assert.equal(
    withPreparedExecCommandApprovalContext(context, prepared),
    context,
  );
});

test("policy-allowed exec commands receive a one-shot exact source-write grant", () => {
  const context: SharedToolContext = {
    fileSystem: { workspaceRoot: "/workspace", tempRoots: [], readOnlyRoots: [] },
    devShell: { enabled: true, sourceWriteGuard: { enabled: true } },
  };
  const prepared = preparedExecCommand();
  delete (prepared as { stableAuthority?: unknown }).stableAuthority;
  delete (prepared as { stableToolIdentity?: unknown }).stableToolIdentity;
  delete (prepared as { approval?: unknown }).approval;
  (prepared as { policy: { decision: string } }).policy = { decision: "allow" };

  const scoped = withPreparedExecCommandApprovalContext(context, prepared);

  assert.equal(scoped.devShell?.sourceWriteAuthority, "source_write");
  assert.deepEqual(scoped.devShell?.sourceWriteGuard?.approvalGrants, [
    {
      grantId: "approval:run-1:call-1",
      command: "pnpm run demo",
      cwd: "apps/web",
      writablePaths: ["/workspace"],
    },
  ]);
});
