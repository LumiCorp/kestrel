import test from "node:test";
import assert from "node:assert/strict";

import {
  APPROVAL_CAPABILITY_CLASSES,
  alignExecutionPolicyWithMode,
  isToolEligibleForInteractionMode,
  isToolClassAllowed,
  normalizeInteractionMode,
  parseExecutionPolicyOverride,
  readBlockedApprovalCapability,
  resolveAllowedToolClasses,
} from "../../src/mode/contracts.js";

test("parseExecutionPolicyOverride preserves every canonical boolean policy field", () => {
  const capabilityPolicy = Object.fromEntries(
    APPROVAL_CAPABILITY_CLASSES.map((capability, index) => [capability, index % 2 === 0]),
  );

  assert.deepEqual(
    parseExecutionPolicyOverride({
      toolClassPolicy: {
        read_only: true,
        planning_write: false,
        sandboxed_only: true,
        external_side_effect: false,
        unknown_tool_class: true,
      },
      capabilityPolicy: {
        ...capabilityPolicy,
        "unknown.capability": true,
      },
      approvalPolicy: {
        strictApprovalPerCall: false,
        unknownApprovalField: true,
      },
      unknownTopLevelField: true,
    }),
    {
      toolClassPolicy: {
        read_only: true,
        planning_write: false,
        sandboxed_only: true,
        external_side_effect: false,
      },
      capabilityPolicy,
      approvalPolicy: {
        strictApprovalPerCall: false,
      },
    },
  );
});

test("parseExecutionPolicyOverride rejects invalid roots and preserves fail-closed empty policies", () => {
  assert.equal(parseExecutionPolicyOverride(undefined), undefined);
  assert.equal(parseExecutionPolicyOverride(null), undefined);
  assert.equal(parseExecutionPolicyOverride([]), undefined);
  assert.equal(parseExecutionPolicyOverride({ capabilityPolicy: [] }), undefined);

  const executionPolicy = parseExecutionPolicyOverride({
    capabilityPolicy: {
      "external.confirm": "true",
      "unknown.capability": true,
    },
  });
  assert.deepEqual(executionPolicy, { capabilityPolicy: {} });
  assert.equal(
    readBlockedApprovalCapability({
      executionPolicy,
      requiredCapabilities: ["external.confirm"],
    }),
    "external.confirm",
  );
});


test("normalizeInteractionMode preserves explicit build submodes", () => {
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

test("alignExecutionPolicyWithMode leaves approval policy to the runtime", () => {
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

test("alignExecutionPolicyWithMode preserves explicit overrides", () => {
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

test("resolveAllowedToolClasses respects execution-policy overrides", () => {
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

test("plan mode allows read-only tools and session plan document writes by default", () => {
  assert.equal(
    isToolClassAllowed({
      interactionMode: "plan",
      toolClass: "sandboxed_only",
    }),
    false,
  );
  assert.deepEqual(resolveAllowedToolClasses({ interactionMode: "plan" }), ["read_only", "planning_write"]);
});

test("Build exposes sandboxed workspace mutations while Chat and Plan do not", () => {
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

test("Plan allows only external mutations that explicitly opt into Plan", () => {
  assert.equal(
    isToolEligibleForInteractionMode({
      interactionMode: "plan",
      toolClass: "external_side_effect",
    }),
    false,
  );
  assert.equal(
    isToolEligibleForInteractionMode({
      interactionMode: "plan",
      toolClass: "external_side_effect",
      allowedInteractionModes: ["chat", "plan", "build"],
    }),
    true,
  );
  assert.equal(
    isToolEligibleForInteractionMode({
      interactionMode: "plan",
      toolClass: "external_side_effect",
      allowedInteractionModes: ["chat", "plan", "build"],
      executionPolicy: { capabilityPolicy: { "mission_control.work_item.write": false } },
      requiredCapabilities: ["mission_control.work_item.write"],
    }),
    false,
  );
});

test("Chat allows read-only tools and only explicitly Chat-enabled app mutations", () => {
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
