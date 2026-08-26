import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(relative: string) {
  return readFile(new URL(relative, import.meta.url), "utf8");
}

test("hosted App decision, response, interaction, and queue state share one transaction", async () => {
  const store = await source("../turns/store.ts");
  const start = store.indexOf("export async function resolveDurableRuntimeInteraction");
  const end = store.indexOf("export async function recordDurableRuntimeStarted", start);
  const boundary = store.slice(start, end);
  assert.match(boundary, /return knowledgeDb\.transaction\(async \(tx\) =>/u);
  assert.match(boundary, /await tx\.insert\(schema\.threadMessages\)/u);
  assert.match(boundary, /await decideAppOperationApprovalInTransaction\(tx,/u);
  assert.match(boundary, /\.update\(schema\.threadInteractions\)/u);
  assert.match(boundary, /\.update\(schema\.threadTurnQueueState\)/u);
});

test("legacy approval message persistence is owned by the durable decision transaction", async () => {
  const [route, store] = await Promise.all([
    source("../../app/api/threads/[id]/route.ts"),
    source("../turns/store.ts"),
  ]);
  assert.doesNotMatch(route, /saveThreadMessages\(\[/u);
  assert.match(route, /assistantMessage:\s*\{/u);
  const start = store.indexOf("export async function createDurableApprovalResponseTurn");
  const end = store.indexOf("export async function createDurableThreadTurnInTransaction", start);
  const boundary = store.slice(start, end);
  assert.match(boundary, /decideAppOperationApprovalInTransaction\(tx,/u);
  assert.match(boundary, /\.insert\(schema\.threadMessages\)/u);
  assert.match(boundary, /createDurableThreadTurnInTransaction\(tx, input\)/u);
});

test("every hosted mutation consumes its grant before credentials or provider execution", async () => {
  const routes = [
    ["../../app/api/runtime/email/action/route.ts", "resolveOrganizationEmailConfig"],
    ["../../app/api/runtime/github/action/route.ts", "auth.api.getAccessToken"],
    ["../../app/api/runtime/google-calendar/action/route.ts", "getConnectionAccessToken"],
    ["../../app/api/runtime/microsoft-365/action/route.ts", "getAccessToken"],
  ] as const;
  for (const [relative, firstAuthorityUse] of routes) {
    const route = await source(relative);
    const consume = route.indexOf("await consumeAppOperationApproval");
    const authority = route.indexOf(firstAuthorityUse, consume + 1);
    assert.ok(consume >= 0, `${relative} must consume a hosted App grant`);
    assert.ok(authority > consume, `${relative} must consume before ${firstAuthorityUse}`);
  }
});

test("runtime start and authorization acknowledgement share one idempotent transaction", async () => {
  const [worker, store] = await Promise.all([
    source("../turns/process-runtime.ts"),
    source("../turns/store.ts"),
  ]);
  assert.match(worker, /await recordDurableRuntimeStarted\(\{/u);
  assert.doesNotMatch(worker, /acknowledgeDurableRuntimeInteraction\(/u);
  const start = store.indexOf("export async function recordDurableRuntimeStarted");
  const end = store.indexOf("export type DurableInteractionFailureEvidence", start);
  const boundary = store.slice(start, end);
  assert.match(boundary, /return knowledgeDb\.transaction\(async \(tx\) =>/u);
  assert.match(boundary, /type: "runtime\.started"/u);
  assert.match(boundary, /status: "resolved"/u);
  assert.match(boundary, /type: "interaction\.authorization_accepted"/u);
});

test("V2 waiting approval persists the canonical request identity for hosted decision lookup", async () => {
  const worker = await source("../turns/process-runtime.ts");
  const start = worker.indexOf('meta.terminalStatus === "waiting"');
  const end = worker.indexOf("messages: terminal.messages", start);
  const boundary = worker.slice(start, end);
  assert.match(boundary, /meta.interaction.kind === "approval"/u);
  assert.match(
    boundary,
    /runtimeApprovalId: meta.interaction.requestId/u,
  );
  assert.doesNotMatch(boundary, /approval\?\.toolCallId/u);
});

test("grant consumption proves the exact running execution and source interaction chain", async () => {
  const approvals = await source("./app-operation-approvals.ts");
  const start = approvals.indexOf("export async function consumeAppOperationApproval");
  const end = approvals.indexOf("type EffectiveProjectAppAccess", start);
  const boundary = approvals.slice(start, end);
  assert.match(boundary, /return knowledgeDb\.transaction\(async \(tx\) =>/u);
  assert.match(boundary, /environmentRunExecutions\.id, input\.consumedExecutionId/u);
  assert.match(boundary, /environmentRunExecutions\.status, "running"/u);
  assert.match(boundary, /threadTurns\.environmentExecutionId, input\.consumedExecutionId/u);
  assert.match(boundary, /consumingTurn\.resumeInteractionId === interaction\.id/u);
  assert.match(boundary, /interaction\.runtimeApprovalId/u);
  assert.match(boundary, /runnerBinding\.runId !== interaction\.sourceRuntimeRunId/u);
});
