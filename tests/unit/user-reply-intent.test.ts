import assert from "node:assert/strict";

import type { ModelRequest, ModelResponse } from "../../src/kestrel/contracts/model-io.js";

import {
  classifyUserReplyIntent,
  parseExplicitModeCommand,
  readHighConfidenceApprovalDecision,
  readUserReplyIntent,
  renderUserReplyIntentPrompt,
} from "../../src/runtime/userReplyIntent.js";
import { contractTest } from "../helpers/contract-test.js";


function modelIntent(output: Record<string, unknown>) {
  return async <T>(_request: ModelRequest): Promise<T | ModelResponse<unknown>> => ({
    output,
    toolIntents: [],
    provider: {
      name: "openai",
      model: "mock",
      endpoint: "chat",
    },
  });
}

contractTest("runtime.hermetic", "parseExplicitModeCommand preserves deterministic slash mode commands", () => {
  assert.deepEqual(parseExplicitModeCommand("/mode plan"), { interactionMode: "plan" });
  assert.deepEqual(parseExplicitModeCommand("/mode build"), { interactionMode: "build" });
  assert.equal(parseExplicitModeCommand("/mode build guarded"), undefined);
  assert.equal(parseExplicitModeCommand("/mode build ask"), undefined);
  assert.equal(parseExplicitModeCommand("/mode build auto"), undefined);
  assert.equal(parseExplicitModeCommand("/mode build ask-first"), undefined);
  assert.equal(parseExplicitModeCommand("/mode build ask_first"), undefined);
  assert.equal(parseExplicitModeCommand("/mode act safe"), undefined);
  assert.equal(parseExplicitModeCommand("switch to act safe"), undefined);
});

contractTest("runtime.hermetic", "classifyUserReplyIntent returns continuation model intent for natural replies and misspellings", async () => {
  for (const reply of ["continue", "proceed", "contnue", "yes proceed", "go ahead with pass 1"]) {
    const intent = await classifyUserReplyIntent({
      reply,
      waitFor: { eventType: "user.reply", metadata: { reason: "continuation_handoff" } },
      useModel: modelIntent({
        kind: "continue",
        proceed: true,
        confidence: "high",
        reason: "user wants to proceed",
      }),
    });
    assert.equal(intent.kind, "continue");
    assert.equal(intent.proceed, true);
    assert.equal(intent.confidence, "high");
  }
});

contractTest("runtime.hermetic", "classifyUserReplyIntent returns model-backed mode switch intent", async () => {
  for (const reply of ["safe mode is fine", "yes switch me"]) {
    const intent = await classifyUserReplyIntent({
      reply,
      waitFor: {
        eventType: "user.reply",
        metadata: { reason: "acter_mode_blocked", requiredToolClass: "sandboxed_only" },
      },
      useModel: modelIntent({
        kind: "mode_switch",
        proceed: true,
        interactionMode: "build",
        confidence: "high",
      }),
    });
    assert.equal(intent.kind, "mode_switch");
    assert.equal(intent.interactionMode, "build");
    assert.equal(intent.actSubmode, undefined);
  }
});

contractTest("runtime.hermetic", "readHighConfidenceApprovalDecision accepts only high-confidence approval decisions", () => {
  assert.equal(
    readHighConfidenceApprovalDecision(readUserReplyIntent({
      kind: "approval_decision",
      decision: "approve",
      confidence: "high",
    })),
    "approve",
  );
  assert.equal(
    readHighConfidenceApprovalDecision(readUserReplyIntent({
      kind: "approval_decision",
      decision: "deny",
      confidence: "high",
    })),
    "deny",
  );
  assert.equal(
    readHighConfidenceApprovalDecision(readUserReplyIntent({
      kind: "approval_decision",
      decision: "approve",
      confidence: "low",
    })),
    undefined,
  );
});

contractTest("runtime.hermetic", "classifyUserReplyIntent sends approval wait context to the classifier model", async () => {
  let captured: ModelRequest | undefined;
  const intent = await classifyUserReplyIntent({
    reply: "yes, approve that write",
    waitFor: {
      eventType: "user.approval",
      metadata: {
        approvalId: "approval-123",
        purpose: "managed_worktree",
        toolName: "fs.write_text",
        toolClass: "sandboxed_only",
        riskLevel: "medium",
        prompt: "Approve fs.write_text? Reply 'approve' or 'deny'.",
      },
    },
    useModel: async <T>(request: ModelRequest): Promise<T | ModelResponse<unknown>> => {
      captured = request;
      return {
        output: {
          kind: "approval_decision",
          decision: "approve",
          confidence: "high",
        },
        toolIntents: [],
        provider: {
          name: "openai",
          model: "mock",
          endpoint: "chat",
        },
      };
    },
  });

  assert.equal(intent.kind, "approval_decision");
  assert.equal(intent.decision, "approve");
  assert.deepEqual(captured?.input, {
    waitFor: {
      eventType: "user.approval",
      reason: undefined,
      purpose: "managed_worktree",
      requiredToolClass: undefined,
      requiredMode: undefined,
      resumeReply: undefined,
      resumeCommand: undefined,
      approvalId: "approval-123",
      toolName: "fs.write_text",
      toolClass: "sandboxed_only",
      riskLevel: "medium",
      question: undefined,
      prompt: "Approve fs.write_text? Reply 'approve' or 'deny'.",
      blockedOn: undefined,
      suggestedNextFile: undefined,
    },
    userReply: "yes, approve that write",
  });
  const systemMessage = captured?.messages?.[0]?.content;
  assert.equal(typeof systemMessage, "string");
  assert.match(systemMessage as string, /Kestrel's User Reply Classifier/u);
  assert.match(systemMessage as string, /You do not continue the run/u);
  const userMessage = captured?.messages?.[1]?.content;
  assert.equal(typeof userMessage, "string");
  assert.match(userMessage as string, /Classify the user's reply to the paused runtime/u);
  assert.match(userMessage as string, /<context_guide>/u);
  assert.match(userMessage as string, /<classification_rules>/u);
  assert.match(userMessage as string, /<context_json>/u);
  assert.match(userMessage as string, /"approvalId":"approval-123"/u);
  assert.match(userMessage as string, /"userReply":"yes, approve that write"/u);
});

contractTest("runtime.hermetic", "renderUserReplyIntentPrompt wraps wait context and reply in a classifier packet", () => {
  const prompt = renderUserReplyIntentPrompt({
    waitFor: {
      eventType: "user.reply",
      reason: "continuation_handoff",
      resumeCommand: "/mode build",
    },
    userReply: "yes switch to safe mode",
  });

  assert.match(prompt, /^Classify the user's reply to the paused runtime\./u);
  assert.match(prompt, /<context_guide>/u);
  assert.match(prompt, /`waitFor\.eventType` names the event/u);
  assert.match(prompt, /<classification_rules>/u);
  assert.match(prompt, /Choose kind='mode_switch'/u);
  assert.match(prompt, /<context_json>\n\{/u);
  assert.match(prompt, /"reason":"continuation_handoff"/u);
  assert.match(prompt, /"userReply":"yes switch to safe mode"/u);
  assert.match(prompt, /\}\n<\/context_json>$/u);
});

contractTest("runtime.hermetic", "classifyUserReplyIntent does not resume ambiguous replies", async () => {
  for (const reply of ["maybe", "what happens next?", "not sure"]) {
    const intent = await classifyUserReplyIntent({
      reply,
      waitFor: { eventType: "user.reply", metadata: { reason: "continuation_handoff" } },
      useModel: modelIntent({
        kind: "unrelated",
        proceed: false,
        confidence: "low",
      }),
    });
    assert.equal(intent.kind, "unrelated");
    assert.equal(intent.confidence, "low");
  }
});
