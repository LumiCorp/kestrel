import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  HostedBrowserPersonalDomainAccessError,
  listPersonalBrowserDomainsForSignedInUser,
  noActiveHostedBrowserSessionsAllowlistAdoptionCoordinator,
  revokePersonalBrowserDomainForSignedInUser,
  type PersonalDomainAccessDependencies,
} from "./browser-personal-domain-access";

const appRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

const scope = {
  organizationId: "organization-a",
  environmentId: "environment-a",
  userId: "user-a",
};

const activeDomain = {
  canonicalDomain: "example.com",
  scheme: "https" as const,
  includeSubdomains: true as const,
  port: 443 as const,
  status: "active" as const,
  personalRevision: 2,
  approvedAt: new Date("2026-08-29T12:00:00.000Z"),
  revokedAt: null,
};

function dependencies(
  overrides: Partial<PersonalDomainAccessDependencies> = {},
): PersonalDomainAccessDependencies {
  return {
    findEnvironment: async (input) => ({
      id: input.environmentId,
      organizationId: input.organizationId,
    }) as never,
    listDomains: async () => [activeDomain],
    revokeDomain: async () => ({
      changed: true,
      personalRevision: 3,
      domain: {
        ...activeDomain,
        status: "revoked",
        personalRevision: 3,
        revokedAt: new Date("2026-08-29T13:00:00.000Z"),
      },
    }),
    adoptionCoordinator: {
      adoptPersonalDomainRevision: async (input) => ({
        personalRevision: input.personalRevision,
        adoptedSessions: [
          {
            sessionId: "session-a",
            effectiveRevision: "effective-3",
            closedUnauthorizedConnections: 0,
          },
        ],
      }),
    },
    ...overrides,
  };
}

test("personal domain access uses the authenticated organization, Environment, and user scope", async () => {
  const calls: unknown[] = [];
  const result = await listPersonalBrowserDomainsForSignedInUser(
    scope,
    dependencies({
      findEnvironment: async (input) => {
        calls.push(["environment", input]);
        return { id: input.environmentId } as never;
      },
      listDomains: async (input) => {
        calls.push(["domains", input]);
        return [activeDomain];
      },
    }),
  );
  assert.deepEqual(calls, [
    [
      "environment",
      {
        organizationId: scope.organizationId,
        environmentId: scope.environmentId,
      },
    ],
    ["domains", scope],
  ]);
  assert.deepEqual(result, [activeDomain]);
  assert.deepEqual(Object.keys(result[0] ?? {}).sort(), [
    "approvedAt",
    "canonicalDomain",
    "includeSubdomains",
    "personalRevision",
    "port",
    "revokedAt",
    "scheme",
    "status",
  ]);
});

test("personal domain access rejects an Environment outside the authenticated organization", async () => {
  let listed = false;
  await assert.rejects(
    listPersonalBrowserDomainsForSignedInUser(
      scope,
      dependencies({
        findEnvironment: async () => null,
        listDomains: async () => {
          listed = true;
          return [];
        },
      }),
    ),
    (error: unknown) =>
      error instanceof HostedBrowserPersonalDomainAccessError &&
      error.code === "BROWSER_PERSONAL_DOMAIN_SCOPE_NOT_FOUND",
  );
  assert.equal(listed, false);
});

test("revocation resolves only after active sessions confirm the exact personal revision", async () => {
  const operations: string[] = [];
  let adoptedScope: unknown;
  let releaseAdoption: (() => void) | undefined;
  let resolved = false;
  const revocation = revokePersonalBrowserDomainForSignedInUser(
    { ...scope, destination: "https://example.com" },
    dependencies({
      findEnvironment: async () => {
        operations.push("scope");
        return { id: scope.environmentId } as never;
      },
      revokeDomain: async () => {
        operations.push("revoke:3");
        return {
          changed: true,
          personalRevision: 3,
          domain: { ...activeDomain, status: "revoked", personalRevision: 3 },
        };
      },
      adoptionCoordinator: {
        adoptPersonalDomainRevision: async (input) => {
          adoptedScope = input;
          operations.push(`adopt:${input.personalRevision}`);
          await new Promise<void>((resolve) => {
            releaseAdoption = resolve;
          });
          return {
            personalRevision: input.personalRevision,
            adoptedSessions: [
              {
                sessionId: "session-a",
                effectiveRevision: "effective-a-3",
                closedUnauthorizedConnections: 1,
              },
              {
                sessionId: "session-b",
                effectiveRevision: "effective-b-3",
                closedUnauthorizedConnections: 0,
              },
            ],
          };
        },
      },
    }),
  ).then((result) => {
    resolved = true;
    return result;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(operations, ["scope", "revoke:3", "adopt:3"]);
  assert.deepEqual(adoptedScope, { ...scope, personalRevision: 3 });
  assert.equal(resolved, false);
  releaseAdoption?.();
  assert.equal((await revocation).personalRevision, 3);
  assert.equal(resolved, true);
});

test("revocation fails closed before mutation when adoption is unavailable", async () => {
  let revoked = false;
  await assert.rejects(
    revokePersonalBrowserDomainForSignedInUser(
      { ...scope, destination: "https://example.com" },
      dependencies({
        adoptionCoordinator: null,
        revokeDomain: async () => {
          revoked = true;
          throw new Error("must not run");
        },
      }),
    ),
    (error: unknown) =>
      error instanceof HostedBrowserPersonalDomainAccessError &&
      error.code === "BROWSER_ALLOWLIST_ADOPTION_UNAVAILABLE",
  );
  assert.equal(revoked, false);
});

test("the pre-session hosted coordinator truthfully confirms an empty active set", async () => {
  assert.deepEqual(
    await noActiveHostedBrowserSessionsAllowlistAdoptionCoordinator.adoptPersonalDomainRevision(
      { ...scope, personalRevision: 3 },
    ),
    { personalRevision: 3, adoptedSessions: [] },
  );
});

test("revocation never reports success when adoption fails or confirms another revision", async () => {
  await assert.rejects(
    revokePersonalBrowserDomainForSignedInUser(
      { ...scope, destination: "https://example.com" },
      dependencies({
        adoptionCoordinator: {
          adoptPersonalDomainRevision: async () => {
            throw new Error("worker unavailable");
          },
        },
      }),
    ),
    /worker unavailable/u,
  );
  await assert.rejects(
    revokePersonalBrowserDomainForSignedInUser(
      { ...scope, destination: "https://example.com" },
      dependencies({
        adoptionCoordinator: {
          adoptPersonalDomainRevision: async () => ({
            personalRevision: 2,
            adoptedSessions: [],
          }),
        },
      }),
    ),
    (error: unknown) =>
      error instanceof HostedBrowserPersonalDomainAccessError &&
      error.code === "BROWSER_ALLOWLIST_ADOPTION_UNCONFIRMED",
  );
});

test("revocation rejects malformed unauthorized-connection closure confirmations", async () => {
  for (const closedUnauthorizedConnections of [
    undefined as unknown as number,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    await assert.rejects(
      revokePersonalBrowserDomainForSignedInUser(
        { ...scope, destination: "https://example.com" },
        dependencies({
          adoptionCoordinator: {
            adoptPersonalDomainRevision: async () => ({
              personalRevision: 3,
              adoptedSessions: [
                {
                  sessionId: "session-a",
                  effectiveRevision: "effective-3",
                  closedUnauthorizedConnections,
                },
              ],
            }),
          },
        }),
      ),
      (error: unknown) =>
        error instanceof HostedBrowserPersonalDomainAccessError &&
        error.code === "BROWSER_ALLOWLIST_ADOPTION_UNCONFIRMED",
    );
  }
});

test("personal Browser routes and UI expose metadata only outside admin policy surfaces", () => {
  const read = (relativePath: string) =>
    fs.readFileSync(path.join(appRoot, relativePath), "utf8");
  const route = read("app/api/apps/browser/personal-domains/route.ts");
  const page = read("app/(workspace)/apps/[appKey]/page.tsx");
  const panel = read("components/apps/browser-personal-domains.tsx");
  const environmentAdmin = read("components/apps/environment-apps-panel.tsx");
  const projectAdmin = read("components/projects/project-apps.tsx");

  assert.match(route, /requireActiveOrganization\(request\)/u);
  assert.match(route, /organizationId,\s*environmentId: query\.environmentId,\s*userId: session\.user\.id/u);
  assert.match(route, /\.strict\(\)/u);
  assert.doesNotMatch(route, /input\.(?:userId|organizationId)/u);
  assert.match(page, /decodedAppKey === "built_in\.browser"/u);
  assert.match(page, /userId: session\.user\.id/u);
  for (const source of [route, panel]) {
    assert.doesNotMatch(
      source,
      /approvalId|sourceInteractionId|sourcePreparedInvocationId|approvalAuthorityRevision/u,
    );
  }
  for (const source of [environmentAdmin, projectAdmin]) {
    assert.doesNotMatch(
      source,
      /BrowserPersonalDomains|listPersonalBrowserDomainsForSignedInUser/u,
    );
  }
});
