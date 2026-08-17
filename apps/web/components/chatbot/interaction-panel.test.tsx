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

test("Kestrel One renders an explicit mode switch for the shared runtime contract", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      currentMode="chat"
      interactions={[interaction]}
      onModeSwitch={async () => {}}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );
  assert.match(html, /Continue in Build/u);
  assert.match(html, /Switch to Build and continue/u);
});

test("Kestrel One does not guess a mode switch without the explicit contract", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      currentMode="chat"
      interactions={[
        {
          ...interaction,
          requestEnvelope: { metadata: { reason: "ordinary_question" } },
        },
      ]}
      onModeSwitch={async () => {}}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );
  assert.doesNotMatch(html, /Switch to Build/u);
});

test("Kestrel One shows policy-owned approval choices and Environment guidance", () => {
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
            reasonCode: "environment_policy",
            canEditProject: true,
            alwaysApprovalAction: "open_environment_apps",
            environmentAppsHref:
              "/organization/environments/environment-1/apps/tavily",
          },
        },
      ]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );

  assert.match(html, />Deny</u);
  assert.match(html, />Approve Once</u);
  assert.match(html, />Always Approve</u);
  assert.match(html, /Start a multi-source Tavily research task/u);
  assert.match(html, /internet\.research/u);
  assert.match(html, /Research request/u);
  assert.match(html, /Kestrel/u);
  assert.match(html, /Environment: Ask first/u);
  assert.match(html, /Project: Ask first/u);
  assert.match(html, /Environment Apps is configured to ask/u);
  assert.match(
    html,
    /organization\/environments\/environment-1\/apps\/tavily/u,
  );
  assert.doesNotMatch(html, /disabled=""[^>]*>Always Approve/u);
  assert.doesNotMatch(html, />Approve<\/button>/u);
});

test("Always Approve always hands persistent policy changes to Environment Apps", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      interactions={[
        {
          ...interaction,
          kind: "approval",
          eventType: "user.approval",
          requestEnvelope: {
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
                  reasonCode: "project_restriction",
                  explanation:
                    "This Project narrows the Environment policy to Ask first.",
                  authorityKind: "hosted_app_policy",
                  authorityRevision: "revision-2",
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
            reasonCode: "project_restriction",
            canEditProject: true,
            alwaysApprovalAction: "open_environment_apps",
            environmentAppsHref:
              "/organization/environments/environment-1/apps/tavily",
          },
        },
      ]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );

  assert.match(
    html,
    /href="\/organization\/environments\/environment-1\/apps\/tavily"/u,
  );
  assert.match(html, /This Project narrows the Environment policy/u);
});

test("Always Approve is unavailable for runtime-strict approvals", () => {
  const html = renderToStaticMarkup(
    <InteractionPanel
      interactions={[
        {
          ...interaction,
          kind: "approval",
          eventType: "user.approval",
          requestEnvelope: {
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
            alwaysApprovalAction: "unavailable",
            environmentAppsHref:
              "/organization/environments/environment-1/apps/tavily",
          },
        },
      ]}
      onResolved={async () => {}}
      onRuntimeResponse={async () => {}}
      threadId="thread-1"
    />,
  );

  assert.match(html, /disabled=""[^>]*>Always Approve/u);
  assert.doesNotMatch(html, /href="\/organization\/environments/u);
  assert.match(html, /current runtime mode requires approval/u);
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
