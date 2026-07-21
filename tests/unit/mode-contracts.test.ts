import assert from "node:assert/strict";

import {
  alignExecutionPolicyWithMode,
  isToolEligibleForInteractionMode,
  isToolClassAllowed,
  normalizeInteractionMode,
  resolveAllowedToolClasses,
} from "../../src/mode/contracts.js";
import { contractTest } from "../helpers/contract-test.js";


contractTest("runtime.hermetic", "normalizeInteractionMode preserves explicit build submodes", () => {
  assert.deepEqual(
    normalizeInteractionMode({
      interactionMode: "build",
      actSubmode: "full_auto",
      defaultActSubmode: "safe",
    }),
    {
      interactionMode: "build",
      actSubmode: "full_auto",
    },
  );

  assert.deepEqual(
    normalizeInteractionMode({
      interactionMode: "plan",
      actSubmode: "full_auto",
      defaultActSubmode: "safe",
    }),
    {
      interactionMode: "plan",
    },
  );

  assert.deepEqual(
    normalizeInteractionMode({
      defaultInteractionMode: "build",
      defaultActSubmode: "safe",
    }),
    {
      interactionMode: "build",
      actSubmode: "safe",
    },
  );
});

contractTest("runtime.hermetic", "alignExecutionPolicyWithMode leaves approval policy to the runtime", () => {
  assert.deepEqual(
    alignExecutionPolicyWithMode({
      interactionMode: "build",
      actSubmode: "full_auto",
      executionPolicy: {
        toolClassPolicy: {
          read_only: true,
          sandboxed_only: true,
          external_side_effect: false,
        },
        capabilityPolicy: {
          "workspace.read": true,
        },
        approvalPolicy: {
          strictApprovalPerCall: true,
        },
      },
    }),
    {
      toolClassPolicy: {
        read_only: true,
        sandboxed_only: true,
        external_side_effect: false,
      },
      capabilityPolicy: {
        "workspace.read": true,
      },
      approvalPolicy: {
        strictApprovalPerCall: true,
      },
    },
  );
});

contractTest("runtime.hermetic", "alignExecutionPolicyWithMode preserves explicit overrides", () => {
  assert.deepEqual(
    alignExecutionPolicyWithMode({
      interactionMode: "build",
      actSubmode: "safe",
      executionPolicy: {
        toolClassPolicy: {
          external_side_effect: true,
        },
      },
    }),
    {
      toolClassPolicy: {
        external_side_effect: true,
      },
    },
  );

  assert.equal(
    alignExecutionPolicyWithMode({
      interactionMode: "chat",
      executionPolicy: undefined,
    }),
    undefined,
  );
});

contractTest("runtime.hermetic", "resolveAllowedToolClasses respects execution-policy overrides", () => {
  assert.deepEqual(
    resolveAllowedToolClasses(
      {
        interactionMode: "build",
        actSubmode: "full_auto",
      },
      {
        toolClassPolicy: {
          external_side_effect: false,
        },
      },
    ),
    ["read_only", "sandboxed_only"],
  );

  assert.deepEqual(
    resolveAllowedToolClasses(
      {
        interactionMode: "build",
        actSubmode: "safe",
      },
      {
        toolClassPolicy: {
          external_side_effect: true,
        },
      },
    ),
    ["read_only", "sandboxed_only", "external_side_effect"],
  );
});

contractTest("runtime.hermetic", "plan mode allows read-only tools and session plan document writes by default", () => {
  assert.equal(
    isToolClassAllowed({
      interactionMode: "plan",
      toolClass: "sandboxed_only",
    }),
    false,
  );
  assert.deepEqual(resolveAllowedToolClasses({ interactionMode: "plan" }), ["read_only", "planning_write"]);
});

contractTest("runtime.hermetic", "Build exposes sandboxed workspace mutations while Chat and Plan do not", () => {
  assert.equal(
    isToolEligibleForInteractionMode({
      interactionMode: "build",
      toolClass: "sandboxed_only",
    }),
    true,
  );
  assert.equal(
    isToolEligibleForInteractionMode({
      interactionMode: "plan",
      toolClass: "sandboxed_only",
    }),
    false,
  );
  assert.equal(
    isToolEligibleForInteractionMode({
      interactionMode: "chat",
      toolClass: "sandboxed_only",
    }),
    false,
  );
});

contractTest("runtime.hermetic", "Chat allows read-only tools and only explicitly Chat-enabled app mutations", () => {
  assert.equal(
    isToolEligibleForInteractionMode({
      interactionMode: "chat",
      toolClass: "read_only",
    }),
    true,
  );
  assert.equal(
    isToolEligibleForInteractionMode({
      interactionMode: "chat",
      toolClass: "sandboxed_only",
      executionPolicy: { toolClassPolicy: { sandboxed_only: true } },
    }),
    false,
  );
  assert.equal(
    isToolEligibleForInteractionMode({
      interactionMode: "chat",
      toolClass: "external_side_effect",
    }),
    false,
  );
  assert.equal(
    isToolEligibleForInteractionMode({
      interactionMode: "chat",
      toolClass: "external_side_effect",
      allowedInteractionModes: ["chat", "build"],
    }),
    true,
  );
  assert.equal(
    isToolEligibleForInteractionMode({
      interactionMode: "chat",
      toolClass: "external_side_effect",
      allowedInteractionModes: ["chat", "build"],
      executionPolicy: { capabilityPolicy: { "external.confirm": false } },
      requiredCapabilities: ["external.confirm"],
    }),
    false,
  );
});
