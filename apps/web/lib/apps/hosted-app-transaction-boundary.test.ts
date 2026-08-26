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
  assert.match(
    boundary,
    /await validateAppApprovalDecisionEligibilityInTransaction\(tx,/u,
  );
  assert.match(
    boundary,
    /await insertRememberedToolApprovalInTransaction\(tx,/u,
  );
  assert.match(boundary, /interactionId: interaction\.id/u);
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

test("V2 approval execution settles from exact tool outcome, not runtime startup", async () => {
  const [worker, store] = await Promise.all([
    source("../turns/process-runtime.ts"),
    source("../turns/store.ts"),
  ]);
  assert.match(worker, /await recordDurableRuntimeStarted\(\{/u);
  assert.match(worker, /recordDurableRuntimeToolOutcome\(\{/u);
  assert.doesNotMatch(worker, /acknowledgeDurableRuntimeInteraction\(/u);
  const start = store.indexOf("export async function recordDurableRuntimeStarted");
  const end = store.indexOf("export type DurableInteractionFailureEvidence", start);
  const boundary = store.slice(start, end);
  assert.match(boundary, /return knowledgeDb\.transaction\(async \(tx\) =>/u);
  assert.match(boundary, /type: "runtime\.started"/u);
  assert.match(
    boundary,
    /parseHostedPreparedApprovalInteraction\(interaction\) !== null[\s\S]*return true/u,
  );
  assert.match(
    boundary,
    /export async function recordDurableRuntimeToolOutcome/u,
  );
  assert.match(boundary, /preparedInvocationId !== input\.outcome\.callId/u);
  assert.match(boundary, /effectState: input\.outcome\.effectState/u);
  assert.match(boundary, /interaction\.execution_settled/u);
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
  assert.match(boundary, /existing\.lifecycleVersion !== "interaction_v2"/u);
  assert.match(boundary, /existing\.interactionId !== interaction\.id/u);
  assert.match(boundary, /interactionResponse\?\.decision !== "approve_once"/u);
  assert.match(boundary, /interactionResponse\?\.decision !== "remember_approval"/u);
  assert.match(boundary, /availabilityStatus: "consumed"/u);
  assert.match(boundary, /runnerBinding\.runId !== interaction\.sourceRuntimeRunId/u);
});

test("V2 provider records never write an independent human decision", async () => {
  const approvals = await source("./app-operation-approvals.ts");
  const recordStart = approvals.indexOf("export async function recordAppOperationApprovalRequest");
  const recordEnd = approvals.indexOf("export async function linkAppOperationApprovalToInteractionInTransaction", recordStart);
  const recordBoundary = approvals.slice(recordStart, recordEnd);
  assert.match(recordBoundary, /lifecycleVersion: interactionOwned \? "interaction_v2" : "legacy_v1"/u);
  assert.match(recordBoundary, /availabilityStatus: interactionOwned \? "available" : null/u);
  assert.match(recordBoundary, /status: interactionOwned[\s\S]*\? null/u);

  const decisionStart = approvals.indexOf("export async function decideAppOperationApprovalInTransaction");
  const decisionEnd = approvals.indexOf("export async function decideAppOperationApprovalIfPresent", decisionStart);
  const decisionBoundary = approvals.slice(decisionStart, decisionEnd);
  assert.match(decisionBoundary, /approval\.lifecycleVersion === "interaction_v2"/u);
  assert.match(decisionBoundary, /approval\.interactionId !== input\.interactionId/u);
  assert.match(decisionBoundary, /availabilityStatus: "expired"/u);
  assert.doesNotMatch(
    decisionBoundary.slice(
      decisionBoundary.indexOf('approval.lifecycleVersion === "interaction_v2"'),
      decisionBoundary.indexOf("const exactRepeatedDecision"),
    ),
    /decidedByUserId|decidedAt|status: "approved"|status: "denied"/u,
  );
});

test("remember eligibility revalidates exact identity, access, and current Environment Ask First", async () => {
  const approvals = await source("./app-operation-approvals.ts");
  const start = approvals.indexOf(
    "export async function validateAppApprovalDecisionEligibilityInTransaction",
  );
  const end = approvals.indexOf(
    "export async function decideAppOperationApprovalIfPresent",
    start,
  );
  const boundary = approvals.slice(start, end);
  assert.match(boundary, /\.for\("update"\)/u);
  assert.match(boundary, /runnerBinding\.stableToolIdentity/u);
  assert.match(boundary, /serializeCanonicalApprovalPayload\(input\.stableToolIdentity\)/u);
  assert.match(boundary, /environmentGrant\.approvalMode !== "ask"/u);
  assert.match(boundary, /minimumApprovalMode !== "auto"/u);
  assert.match(boundary, /environmentCapabilitySubjectRestrictions/u);
  assert.match(boundary, /subjectRequiresApproval/u);
  assert.match(boundary, /resolveEffectiveProjectAppAccess/u);
  assert.match(boundary, /currentAuthorityRevision !== approval\.authorityRevision/u);
  assert.match(boundary, /appConnectionResources\.enabled, true/u);
});
