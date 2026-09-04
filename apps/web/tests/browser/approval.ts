import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  persistDurableAssistantOutcome,
  resolveDurableRuntimeInteraction,
} from "../../lib/turns/store.js";
import { parseRunnerHostedToolApprovalInteractionV4 } from "@kestrel-agents/protocol";
import type { PreparedToolCallV1 } from "../../../../src/kestrel/contracts/tool-invocation.js";
import type { createHarness } from "./harness.js";
import { checkToolPolicyGate } from "../../../../agents/reference-react/src/steps/acter/policyGates.js";

export async function approve(
  h: Awaited<ReturnType<typeof createHarness>>,
  prepared: PreparedToolCallV1,
  decision: "decline" | "approve_once" | "remember_approval",
) {
  assert.ok(prepared.approval?.approvalId);
  const toolName = prepared.activation.descriptor.toolId;
  const authorityRevision =
    prepared.stableAuthority?.approvalAuthorityRevision ??
    prepared.approval.authorityRevision;
  const browserPolicy =
    toolName === "browser.request_grant"
      ? await h.port.resolvePolicy({
          version: "browser_policy_resolution_v1",
          runId: h.ids.runId,
          threadId: h.ids.threadId,
          operation: "browser.request_grant",
          effectiveInput: prepared.effectiveInput,
          authority: { threadId: h.ids.threadId, projectId: h.ids.projectId },
        })
      : undefined;
  const capability = h.tools
    .getCapabilityManifest()
    .find((item) => item.name === toolName)!;
  const gateInput: Parameters<typeof checkToolPolicyGate>[0] = {
    reactState: {},
    activeRegion: undefined,
    acterStepId: "agent.exec.dispatch",
    deliberationStepId: "agent.think",
    loopStepId: "agent.loop",
    currentStepAgent: "agent.exec.dispatch",
    runId: h.ids.runId,
    sessionId: h.ids.threadId,
    stepIndex: 1,
    eventType: "run.start",
    eventPayload: h.runContext.payload,
    toolName,
    toolInput: prepared.effectiveInput,
    toolClass: "external_side_effect",
    allowedInteractionModes: ["chat", "build"],
    requiredApprovalCapabilities: capability.approvalCapabilities,
    approvalDisposition: {
      mode: "ask",
      reasonCode: "environment_policy",
      authority: { kind: "hosted_app_policy", revision: authorityRevision },
    },
    ...(toolName === "browser.request_grant"
      ? {
          trustedPolicyDecision: prepared.policy.decision,
          trustedPolicyRevision: browserPolicy!.policyRevision,
        }
      : {}),
    approvalAuthority: {
      kind: "hosted_app_policy",
      revision: authorityRevision,
    },
    preparedToolCall: prepared,
    interactionMode: "build",
    actSubmode: undefined,
    modeSystemV2Enabled: true,
    executionPolicy: undefined,
    autonomyPolicy: undefined,
    autonomyEvidence: [],
    autonomyRiskSignals: [],
    io: {} as Parameters<typeof checkToolPolicyGate>[0]["io"],
  };
  const waiting = await checkToolPolicyGate(gateInput);
  assert.equal(
    waiting.kind,
    "blocked",
    "the actual runtime gate must block before user approval",
  );
  assert.ok(
    waiting.kind === "blocked" && waiting.transition.status === "WAITING",
  );
  const interaction = {
    ...parseRunnerHostedToolApprovalInteractionV4(
      waiting.transition.waitFor?.interaction,
    ),
    source: "runtime" as const,
    status: "pending" as const,
  };
  const requestId = interaction.requestId;
  await persistDurableAssistantOutcome({
    turnId: h.ids.turnId,
    runtimeApprovalId: prepared.approval.approvalId,
    messages: [
      {
        id: randomUUID(),
        parts: [
          {
            type: "data-kestrel-interaction",
            id: `interaction:${requestId}`,
            data: interaction,
          },
        ],
        model: "kestrel-one",
        source: "web",
        projectContextRevisionId: null,
      },
    ],
    interaction,
  });
  // Browser's "Allow and remember" button sends approve_once: the domain
  // transaction itself remembers access, unlike generic thread-tool approval.
  const wireDecision =
    toolName === "browser.request_grant" && decision === "remember_approval"
      ? "approve_once"
      : decision;
  await resolveDurableRuntimeInteraction({
    threadId: h.ids.threadId,
    organizationId: h.ids.organizationId,
    userId: h.ids.userId,
    requestId,
    eventType: "user.approval",
    turnId: h.ids.turnId,
    decision: wireDecision,
    messageId: randomUUID(),
    source: "web",
  });
  const [row] =
    await h.sql`SELECT response_envelope, runtime_approval_id FROM thread_interactions WHERE request_id = ${requestId}`;
  assert.equal(row?.response_envelope.decision, wireDecision);
  assert.equal(
    row?.response_envelope.preparedApprovalCleanup,
    undefined,
    "real approval must not become a cleanup/rejection",
  );
  if (decision === "decline") {
    const denied = await checkToolPolicyGate({
      ...gateInput,
      eventType: "user.approval",
      eventPayload: {
        ...h.runContext.payload,
        ...row!.response_envelope,
        approvalId: row!.runtime_approval_id,
      },
      reactState: waiting.transition.statePatch!.agent as Record<
        string,
        unknown
      >,
    });
    assert.ok(denied.kind === "blocked");
    assert.equal(
      (denied.transition.statePatch!.agent as Record<string, any>).terminal
        .reasonCode,
      "TOOL_APPROVAL_DECLINED",
    );
    const effects = denied.transition.effects ?? [];
    assert.equal(effects.length, 1);
    assert.equal(effects[0]!.type, "release_prepared_tool_call");
    await h.tools.releasePreparedToolCall(
      (effects[0]!.payload as { preparedToolCall: PreparedToolCallV1 })
        .preparedToolCall,
    );
    console.info("[browser-test] declined prepared operation released", {
      operation: prepared.activation.descriptor.toolId,
      at: Date.now(),
    });
    await assert.rejects(h.tools.executePreparedToolCall(prepared));
  } else {
    const allowed = await checkToolPolicyGate({
      ...gateInput,
      eventType: "user.approval",
      eventPayload: {
        ...h.runContext.payload,
        ...row!.response_envelope,
        approvalId: row!.runtime_approval_id,
      },
      reactState: waiting.transition.statePatch!.agent as Record<
        string,
        unknown
      >,
    });
    assert.equal(
      allowed.kind,
      "allowed",
      `the real policy gate must authorize execution after approval: ${JSON.stringify(
        allowed.kind === "blocked"
          ? {
              status: allowed.transition.status,
              reasonCode: (
                allowed.transition.statePatch?.agent as Record<string, any>
              )?.terminal?.reasonCode,
              resultKind: (
                allowed.transition.statePatch?.agent as Record<string, any>
              )?.lastActionResult?.kind,
              decisionCodes: (
                allowed.transition.statePatch?.agent as Record<string, any>
              )?.decisionTrace?.map(
                (item: { decisionCode?: string }) => item.decisionCode,
              ),
            }
          : {},
      )}`,
    );
  }
  // The suite resumes Browser service calls only after the real policy gate,
  // without starting a durable turn-worker.
  await h.sql`UPDATE thread_turns SET status = 'running' WHERE id = ${h.ids.turnId}`;
  await h.sql`UPDATE thread_turn_queue_state SET state = 'running', pause_reason = NULL WHERE thread_id = ${h.ids.threadId}`;
}
