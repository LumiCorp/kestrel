import assert from "node:assert/strict";
import test from "node:test";

import {
  BROWSER_QA_DOMAIN_AUTHORITY_VERSION,
  BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION,
} from "../../../../src/browser/domainAuthority.js";
import {
  HostedBrowserDomainError,
  HOSTED_BROWSER_DOMAIN_POLICY_CAPABILITY_KEY,
  listHostedBrowserPersonalDomains,
  parseHostedBrowserEnvironmentSettings,
  parseHostedBrowserProjectSettings,
  readHostedBrowserDomainAuthorityInput,
  resolveHostedBrowserDomainAuthority,
  resolveHostedBrowserPublicGrantDecision,
} from "./browser-domain-service.js";

const publicDomain = (canonicalDomain: string) => ({
  version: BROWSER_PUBLIC_DOMAIN_AUTHORITY_VERSION,
  scheme: "https" as const,
  canonicalDomain,
  includeSubdomains: true as const,
  port: 443 as const,
});

const qa = {
  version: BROWSER_QA_DOMAIN_AUTHORITY_VERSION,
  revision: "qa-none",
  target: null,
};

test("hosted Browser settings parsers enforce exact canonical authority", () => {
  assert.equal(HOSTED_BROWSER_DOMAIN_POLICY_CAPABILITY_KEY, "request_grant");
  assert.deepEqual(
    parseHostedBrowserEnvironmentSettings({
      enabledModes: ["operator", "qa"],
      personalGrantsEnabled: true,
      configuredPublicDomains: [publicDomain("example.com")],
      blockedPublicDomains: [publicDomain("blocked.example")],
    }),
    {
      enabledModes: ["operator", "qa"],
      personalGrantsEnabled: true,
      configuredPublicDomains: [publicDomain("example.com")],
      blockedPublicDomains: [publicDomain("blocked.example")],
    },
  );
  assert.deepEqual(
    parseHostedBrowserProjectSettings({
      enabledModes: ["operator"],
      personalGrantsEnabled: false,
      blockedPublicDomains: [],
    }),
    {
      enabledModes: ["operator"],
      personalGrantsEnabled: false,
      blockedPublicDomains: [],
    },
  );
  assert.throws(
    () =>
      parseHostedBrowserEnvironmentSettings({
        enabledModes: ["operator"],
        personalGrantsEnabled: true,
        configuredPublicDomains: [],
        blockedPublicDomains: [],
        credential: "must-not-be-accepted",
      }),
    (error: unknown) =>
      error instanceof HostedBrowserDomainError &&
      error.code === "BROWSER_DOMAIN_SETTINGS_INVALID",
  );
  assert.throws(
    () =>
      parseHostedBrowserProjectSettings({
        enabledModes: ["operator"],
        personalGrantsEnabled: true,
        blockedPublicDomains: [publicDomain("Sub.Example.com")],
      }),
    /canonical/u,
  );
});

test("a Project without an enabled Browser App has no effective domain authority", async () => {
  const database = fakeAuthorityDatabase({
    projectId: "project-disabled",
    projectApp: undefined,
  });
  const authority = await resolveHostedBrowserDomainAuthority(
    {
      organizationId: "org-a",
      environmentId: "environment-a",
      projectId: "project-disabled",
      userId: "user-a",
      qa,
    },
    database as never,
  );
  assert.deepEqual(authority.enabledModes, []);
  assert.deepEqual(authority.publicDomains, []);
  assert.equal(authority.personalGrantsEnabled, false);
});

test("Project settings may narrow but cannot exceed the Environment ceiling", async () => {
  const database = fakeAuthorityDatabase({
    projectId: "project-expanding",
    projectSettings: {
      enabledModes: ["operator", "qa"],
      personalGrantsEnabled: true,
      blockedPublicDomains: [],
    },
  });
  await assert.rejects(
    resolveHostedBrowserDomainAuthority(
      {
        organizationId: "org-a",
        environmentId: "environment-a",
        projectId: "project-expanding",
        userId: "user-a",
        qa,
      },
      database as never,
    ),
    /only narrow Environment modes/u,
  );
});

test("hosted authority reads reuse one personal grant across Projects while preserving narrowing", async () => {
  const allowedDatabase = fakeAuthorityDatabase({
    projectId: "project-a",
    projectSettings: {
      enabledModes: ["operator"],
      personalGrantsEnabled: true,
      blockedPublicDomains: [],
    },
  });
  const narrowedDatabase = fakeAuthorityDatabase({
    projectId: "project-b",
    projectSettings: {
      enabledModes: ["operator"],
      personalGrantsEnabled: true,
      blockedPublicDomains: [publicDomain("example.com")],
    },
  });
  const base = {
    organizationId: "org-a",
    environmentId: "environment-a",
    userId: "user-a",
    qa,
  };
  const first = await resolveHostedBrowserDomainAuthority(
    { ...base, projectId: "project-a" },
    allowedDatabase as never,
  );
  const narrowed = await resolveHostedBrowserDomainAuthority(
    { ...base, projectId: "project-b" },
    narrowedDatabase as never,
  );
  assert.deepEqual(
    first.publicDomains.map((entry) => entry.canonicalDomain),
    ["environment.example", "example.com"],
  );
  assert.deepEqual(
    narrowed.publicDomains.map((entry) => entry.canonicalDomain),
    ["environment.example"],
  );
  assert.equal(first.personalGrantsEnabled, true);
  assert.equal(narrowed.personalGrantsEnabled, true);
});

test("hosted grant decisions apply Environment ceiling before requesting approval", async () => {
  const database = fakeAuthorityDatabase({
    projectId: "project-a",
    environmentSettings: {
      enabledModes: ["operator"],
      personalGrantsEnabled: true,
      configuredPublicDomains: [publicDomain("environment.example")],
      blockedPublicDomains: [publicDomain("forbidden.example")],
    },
  });
  const base = {
    organizationId: "org-a",
    environmentId: "environment-a",
    projectId: "project-a",
    userId: "user-a",
    qa,
  };
  assert.equal(
    (
      await resolveHostedBrowserPublicGrantDecision(
        { ...base, destination: "https://a.example.com/private?q=secret" },
        database as never,
      )
    ).decision,
    "already_allowed",
  );
  assert.equal(
    (
      await resolveHostedBrowserPublicGrantDecision(
        { ...base, destination: "https://forbidden.example/path" },
        database as never,
      )
    ).decision,
    "blocked",
  );
  assert.equal(
    (
      await resolveHostedBrowserPublicGrantDecision(
        { ...base, destination: "https://new.example.net/path" },
        database as never,
      )
    ).decision,
    "approval_required",
  );
});

test("personal list projection is exact-user scoped and excludes durable provenance", async () => {
  let capturedWhere = false;
  const rows = await listHostedBrowserPersonalDomains(
    {
      organizationId: "org-a",
      environmentId: "environment-a",
      userId: "user-a",
    },
    {
      query: {
        browserPersonalDomains: {
          findMany: async (options: { where?: unknown }) => {
            capturedWhere = options.where !== undefined;
            return [
              {
                id: "secret-row-id",
                organizationId: "org-a",
                environmentId: "environment-a",
                userId: "user-a",
                canonicalDomain: "example.com",
                scheme: "https",
                includeSubdomains: true,
                port: 443,
                status: "active",
                personalRevision: 2,
                approvalId: "secret-approval",
                sourceInteractionId: "secret-interaction",
                sourcePreparedInvocationId: "secret-prepared",
                approvalAuthorityRevision: "secret-authority",
                approvedAt: new Date("2026-08-29T12:00:00.000Z"),
                revokedAt: null,
              },
            ];
          },
        },
      },
    } as never,
  );
  assert.equal(capturedWhere, true);
  assert.deepEqual(Object.keys(rows[0] ?? {}).sort(), [
    "approvedAt",
    "canonicalDomain",
    "includeSubdomains",
    "personalRevision",
    "port",
    "revokedAt",
    "scheme",
    "status",
  ]);
  assert.doesNotMatch(JSON.stringify(rows), /secret/u);
});

test("authority reads reject a Project outside the exact Environment scope", async () => {
  const database = fakeAuthorityDatabase({
    projectId: "project-a",
    projectFound: false,
  });
  await assert.rejects(
    readHostedBrowserDomainAuthorityInput(
      {
        organizationId: "org-a",
        environmentId: "environment-a",
        projectId: "project-from-another-environment",
        userId: "user-a",
        qa,
      },
      database as never,
    ),
    (error: unknown) =>
      error instanceof HostedBrowserDomainError &&
      error.code === "BROWSER_DOMAIN_SCOPE_NOT_FOUND",
  );
});

function fakeAuthorityDatabase(input: {
  projectId: string;
  projectFound?: boolean | undefined;
  projectApp?: { enabled: boolean; updatedAt: Date } | undefined;
  environmentSettings?: ReturnType<
    typeof parseHostedBrowserEnvironmentSettings
  >;
  projectSettings?: ReturnType<typeof parseHostedBrowserProjectSettings>;
}) {
  const environmentSettings =
    input.environmentSettings ??
    parseHostedBrowserEnvironmentSettings({
      enabledModes: ["operator"],
      personalGrantsEnabled: true,
      configuredPublicDomains: [publicDomain("environment.example")],
      blockedPublicDomains: [],
    });
  const projectSettings =
    input.projectSettings ??
    parseHostedBrowserProjectSettings({
      enabledModes: ["operator"],
      personalGrantsEnabled: true,
      blockedPublicDomains: [],
    });
  return {
    query: {
      environments: { findFirst: async () => ({ id: "environment-a" }) },
      projects: {
        findFirst: async () =>
          input.projectFound === false ? undefined : { id: input.projectId },
      },
      environmentAppCapabilityGrants: {
        findFirst: async () => ({
          enabled: true,
          approvalMode: "auto",
          settings: environmentSettings,
          updatedAt: new Date("2026-08-29T12:00:00.000Z"),
        }),
      },
      projectApps: {
        findFirst: async () =>
          Object.hasOwn(input, "projectApp")
            ? input.projectApp
            : {
                enabled: true,
                updatedAt: new Date("2026-08-29T12:00:00.000Z"),
              },
      },
      projectAppCapabilityPolicies: {
        findFirst: async () => ({
          enabled: true,
          approvalMode: "auto",
          settings: projectSettings,
          updatedAt: new Date("2026-08-29T12:00:00.000Z"),
        }),
      },
      browserPersonalDomainRevisionSets: {
        findFirst: async () => ({ revision: 7 }),
      },
      browserPersonalDomains: {
        findMany: async () => [
          {
            canonicalDomain: "example.com",
            scheme: "https",
            includeSubdomains: true,
            port: 443,
          },
        ],
      },
    },
  };
}
