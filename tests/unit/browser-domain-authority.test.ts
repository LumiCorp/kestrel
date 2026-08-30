import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_ENVIRONMENT_DOMAIN_AUTHORITY_VERSION,
  BROWSER_PERSONAL_DOMAIN_AUTHORITY_VERSION,
  BROWSER_PROJECT_DOMAIN_AUTHORITY_VERSION,
  BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION,
  BROWSER_QA_DOMAIN_AUTHORITY_VERSION,
  BROWSER_PUBLIC_GRANT_DECISION_VERSION,
  assertPublicBrowserResolvedAddresses,
  browserPublicDomainAllowsHostname,
  canonicalizePublicBrowserDestination,
  canonicalizeTrustedBrowserQaTarget,
  effectiveBrowserAuthorityAllowsPublicDestination,
  resolveEffectiveBrowserDomainAuthority,
  resolveBrowserPublicGrantDecision,
  type BrowserDomainAuthorityInputV1,
  type BrowserPublicDomainAuthorityV1,
} from "../../src/browser/domainAuthority.js";
import {
  BROWSER_ALLOWLIST_ADOPTION_RECEIPT_VERSION,
  BROWSER_ALLOWLIST_ADOPTION_VERSION,
  BROWSER_SERVICE_PORT_VERSION,
  adoptBrowserAllowlistRevision,
  isConformingBrowserServicePort,
  type BrowserServicePort,
} from "../../src/browser/contracts.js";

test("public Browser destinations canonicalize to one HTTPS registrable apex", () => {
  assert.deepEqual(
    canonicalizePublicBrowserDestination(
      "https://WWW.食狮.COM.CN.:443/a/path?secret=yes#fragment",
    ),
    {
      version: BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION,
      scheme: "https",
      canonicalDomain: "xn--85x722f.com.cn",
      includeSubdomains: true,
      port: 443,
    },
  );

  const example = canonicalizePublicBrowserDestination(
    "https://deep.shop.example.com/account?token=discarded#discarded",
  );
  assert.equal(example.canonicalDomain, "example.com");
  assert.equal(browserPublicDomainAllowsHostname(example, "example.com."), true);
  assert.equal(browserPublicDomainAllowsHostname(example, "a.b.example.com"), true);
  assert.equal(browserPublicDomainAllowsHostname(example, "notexample.com"), false);
  assert.equal(
    effectiveBrowserAuthorityAllowsPublicDestination(
      resolveEffectiveBrowserDomainAuthority(authorityInput({ configured: [example] })),
      "https://other.example.com/new/path?not-authority=1",
    ),
    true,
  );
});

test("the private PSL tenant boundary never grants a sibling tenant", () => {
  const tenant = canonicalizePublicBrowserDestination(
    "https://preview.team-one.vercel.app/build/1",
  );
  assert.equal(tenant.canonicalDomain, "team-one.vercel.app");
  assert.equal(browserPublicDomainAllowsHostname(tenant, "api.team-one.vercel.app"), true);
  assert.equal(browserPublicDomainAllowsHostname(tenant, "team-two.vercel.app"), false);
});

test("public Browser grants fail closed for non-public or non-HTTPS authority", () => {
  for (const destination of [
    "http://example.com",
    "https://example.com:8443",
    "https://person:secret@example.com",
    "https://com",
    "https://co.uk",
    "https://127.0.0.1",
    "https://0x7f000001",
    "https://[::1]",
    "https://169.254.169.254/latest/meta-data",
    "https://metadata.google.internal",
    "https://service.local",
    "file:///etc/passwd",
    "example.com",
  ]) {
    assert.throws(
      () => canonicalizePublicBrowserDestination(destination),
      /BROWSER_DESTINATION_BLOCKED/u,
      destination,
    );
  }
});

test("DNS authority rejects rebinding into private, metadata, or reserved networks", () => {
  assert.doesNotThrow(() =>
    assertPublicBrowserResolvedAddresses(["1.1.1.1", "2606:4700:4700::1111"]),
  );
  for (const addresses of [
    [],
    ["10.0.0.8"],
    ["169.254.169.254"],
    ["192.0.2.1"],
    ["::1"],
    ["fd00::1"],
    ["fe80::1"],
    ["::ffff:127.0.0.1"],
    ["not-an-address"],
    ["1.1.1.1", "10.0.0.8"],
  ]) {
    assert.throws(
      () => assertPublicBrowserResolvedAddresses(addresses),
      /BROWSER_DESTINATION_BLOCKED/u,
      addresses.join(","),
    );
  }
});

test("trusted QA authority stays one exact target and never becomes public authority", () => {
  assert.deepEqual(canonicalizeTrustedBrowserQaTarget("http://LOCALHOST.:4317/path?q=1"), {
    version: "browser_qa_target_v1",
    scheme: "http",
    hostname: "localhost",
    port: 4317,
  });
  assert.deepEqual(canonicalizeTrustedBrowserQaTarget("https://preview.example.com/path"), {
    version: "browser_qa_target_v1",
    scheme: "https",
    hostname: "preview.example.com",
    port: 443,
  });
  assert.throws(
    () => canonicalizeTrustedBrowserQaTarget("https://person:secret@localhost:4317"),
    /cannot contain credentials/u,
  );
});

test("effective authority applies Environment ceiling and Project narrowing", () => {
  const configured = publicDomain("configured.example.com");
  const personal = publicDomain("remembered.example.net");
  const blocked = publicDomain("blocked.example.org");
  const input = authorityInput({
    configured: [configured, blocked],
    personal: [personal],
    environmentBlocked: [blocked],
  });
  const effective = resolveEffectiveBrowserDomainAuthority(input);
  assert.deepEqual(
    effective.publicDomains.map((entry) => entry.canonicalDomain),
    ["example.com", "example.net"],
  );
  assert.equal(effective.personalGrantsEnabled, true);
  assert.deepEqual(effective.qaTarget, input.qa.target);
  assert.equal(
    resolveBrowserPublicGrantDecision(input, "https://www.configured.example.com/path")
      .decision,
    "already_allowed",
  );
  assert.deepEqual(
    resolveBrowserPublicGrantDecision(input, "https://new.example.edu/path"),
    {
      version: BROWSER_PUBLIC_GRANT_DECISION_VERSION,
      decision: "approval_required",
      authority: publicDomain("new.example.edu"),
      effectiveAllowlistRevision: effective.effectiveAllowlistRevision,
    },
  );
  assert.equal(
    resolveBrowserPublicGrantDecision(input, "https://blocked.example.org/path").decision,
    "blocked",
  );

  const narrowed = resolveEffectiveBrowserDomainAuthority({
    ...input,
    project: {
      ...input.project,
      revision: "project-2",
      personalGrantsEnabled: false,
      blockedPublicDomains: [configured],
    },
  });
  assert.deepEqual(narrowed.publicDomains, []);
  assert.equal(narrowed.personalGrantsEnabled, false);
  assert.equal(
    resolveBrowserPublicGrantDecision(narrowedInput(input, configured), "https://new.example.edu")
      .decision,
    "blocked",
  );

  assert.throws(
    () =>
      resolveEffectiveBrowserDomainAuthority({
        ...input,
        environment: { ...input.environment, enabledModes: ["operator"] },
        project: { ...input.project, enabledModes: ["qa", "operator"] },
      }),
    /only narrow Environment modes/u,
  );
  assert.throws(
    () =>
      resolveEffectiveBrowserDomainAuthority({
        ...input,
        environment: { ...input.environment, personalGrantsEnabled: false },
      }),
    /cannot enable personal grants/u,
  );
});

test("personal authority reuses across Projects but remains user and Environment scoped", () => {
  const remembered = publicDomain("portal.example.com");
  const first = authorityInput({ personal: [remembered] });
  const second = {
    ...first,
    project: { ...first.project, projectId: "project-2", revision: "project-2-policy" },
  };
  const firstEffective = resolveEffectiveBrowserDomainAuthority(first);
  const secondEffective = resolveEffectiveBrowserDomainAuthority(second);
  assert.deepEqual(firstEffective.publicDomains, secondEffective.publicDomains);
  assert.notEqual(
    firstEffective.effectiveAllowlistRevision,
    secondEffective.effectiveAllowlistRevision,
  );

  const anotherUser = resolveEffectiveBrowserDomainAuthority({
    ...first,
    personal: { ...first.personal, userId: "user-2" },
  });
  assert.notEqual(firstEffective.userId, anotherUser.userId);
  assert.notEqual(
    firstEffective.effectiveAllowlistRevision,
    anotherUser.effectiveAllowlistRevision,
  );

  assert.throws(
    () =>
      resolveEffectiveBrowserDomainAuthority({
        ...first,
        personal: { ...first.personal, environmentId: "environment-2" },
      }),
    /different Environment/u,
  );
});

test("effective revision fingerprints every authoritative input deterministically", () => {
  const input = authorityInput({
    configured: [publicDomain("alpha.example.com"), publicDomain("beta.example.net")],
    personal: [publicDomain("remembered.example.org")],
  });
  const base = resolveEffectiveBrowserDomainAuthority(input).effectiveAllowlistRevision;
  const reordered = resolveEffectiveBrowserDomainAuthority({
    ...input,
    environment: {
      ...input.environment,
      enabledModes: ["operator", "qa"],
      configuredPublicDomains: [...input.environment.configuredPublicDomains].reverse(),
    },
  }).effectiveAllowlistRevision;
  assert.equal(base, reordered);

  const variants: BrowserDomainAuthorityInputV1[] = [
    { ...input, environment: { ...input.environment, revision: "environment-policy-2" } },
    { ...input, project: { ...input.project, revision: "project-policy-2" } },
    { ...input, personal: { ...input.personal, revision: "personal-2" } },
    { ...input, qa: { ...input.qa, revision: "qa-2" } },
    { ...input, qa: { ...input.qa, target: null } },
  ];
  for (const variant of variants) {
    assert.notEqual(
      resolveEffectiveBrowserDomainAuthority(variant).effectiveAllowlistRevision,
      base,
    );
  }
});

test("BrowserServicePort requires and confirms exact allowlist revision adoption", async () => {
  const adopted: string[] = [];
  const port = browserPort(async (input) => {
    adopted.push(input.effectiveAllowlistRevision);
    return {
      version: BROWSER_ALLOWLIST_ADOPTION_RECEIPT_VERSION,
      sessionId: input.sessionId,
      effectiveAllowlistRevision: input.effectiveAllowlistRevision,
    };
  });
  assert.equal(isConformingBrowserServicePort(port), true);
  assert.equal(
    isConformingBrowserServicePort({
      ...port,
      adoptAllowlistRevision: undefined,
    } as unknown as BrowserServicePort),
    false,
  );

  const request = {
    version: BROWSER_ALLOWLIST_ADOPTION_VERSION,
    runId: "run-1",
    threadId: "thread-1",
    sessionId: "browser-session-1",
    effectiveAllowlistRevision: "sha256:new-authority",
    cause: "personal_grant" as const,
  };
  assert.equal(
    (await adoptBrowserAllowlistRevision(port, request)).effectiveAllowlistRevision,
    request.effectiveAllowlistRevision,
  );
  assert.deepEqual(adopted, [request.effectiveAllowlistRevision]);

  await assert.rejects(
    adoptBrowserAllowlistRevision(
      browserPort(async (input) => ({
        version: BROWSER_ALLOWLIST_ADOPTION_RECEIPT_VERSION,
        sessionId: input.sessionId,
        effectiveAllowlistRevision: "stale-revision",
      })),
      request,
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      (error as Error & { code?: string }).code === "BROWSER_SERVICE_UNAVAILABLE",
  );
});

function publicDomain(destination: string): BrowserPublicDomainAuthorityV1 {
  return canonicalizePublicBrowserDestination(`https://${destination}`);
}

function authorityInput(
  options: Partial<{
    configured: BrowserPublicDomainAuthorityV1[];
    personal: BrowserPublicDomainAuthorityV1[];
    environmentBlocked: BrowserPublicDomainAuthorityV1[];
  }> = {},
): BrowserDomainAuthorityInputV1 {
  return {
    environment: {
      version: BROWSER_ENVIRONMENT_DOMAIN_AUTHORITY_VERSION,
      environmentId: "environment-1",
      revision: "environment-policy-1",
      enabledModes: ["qa", "operator"],
      personalGrantsEnabled: true,
      configuredPublicDomains: options.configured ?? [],
      blockedPublicDomains: options.environmentBlocked ?? [],
    },
    project: {
      version: BROWSER_PROJECT_DOMAIN_AUTHORITY_VERSION,
      projectId: "project-1",
      revision: "project-policy-1",
      enabledModes: ["qa", "operator"],
      personalGrantsEnabled: true,
      blockedPublicDomains: [],
    },
    personal: {
      version: BROWSER_PERSONAL_DOMAIN_AUTHORITY_VERSION,
      userId: "user-1",
      environmentId: "environment-1",
      revision: "personal-1",
      activeDomains: options.personal ?? [],
    },
    qa: {
      version: BROWSER_QA_DOMAIN_AUTHORITY_VERSION,
      revision: "qa-1",
      target: canonicalizeTrustedBrowserQaTarget("http://localhost:4317"),
    },
  };
}

function narrowedInput(
  input: BrowserDomainAuthorityInputV1,
  blocked: BrowserPublicDomainAuthorityV1,
): BrowserDomainAuthorityInputV1 {
  return {
    ...input,
    project: {
      ...input.project,
      revision: "project-narrowed",
      personalGrantsEnabled: false,
      blockedPublicDomains: [blocked],
    },
  };
}

function browserPort(
  adopt: BrowserServicePort["adoptAllowlistRevision"],
): BrowserServicePort {
  return {
    version: BROWSER_SERVICE_PORT_VERSION,
    async resolvePolicy() {
      return {
        version: "browser_policy_resolution_v1",
        decision: "allow",
        policyRevision: "policy-1",
      };
    },
    async execute() {
      throw new Error("not used");
    },
    async authorizeArtifact() {
      return undefined;
    },
    adoptAllowlistRevision: adopt,
  };
}
