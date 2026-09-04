import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(
  new URL("./workspace-post-cutover-canary.ts", import.meta.url),
  "utf8",
);
const noSpendRouteSource = await readFile(
  new URL(
    "../app/api/threads/[id]/workspace/canary/exact-tool-preflight/route.ts",
    import.meta.url,
  ),
  "utf8",
);

test("post-cutover command canary joins the exact exec_command to its Ask First card", () => {
  assert.match(source, /turn\?\.status === "waiting_for_input"/u);
  assert.match(source, /parseRunnerHostedToolApprovalInteractionV4/u);
  assert.match(
    source,
    /matchesExactExecCommandApprovalScope\(\s*request\.approval\.rememberedApprovalScope,\s*input\.command/u,
  );
  assert.doesNotMatch(
    source,
    /toolCalls\.has\(request\.approval\.preparedInvocationId\)/u,
  );
  assert.match(source, /request\.approval\.toolName === "exec_command"/u);
  assert.match(source, /policy\?\.mode === "ask"/u);
  assert.match(
    source,
    /isCurrentExecCommandApprovalActionable\(askFirstPolicy\)/u,
  );
  assert.match(source, /decisions\[0\] === "decline"/u);
  assert.match(source, /decisions\[1\] === "approve_once"/u);
  assert.match(source, /decisions\[2\] === "remember_approval"/u);
});

test("post-cutover command canary runs an exact no-spend preflight before creating a model turn", () => {
  assert.match(source, /workspace\/canary\/exact-tool-preflight/u);
  assert.match(
    source,
    /assertExecCommandNoSpendPreflight\(exactToolPreflight\)/u,
  );
  assert.match(
    source,
    /assertExecCommandNoSpendPreflight\(exactToolPreflight\);[\s\S]*await runAgentCommandCanary/u,
  );
  assert.match(source, /agent_exec_command_no_spend_preflight/u);
});

test("the no-spend route carries the Environment's exact runtime model into profile resolution", () => {
  assert.match(noSpendRouteSource, /getResolvedKestrelRuntimeExecutionModel/u);
  assert.match(noSpendRouteSource, /toKestrelOneRuntimeModelSelection/u);
  assert.match(
    noSpendRouteSource,
    /runtimeModels: \[runtimeModel\],[\s\S]*exactToolName: "exec_command"/u,
  );
});

test("post-cutover command canary approves once through the durable interaction API before proving completion", () => {
  assert.match(
    source,
    /request\(`\/api\/threads\/\$\{threadId\}`,[\s\S]*createExecCommandCanaryApprovalResponse\(\{\s*requestId: approval\.requestId,\s*turnId: approval\.turnId,\s*messageId: approvalMessageId/u,
  );
  assert.match(source, /hasApproveOnceTerminal/u);
  assert.match(
    source,
    /interaction\.responseEnvelope\?\.decision === "approve_once"/u,
  );
  assert.match(
    source,
    /interaction\.approvalOutcome\.effectState === "committed"/u,
  );
  assert.match(source, /hasCompletedExecCommandCanaryProof/u);
  assert.match(source, /agent_exec_command_reached_ask_first_card/u);
  assert.match(source, /agent_exec_command_approve_once_submitted/u);
  assert.match(source, /agent_exec_command_completed/u);
});
