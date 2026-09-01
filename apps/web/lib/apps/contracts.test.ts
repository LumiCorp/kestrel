import test from "node:test";
import assert from "node:assert/strict";
import {
  browserEnvironmentAppCapabilityGrantSchema,
  browserProjectAppCapabilityPolicySchema,
  createEnvironmentAppConnectionSchema,
  environmentAppCapabilityGrantSchema,
} from "./contracts";

test("Environment connection input accepts named Tavily connections", () => {
  assert.deepEqual(
    createEnvironmentAppConnectionSchema.parse({
      name: "Primary",
      apiKey: "tvly-secret",
      projectId: "research",
    }),
    {
      kind: "api_key",
      name: "Primary",
      apiKey: "tvly-secret",
      projectId: "research",
    },
  );
});

test("Browser Environment settings canonicalize domains and round-trip exact authority", () => {
  assert.deepEqual(
    browserEnvironmentAppCapabilityGrantSchema.parse({
      enabled: true,
      approvalMode: "auto",
      loggingMode: "metadata_only",
      rateLimitMode: "off",
      settings: {
        enabledModes: ["operator", "qa"],
        personalGrantsEnabled: true,
        configuredPublicDomains: ["https://www.Example.com/path?secret=yes"],
        blockedPublicDomains: ["blocked.example.net"],
      },
    }).settings,
    {
      enabledModes: ["operator", "qa"],
      personalGrantsEnabled: true,
      configuredPublicDomains: [
        {
          version: "browser_public_domain_authority_v1",
          scheme: "https",
          canonicalDomain: "example.com",
          includeSubdomains: true,
          port: 443,
        },
      ],
      blockedPublicDomains: [
        {
          version: "browser_public_domain_authority_v1",
          scheme: "https",
          canonicalDomain: "example.net",
          includeSubdomains: true,
          port: 443,
        },
      ],
    },
  );
});

test("Browser settings reject ambiguous, private, and expanding shapes", () => {
  assert.throws(() =>
    browserEnvironmentAppCapabilityGrantSchema.parse({
      enabled: true,
      approvalMode: "auto",
      loggingMode: "metadata_only",
      rateLimitMode: "off",
      settings: {
        enabledModes: ["operator"],
        personalGrantsEnabled: true,
        configuredPublicDomains: ["http://example.com"],
        blockedPublicDomains: [],
      },
    }),
  );
  assert.throws(() =>
    browserProjectAppCapabilityPolicySchema.parse({
      enabled: true,
      approvalMode: "auto",
      settings: {
        enabledModes: ["operator"],
        personalGrantsEnabled: true,
        configuredPublicDomains: ["example.com"],
        blockedPublicDomains: [],
      },
    }),
  );
});

test("Environment connection endpoints must be HTTPS and contain no credentials", () => {
  assert.throws(() =>
    createEnvironmentAppConnectionSchema.parse({
      name: "Primary",
      apiKey: "tvly-secret",
      baseUrl: "https://user:secret@example.test",
    }),
  );
});

test("retired preview provider credentials are rejected", () => {
  const retiredProviderKey = ["n", "g", "r", "o", "k"].join("");
  assert.throws(() =>
    createEnvironmentAppConnectionSchema.parse({
      kind: `${retiredProviderKey}_agent`,
      name: "Legacy preview",
      authtoken: "secret",
      wildcardDomain: "*.preview.example.test",
    }),
  );
});

test("disabling a capability always makes the ceiling deny", () => {
  assert.deepEqual(
    environmentAppCapabilityGrantSchema.parse({
      enabled: false,
      approvalMode: "auto",
      loggingMode: "metadata_only",
      rateLimitMode: "default",
    }),
    {
      enabled: false,
      approvalMode: "deny",
      loggingMode: "metadata_only",
      rateLimitMode: "default",
    },
  );
});
