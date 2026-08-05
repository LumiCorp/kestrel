import assert from "node:assert/strict";
import test from "node:test";

import {
  deriveDesktopOnboardingRouteV1,
  desktopUiStateContainsOnboardingHandoff,
} from "../../src/desktopShell/onboarding.js";

const startedAt = "2026-08-04T12:00:00.000Z";

test("Desktop onboarding route matrix derives the first unmet requirement", () => {
  const cases = [
    {
      name: "pristine install",
      input: { providerVerified: false, projectReady: false, hasExistingState: false },
      expected: { mode: "first_run", step: "welcome" },
    },
    {
      name: "hosted provider without key",
      input: {
        record: { version: 1, status: "in_progress", startedAt, provider: "openrouter", model: "openai/gpt-5" },
        providerVerified: false,
        projectReady: false,
        hasExistingState: true,
      },
      expected: { mode: "resume", step: "provider" },
    },
    {
      name: "valid provider without project",
      input: {
        record: { version: 1, status: "in_progress", startedAt, provider: "openrouter", model: "openai/gpt-5" },
        providerVerified: true,
        projectReady: false,
        hasExistingState: true,
      },
      expected: { mode: "resume", step: "project" },
    },
    {
      name: "interrupted setup ready for review",
      input: {
        record: { version: 1, status: "in_progress", startedAt, provider: "ollama", model: "qwen3" },
        providerVerified: true,
        projectReady: true,
        hasExistingState: true,
      },
      expected: { mode: "resume", step: "review" },
    },
    {
      name: "completed v1",
      input: {
        record: { version: 1, status: "complete", startedAt, completedAt: startedAt },
        providerVerified: true,
        projectReady: true,
        hasExistingState: true,
      },
      expected: { mode: "resume", step: "review" },
    },
    {
      name: "later credential repair",
      input: {
        record: { version: 1, status: "complete", startedAt, completedAt: startedAt },
        providerVerified: false,
        projectReady: true,
        hasExistingState: true,
      },
      expected: { mode: "repair", step: "provider" },
    },
    {
      name: "later project repair",
      input: {
        record: { version: 1, status: "complete", startedAt, completedAt: startedAt },
        providerVerified: true,
        projectReady: false,
        hasExistingState: true,
      },
      expected: { mode: "repair", step: "project" },
    },
  ] as const;

  for (const entry of cases) {
    assert.deepEqual(deriveDesktopOnboardingRouteV1(entry.input), entry.expected, entry.name);
  }
});

test("Desktop onboarding handoff acknowledgement requires the matching persisted thread", () => {
  const handoffId = "handoff-stable-v1";
  const entries = {
    "kchat:web:threads:v2": JSON.stringify({
      states: {
        "thread-1": { onboardingHandoffId: handoffId },
      },
    }),
  };
  assert.equal(
    desktopUiStateContainsOnboardingHandoff(entries, handoffId),
    true,
  );
  assert.equal(
    desktopUiStateContainsOnboardingHandoff(entries, "another-handoff"),
    false,
  );
  assert.equal(
    desktopUiStateContainsOnboardingHandoff(
      { "kchat:web:threads:v2": "not-json" },
      handoffId,
    ),
    false,
  );
});
