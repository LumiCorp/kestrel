import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ThreadInteractionView } from "@/lib/turns/client-contract";
import { InteractionPanel } from "./interaction-panel";

const interaction: ThreadInteractionView = {
  id: "interaction-1",
  requestId: "recommendation-1",
  source: "runtime",
  sourceCheckpointId: null,
  kind: "user_input",
  eventType: "user.input",
  prompt: "This action requires Build mode.",
  status: "pending",
  requestEnvelope: {
    metadata: {
      reason: "acter_mode_blocked",
      requiredToolClass: "sandboxed_only",
    },
  },
  responseEnvelope: null,
  responseMessageId: null,
  turnId: "turn-1",
  assistantMessageId: "assistant-1",
  createdAt: "2026-08-13T12:00:00.000Z",
  resolvedAt: null,
};

test("Kestrel One leaves typed mode switches to the composer selector", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      interactions={[interaction]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );
  assert.equal(html, "");
});

test("Kestrel One does not guess a mode switch without the explicit contract", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      interactions={[
        {
          ...interaction,
          requestEnvelope: { metadata: { reason: "ordinary_question" } },
        },
      ]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );
  assert.doesNotMatch(html, /Switch to Build/u);
});

test("approval cards omit the generic review instruction", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      interactions={[
        {
          ...interaction,
          kind: "approval",
          eventType: "user.approval",
          prompt: "Review this action before it runs.",
          requestEnvelope: {},
        },
      ]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );

  assert.match(html, /Approval required/u);
  assert.doesNotMatch(html, /Review this action before it runs\./u);
});

test("unstructured approval cards preserve their specific prompt", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      interactions={[
        {
          ...interaction,
          kind: "approval",
          eventType: "user.approval",
          prompt: "Approve deployment to production?",
          requestEnvelope: {},
        },
      ]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );

  assert.match(html, /Approve deployment to production\?/u);
});

test("legacy approval cards keep their explicit compatibility actions", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      interactions={[
        {
          ...interaction,
          kind: "approval",
          eventType: "user.approval",
          prompt: "Approve internet.research? Reply 'approve' or 'deny'.",
          requestEnvelope: {
            approval: {
              toolCallId: "tool-call-1",
              toolName: "internet.research",
              presentation: {
                title: "Run web research",
                summary: "Start a multi-source Tavily research task.",
                fields: [{ label: "Research request", value: "Kestrel" }],
                warnings: [],
                policy: {
                  mode: "ask",
                  reasonCode: "environment_policy",
                  explanation:
                    "Environment Apps is configured to ask before this capability runs.",
                  authorityKind: "hosted_app_policy",
                  authorityRevision: "revision-1",
                },
              },
            },
          },
          approvalPolicy: {
            projectId: "project-1",
            environmentId: "environment-1",
            appKey: "tavily",
            capabilityKey: "research",
            capabilityDisplayName: "Run research",
            environmentApprovalMode: "ask",
            projectApprovalMode: "ask",
            minimumApprovalMode: "auto",
            rememberApprovalEligible: true,
            reasonCode: "environment_policy",
            canEditProject: true,
          },
        },
      ]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );

  assert.match(html, />Don&#x27;t allow</u);
  assert.match(html, />Allow once</u);
  assert.doesNotMatch(html, />Allow for thread</u);
  assert.doesNotMatch(html, />Always Approve</u);
  assert.match(html, /Start a multi-source Tavily research task/u);
  assert.doesNotMatch(html, /internet\.research/u);
  assert.match(html, /Research request/u);
  assert.match(html, /Kestrel/u);
  assert.doesNotMatch(html, /Environment: Ask first/u);
  assert.doesNotMatch(html, /Project: Ask first/u);
  assert.match(html, /Your environment asks before this action runs/u);
  assert.doesNotMatch(html, /organization\/environments/u);
  assert.doesNotMatch(html, />Approve<\/button>/u);
});

test("strict V4 approval cards advertise exact decisions", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      interactions={[{
        ...interaction,
        kind: "approval",
        eventType: "user.approval",
        prompt: "Review this action before it runs.",
        requestEnvelope: {
          version: "runner_hosted_tool_approval_interaction_v4",
          approval: { toolName: "test.tool" },
        },
        approvalPolicy: {
          projectId: "project-1",
          environmentId: "environment-1",
          appKey: "built-in",
          capabilityKey: "test.tool",
          capabilityDisplayName: "Test tool",
          environmentApprovalMode: "ask",
          projectApprovalMode: "ask",
          minimumApprovalMode: "auto",
          reasonCode: "environment_policy",
          canEditProject: false,
        },
      }]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />
  );
  assert.match(html, />Don&#x27;t allow</u);
  assert.match(html, />Allow once</u);
  assert.doesNotMatch(html, /Review this action before it runs\./u);
  assert.doesNotMatch(html, />Allow for thread</u);
  assert.doesNotMatch(html, />Deny</u);
});

test("a strict hosted card with missing current authority exposes only Decline", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      interactions={[{
        ...interaction,
        kind: "approval",
        eventType: "user.approval",
        requestEnvelope: {
          version: "runner_hosted_tool_approval_interaction_v4",
          approval: { toolName: "exec_command" },
        },
      }]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );
  assert.match(html, />Don&#x27;t allow</u);
  assert.doesNotMatch(html, />Allow once</u);
  assert.doesNotMatch(html, />Allow for thread</u);
});

test("strict V4 cards advertise Remember Approval when policy permits it", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      interactions={[
        {
          ...interaction,
          kind: "approval",
          eventType: "user.approval",
          requestEnvelope: {
            version: "runner_hosted_tool_approval_interaction_v4",
            approval: {
              toolCallId: "tool-call-2",
              toolName: "internet.research",
              presentation: {
                title: "Run web research",
                summary: "Start a multi-source Tavily research task.",
                fields: [{ label: "Research request", value: "Kestrel" }],
                warnings: [],
                policy: {
                  mode: "ask",
                  reasonCode: "environment_policy",
                  explanation:
                    "Environment Apps is configured to ask before this capability runs.",
                  authorityKind: "hosted_app_policy",
                  authorityRevision: "revision-2",
                  rememberApprovalEligible: true,
                },
              },
            },
          },
          approvalPolicy: {
            projectId: "project-1",
            environmentId: "environment-1",
            appKey: "tavily",
            capabilityKey: "research",
            capabilityDisplayName: "Run research",
            environmentApprovalMode: "ask",
            projectApprovalMode: "ask",
            minimumApprovalMode: "auto",
            rememberApprovalEligible: true,
            reasonCode: "environment_policy",
            canEditProject: true,
          },
        },
      ]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );

  assert.match(html, />Don&#x27;t allow</u);
  assert.match(html, />Allow once</u);
  assert.match(html, />Allow for thread</u);
  assert.doesNotMatch(html, />Always Approve</u);
  assert.doesNotMatch(html, /href="\/organization\/environments/u);
  assert.match(html, /Your environment asks before this action runs/u);
});

test("Project Ask First V4 cards expose Remember Approval", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      interactions={[{
        ...interaction,
        kind: "approval",
        eventType: "user.approval",
        requestEnvelope: {
          version: "runner_hosted_tool_approval_interaction_v4",
          approval: {
            toolName: "internet.research",
            presentation: {
              policy: {
                reasonCode: "project_restriction",
                rememberApprovalEligible: true,
              },
            },
          },
        },
        approvalPolicy: {
          projectId: "project-1",
          environmentId: "environment-1",
          appKey: "tavily",
          capabilityKey: "research",
          capabilityDisplayName: "Run research",
          environmentApprovalMode: "auto",
          projectApprovalMode: "ask",
          minimumApprovalMode: "auto",
          rememberApprovalEligible: true,
          reasonCode: "project_restriction",
          canEditProject: true,
        },
      }]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );
  assert.match(html, />Don&#x27;t allow</u);
  assert.match(html, />Allow once</u);
  assert.match(html, />Allow for thread</u);
});

test("a refreshed V4 card hides Remember Approval after Project policy becomes Blocked", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      interactions={[{
        ...interaction,
        kind: "approval",
        eventType: "user.approval",
        requestEnvelope: {
          version: "runner_hosted_tool_approval_interaction_v4",
          approval: {
            toolName: "internet.research",
            presentation: {
              policy: {
                reasonCode: "environment_policy",
                rememberApprovalEligible: true,
              },
            },
          },
        },
        approvalPolicy: {
          projectId: "project-1",
          environmentId: "environment-1",
          appKey: "tavily",
          capabilityKey: "research",
          capabilityDisplayName: "Run research",
          environmentApprovalMode: "ask",
          projectApprovalMode: "deny",
          minimumApprovalMode: "auto",
          rememberApprovalEligible: false,
          reasonCode: "environment_policy",
          canEditProject: true,
        },
      }]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );
  assert.match(html, />Don&#x27;t allow</u);
  assert.doesNotMatch(html, />Allow once</u);
  assert.doesNotMatch(html, />Allow for thread</u);
});

test("a refreshed built-in exec_command card hides Remember after Subject policy becomes Ask", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      interactions={[{
        ...interaction,
        kind: "approval",
        eventType: "user.approval",
        requestEnvelope: {
          version: "runner_hosted_tool_approval_interaction_v4",
          approval: {
            toolName: "exec_command",
            presentation: {
              policy: {
                reasonCode: "environment_policy",
                rememberApprovalEligible: true,
              },
            },
          },
        },
        approvalPolicy: {
          projectId: "project-1",
          environmentId: "environment-1",
          appKey: "built_in.workspace",
          capabilityKey: "executeCommand",
          capabilityDisplayName: "Execute command",
          environmentApprovalMode: "ask",
          projectApprovalMode: "ask",
          minimumApprovalMode: "auto",
          subjectApprovalMode: "ask",
          rememberApprovalEligible: false,
          reasonCode: "environment_policy",
          canEditProject: true,
        },
      }]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );
  assert.match(html, />Don&#x27;t allow</u);
  assert.match(html, />Allow once</u);
  assert.doesNotMatch(html, />Allow for thread</u);
});

test("a refreshed built-in exec_command card exposes only Decline after Subject policy blocks it", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      interactions={[{
        ...interaction,
        kind: "approval",
        eventType: "user.approval",
        requestEnvelope: {
          version: "runner_hosted_tool_approval_interaction_v4",
          approval: {
            toolName: "exec_command",
            presentation: { policy: { rememberApprovalEligible: true } },
          },
        },
        approvalPolicy: {
          projectId: "project-1",
          environmentId: "environment-1",
          appKey: "built_in.workspace",
          capabilityKey: "executeCommand",
          capabilityDisplayName: "Execute command",
          environmentApprovalMode: "ask",
          projectApprovalMode: "ask",
          minimumApprovalMode: "auto",
          subjectApprovalMode: "deny",
          rememberApprovalEligible: false,
          reasonCode: "environment_policy",
          canEditProject: true,
        },
      }]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );
  assert.match(html, />Don&#x27;t allow</u);
  assert.doesNotMatch(html, />Allow once</u);
  assert.doesNotMatch(html, />Allow for thread</u);
});

test("a refreshed V4 card exposes only Decline after its exact resource closes", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      interactions={[{
        ...interaction,
        kind: "approval",
        eventType: "user.approval",
        requestEnvelope: {
          version: "runner_hosted_tool_approval_interaction_v4",
          approval: {
            toolName: "internet.research",
            presentation: {
              policy: { reasonCode: "environment_policy" },
            },
          },
        },
        approvalPolicy: {
          projectId: "project-1",
          environmentId: "environment-1",
          appKey: "tavily",
          capabilityKey: "research",
          capabilityDisplayName: "Run research",
          environmentApprovalMode: "ask",
          projectApprovalMode: "ask",
          minimumApprovalMode: "auto",
          approvalResourceAvailable: false,
          reasonCode: "environment_policy",
          canEditProject: true,
        },
      }]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );
  assert.match(html, />Don&#x27;t allow</u);
  assert.doesNotMatch(html, />Allow once</u);
  assert.doesNotMatch(html, />Allow for thread</u);
});

test("hosted approval lifecycle hides settled cards and retains retryable failures", () => {
  const approval = {
    ...interaction,
    kind: "approval" as const,
    eventType: "user.approval",
    requestEnvelope: {
      approval: {
        toolCallId: "runtime-approval-1",
        toolName: "kestrel_one.email_send",
      },
    },
    responseEnvelope: { approved: true },
  };
  const processing = renderToStaticMarkup(
    <InteractionPanel
      interactions={[{
        ...approval,
        status: "processing",
        approvalOutcome: {
          decision: "approved",
          authorizationState: "pending",
          effectState: "not_started",
          retryEligible: false,
        },
      }]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );
  assert.equal(processing, "");

  const accepted = renderToStaticMarkup(
    <InteractionPanel
      interactions={[{
        ...approval,
        status: "resolved",
        approvalOutcome: {
          decision: "approved",
          authorizationState: "accepted",
          effectState: "not_started",
          retryEligible: false,
        },
      }]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );
  assert.equal(accepted, "");

  const failed = renderToStaticMarkup(
    <InteractionPanel
      interactions={[{
        ...approval,
        status: "failed",
        approvalOutcome: {
          decision: "approved",
          authorizationState: "failed",
          effectState: "not_started",
          failureCode: "EXTERNAL_APPROVAL_IDENTITY_MISMATCH",
          publicMessage: "The approval binding was rejected.",
          retryEligible: true,
        },
      }]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );
  assert.match(failed, /Not run/u);
  assert.doesNotMatch(failed, /EXTERNAL_APPROVAL_IDENTITY_MISMATCH/u);
  assert.match(failed, /Try again/u);
});

test("Remember Approval is unavailable for runtime-strict V4 approvals", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      interactions={[
        {
          ...interaction,
          kind: "approval",
          eventType: "user.approval",
          requestEnvelope: {
            version: "runner_hosted_tool_approval_interaction_v4",
            approval: {
              toolCallId: "tool-call-runtime-strict",
              toolName: "internet.research",
              presentation: {
                title: "Run web research",
                summary: "Start a multi-source Tavily research task.",
                fields: [],
                warnings: [],
                policy: {
                  mode: "ask",
                  reasonCode: "runtime_strict",
                  explanation:
                    "The current runtime mode requires approval for every tool call.",
                  authorityKind: "runtime_policy",
                  authorityRevision: "runtime-revision",
                },
              },
            },
          },
          approvalPolicy: {
            projectId: "project-1",
            environmentId: "environment-1",
            appKey: "tavily",
            capabilityKey: "research",
            capabilityDisplayName: "Run research",
            environmentApprovalMode: "auto",
            projectApprovalMode: "auto",
            minimumApprovalMode: "auto",
            reasonCode: "runtime_strict",
            canEditProject: true,
            approvalRequirementExplanation:
              "The current runtime mode requires approval for every tool call.",
          },
        },
      ]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );

  assert.doesNotMatch(html, />Allow for thread</u);
  assert.doesNotMatch(html, />Always Approve</u);
  assert.doesNotMatch(html, /href="\/organization\/environments/u);
  assert.match(html, /This action always needs your approval/u);
});

test("approval cards never render arbitrary raw tool input", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      interactions={[
        {
          ...interaction,
          kind: "approval",
          eventType: "user.approval",
          requestEnvelope: {
            approval: {
              toolCallId: "tool-call-3",
              toolName: "unknown.tool",
              input: { token: "must-not-render", prompt: "also-hidden" },
            },
          },
        },
      ]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );
  assert.match(html, /Request details are hidden/u);
  assert.doesNotMatch(html, /must-not-render|also-hidden/u);
});

test("exec command approval cards stay compact and clamp long command previews", () => {
  const command = `python3 - <<'PY'\n${"print('long command')\n".repeat(20)}PY`;
  const html = renderToStaticMarkup(
    <InteractionPanel
      interactions={[{
        ...interaction,
        kind: "approval",
        eventType: "user.approval",
        requestEnvelope: {
          version: "runner_hosted_tool_approval_interaction_v4",
          approval: {
            toolName: "exec_command",
            presentation: {
              title: "Run command",
              fields: [
                { label: "Command", value: command },
                { label: "Working directory", value: "." },
                { label: "Environment access", value: "[]" },
              ],
              policy: { reasonCode: "environment_policy" },
            },
          },
        },
      }]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );

  assert.match(html, /gap-0/u);
  assert.match(html, /py-0/u);
  assert.match(html, /line-clamp-2/u);
  assert.match(html, /title="python3 - &lt;&lt;&#x27;PY&#x27;/u);
  assert.match(html, />Folder</u);
  assert.match(html, />Environment</u);
  assert.match(html, />None</u);
});
