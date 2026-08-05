import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopOnboardingProviderFailureKind } from "../src/contracts.js";
import {
  canReuseDesktopOnboardingProviderVerification,
  createDesktopOnboardingProviderFailure,
} from "../src/onboardingProviderVerificationResult.js";
import { findExactRegisteredOnboardingProject } from "../src/onboardingProjectSelection.js";

test("onboarding provider failures preserve safe distinct kinds and copy", () => {
  const kinds: DesktopOnboardingProviderFailureKind[] = [
    "invalid_credential",
    "provider_rejected",
    "timeout",
    "unreachable",
    "model_unavailable",
    "secure_storage_unavailable",
  ];
  const messages = new Set<string>();
  for (const kind of kinds) {
    const result = createDesktopOnboardingProviderFailure(kind);
    assert.equal(result.ok, false);
    if (result.ok === false) {
      assert.equal(result.failure.kind, kind);
      assert.notEqual(result.failure.message, "");
      messages.add(result.failure.message);
    }
  }
  assert.equal(messages.size, kinds.length);
});

test("renderer project inspection resolves only an exact registered path", () => {
  const project = {
    path: "/workspace/registered",
    label: "Registered",
    addedAt: "2026-08-04T12:00:00.000Z",
  };
  assert.equal(
    findExactRegisteredOnboardingProject([project], project.path),
    project,
  );
  assert.equal(
    findExactRegisteredOnboardingProject([project], "/workspace/arbitrary"),
    undefined,
  );
  assert.equal(
    findExactRegisteredOnboardingProject([project], ` ${project.path}`),
    undefined,
  );
});

test("provider verification reuse requires matching configuration and a configured credential", () => {
  const verifiedConfiguration = {
    requestedProvider: "openrouter" as const,
    requestedModel: "openai/gpt-5",
    activeProvider: "openrouter" as const,
    activeModel: "openai/gpt-5",
    credentialConfigured: true,
    verificationPresent: true,
  };

  assert.equal(
    canReuseDesktopOnboardingProviderVerification(verifiedConfiguration),
    true,
  );
  assert.equal(
    canReuseDesktopOnboardingProviderVerification({
      ...verifiedConfiguration,
      credentialConfigured: false,
    }),
    false,
  );
  assert.equal(
    canReuseDesktopOnboardingProviderVerification({
      ...verifiedConfiguration,
      verificationPresent: false,
    }),
    false,
  );
  assert.equal(
    canReuseDesktopOnboardingProviderVerification({
      ...verifiedConfiguration,
      requestedModel: "anthropic/claude-sonnet-4",
    }),
    false,
  );
});
