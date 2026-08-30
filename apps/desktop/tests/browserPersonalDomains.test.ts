import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  createDefaultDesktopSettings,
  projectDesktopBrowserPersonalDomains,
  readDesktopSettings,
  rememberDesktopBrowserPersonalDomain,
  revokeDesktopBrowserPersonalDomain,
  writeDesktopSettings,
} from "../src/settingsStore.js";
import { DesktopBrowserPersonalDomainService } from "../src/browserPersonalDomainService.js";
import {
  parseDesktopBrowserPersonalDomainListRequest,
  parseDesktopBrowserPersonalDomainRevokeRequest,
} from "../../../src/desktopShell/contracts.js";
import type { KestrelOneAccountStatus } from "../../../src/localCore/kestrelOneAccount.js";

const ACCOUNT_A = "kestrel-account-a";
const ACCOUNT_B = "kestrel-account-b";
const ENVIRONMENT_A = "environment-a";
const ENVIRONMENT_B = "environment-b";

test("Desktop schema 13 migrates older settings to empty partitioned Browser authority", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kestrel-browser-settings-"));
  const settingsPath = path.join(directory, "settings.json");
  await writeFile(
    settingsPath,
    `${JSON.stringify({ version: 12, selectedProvider: "ollama" })}\n`,
    "utf8",
  );

  const migrated = await readDesktopSettings(settingsPath);
  assert.deepEqual(migrated.browserPersonalDomains, {
    version: "desktop_browser_personal_domains_v1",
    partitions: [],
  });

  await writeDesktopSettings(settingsPath, migrated);
  const persisted = JSON.parse(await readFile(settingsPath, "utf8")) as {
    version: number;
    browserPersonalDomains: unknown;
  };
  assert.equal(persisted.version, 13);
  assert.deepEqual(persisted.browserPersonalDomains, migrated.browserPersonalDomains);
});

test("Desktop schema 13 rejects malformed or noncanonical Browser partitions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kestrel-browser-settings-"));
  const settingsPath = path.join(directory, "settings.json");
  await writeFile(
    settingsPath,
    `${JSON.stringify({
      version: 13,
      selectedProvider: "ollama",
      browserPersonalDomains: {
        version: "desktop_browser_personal_domains_v1",
        partitions: [{
          version: "desktop_browser_personal_domain_partition_v1",
          accountId: ACCOUNT_A,
          environmentId: ENVIRONMENT_A,
          revision: 1,
          domains: [{
            version: "desktop_browser_personal_domain_record_v1",
            authority: {
              version: "browser_public_domain_authority_v1",
              scheme: "https",
              canonicalDomain: "WWW.Example.com",
              includeSubdomains: true,
              port: 443,
            },
            state: "active",
            provenance: {
              version: "desktop_browser_personal_domain_provenance_v1",
              source: "browser.request_grant",
              approvalId: "approval-1",
              approvedAt: "2026-08-29T12:00:00.000Z",
            },
            createdAt: "2026-08-29T12:00:00.000Z",
            updatedAt: "2026-08-29T12:00:00.000Z",
          }],
        }],
      },
    })}\n`,
    "utf8",
  );

  const restored = await readDesktopSettings(settingsPath);
  assert.equal(restored.selectedProvider, "openrouter");
  assert.deepEqual(restored.browserPersonalDomains.partitions, []);
});

test("Desktop remembers a canonical domain idempotently in the exact account and Environment partition", () => {
  const initial = createDefaultDesktopSettings();
  const created = rememberDesktopBrowserPersonalDomain(initial, {
    accountId: ACCOUNT_A,
    environmentId: ENVIRONMENT_A,
    destination: "https://docs.Example.com./private?secret=value#fragment",
    approvalId: "approval-a-1",
    approvedAt: "2026-08-29T12:00:00.000Z",
  });
  assert.equal(created.disposition, "created");
  assert.equal(created.projection.revision, 1);
  assert.equal(created.projection.authority.revision, "1");
  assert.deepEqual(created.projection.authority.activeDomains, [{
    version: "browser_public_domain_authority_v1",
    scheme: "https",
    canonicalDomain: "example.com",
    includeSubdomains: true,
    port: 443,
  }]);
  assert.equal(created.projection.domains[0]?.provenance.approvalId, "approval-a-1");

  const retried = rememberDesktopBrowserPersonalDomain(created.settings, {
    accountId: ACCOUNT_A,
    environmentId: ENVIRONMENT_A,
    destination: "https://example.com/other",
    approvalId: "approval-retry",
    approvedAt: "2026-08-29T12:01:00.000Z",
  });
  assert.equal(retried.disposition, "unchanged");
  assert.equal(retried.settings, created.settings);
  assert.equal(retried.projection.revision, 1);
  assert.equal(retried.projection.domains[0]?.provenance.approvalId, "approval-a-1");
});

test("Desktop Browser reads and writes never cross account or Environment partitions", () => {
  const first = rememberDesktopBrowserPersonalDomain(createDefaultDesktopSettings(), {
    accountId: ACCOUNT_A,
    environmentId: ENVIRONMENT_A,
    destination: "https://alpha.example.com",
    approvalId: "approval-a",
    approvedAt: "2026-08-29T12:00:00.000Z",
  });
  const second = rememberDesktopBrowserPersonalDomain(first.settings, {
    accountId: ACCOUNT_B,
    environmentId: ENVIRONMENT_A,
    destination: "https://tenant.vercel.app",
    approvalId: "approval-b",
    approvedAt: "2026-08-29T12:01:00.000Z",
  });
  const third = rememberDesktopBrowserPersonalDomain(second.settings, {
    accountId: ACCOUNT_A,
    environmentId: ENVIRONMENT_B,
    destination: "https://other.example.org",
    approvalId: "approval-c",
    approvedAt: "2026-08-29T12:02:00.000Z",
  });

  const accountAEnvironmentA = projectDesktopBrowserPersonalDomains(third.settings, {
    accountId: ACCOUNT_A,
    environmentId: ENVIRONMENT_A,
  });
  assert.deepEqual(
    accountAEnvironmentA.domains.map((record) => record.authority.canonicalDomain),
    ["example.com"],
  );
  assert.equal(JSON.stringify(accountAEnvironmentA).includes("vercel.app"), false);
  assert.equal(JSON.stringify(accountAEnvironmentA).includes("example.org"), false);

  const signedOutOrSwitchedAccount = projectDesktopBrowserPersonalDomains(third.settings, {
    accountId: ACCOUNT_B,
    environmentId: ENVIRONMENT_B,
  });
  assert.equal(signedOutOrSwitchedAccount.revision, 0);
  assert.deepEqual(signedOutOrSwitchedAccount.authority.activeDomains, []);
  assert.throws(
    () => projectDesktopBrowserPersonalDomains(third.settings, {
      accountId: ACCOUNT_A,
      environmentId: " environment-a",
    }),
    /environmentId must be a non-empty canonical string/u,
  );
});

test("Desktop revoke and reactivation advance only the affected personal revision", () => {
  const created = rememberDesktopBrowserPersonalDomain(createDefaultDesktopSettings(), {
    accountId: ACCOUNT_A,
    environmentId: ENVIRONMENT_A,
    destination: "https://example.com",
    approvalId: "approval-1",
    approvedAt: "2026-08-29T12:00:00.000Z",
  });
  const revoked = revokeDesktopBrowserPersonalDomain(created.settings, {
    accountId: ACCOUNT_A,
    environmentId: ENVIRONMENT_A,
    canonicalDomain: "example.com",
    revokedAt: "2026-08-29T12:01:00.000Z",
  });
  assert.equal(revoked.disposition, "revoked");
  assert.equal(revoked.projection.revision, 2);
  assert.deepEqual(revoked.projection.authority.activeDomains, []);
  assert.equal(revoked.projection.domains[0]?.state, "revoked");

  const duplicateRevoke = revokeDesktopBrowserPersonalDomain(revoked.settings, {
    accountId: ACCOUNT_A,
    environmentId: ENVIRONMENT_A,
    canonicalDomain: "example.com",
    revokedAt: "2026-08-29T12:02:00.000Z",
  });
  assert.equal(duplicateRevoke.disposition, "unchanged");
  assert.equal(duplicateRevoke.projection.revision, 2);

  const reactivated = rememberDesktopBrowserPersonalDomain(revoked.settings, {
    accountId: ACCOUNT_A,
    environmentId: ENVIRONMENT_A,
    destination: "https://www.example.com/new",
    approvalId: "approval-2",
    approvedAt: "2026-08-29T12:03:00.000Z",
  });
  assert.equal(reactivated.disposition, "reactivated");
  assert.equal(reactivated.projection.revision, 3);
  assert.equal(reactivated.projection.domains[0]?.state, "active");
  assert.equal(reactivated.projection.domains[0]?.revokedAt, undefined);
  assert.equal(reactivated.projection.domains[0]?.createdAt, "2026-08-29T12:00:00.000Z");
  assert.equal(reactivated.projection.domains[0]?.provenance.approvalId, "approval-2");
});

test("Desktop persists all partitions internally but projects only an authorized exact partition", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kestrel-browser-settings-"));
  const settingsPath = path.join(directory, "settings.json");
  const accountA = rememberDesktopBrowserPersonalDomain(createDefaultDesktopSettings(), {
    accountId: ACCOUNT_A,
    environmentId: ENVIRONMENT_A,
    destination: "https://example.com",
    approvalId: "approval-a",
    approvedAt: "2026-08-29T12:00:00.000Z",
  });
  const accountB = rememberDesktopBrowserPersonalDomain(accountA.settings, {
    accountId: ACCOUNT_B,
    environmentId: ENVIRONMENT_A,
    destination: "https://example.org",
    approvalId: "approval-b",
    approvedAt: "2026-08-29T12:01:00.000Z",
  });
  await writeDesktopSettings(settingsPath, accountB.settings);
  const restored = await readDesktopSettings(settingsPath);

  assert.equal(restored.browserPersonalDomains.partitions.length, 2);
  const projected = projectDesktopBrowserPersonalDomains(restored, {
    accountId: ACCOUNT_A,
    environmentId: ENVIRONMENT_A,
  });
  assert.deepEqual(
    projected.domains.map((record) => record.authority.canonicalDomain),
    ["example.com"],
  );
  assert.equal(JSON.stringify(projected).includes("example.org"), false);
});

test("Desktop Browser IPC requests cannot supply an account identity", () => {
  assert.throws(
    () => parseDesktopBrowserPersonalDomainListRequest({
      accountId: ACCOUNT_B,
      environmentId: ENVIRONMENT_A,
    }),
    /unsupported field 'accountId'/u,
  );
  assert.throws(
    () => parseDesktopBrowserPersonalDomainRevokeRequest({
      accountId: ACCOUNT_B,
      environmentId: ENVIRONMENT_A,
      canonicalDomain: "example.com",
    }),
    /unsupported field 'accountId'/u,
  );
});

test("Desktop Browser service denies signed-out reads and mutations", async () => {
  let settings = createDefaultDesktopSettings();
  let persisted = 0;
  const service = new DesktopBrowserPersonalDomainService({
    resolveAccount: async () => ({ status: "signed_out" }),
    readSettings: () => settings,
    persistSettings: async (next) => {
      persisted += 1;
      settings = next;
    },
    adoptionCoordinator: noActiveDesktopBrowserSessions(),
  });

  await assert.rejects(
    service.list(ENVIRONMENT_A),
    /Kestrel One sign-in is required/u,
  );
  await assert.rejects(
    service.remember({
      environmentId: ENVIRONMENT_A,
      destination: "https://example.com",
      approvalId: "approval-signed-out",
      approvedAt: "2026-08-29T12:00:00.000Z",
    }),
    /Kestrel One sign-in is required/u,
  );
  await assert.rejects(
    service.revoke({
      environmentId: ENVIRONMENT_A,
      canonicalDomain: "example.com",
    }),
    /Kestrel One sign-in is required/u,
  );
  assert.equal(persisted, 0);
  assert.deepEqual(settings.browserPersonalDomains.partitions, []);
});

test("Desktop Browser service re-resolves account and Environment authority on every operation", async () => {
  let settings = createDefaultDesktopSettings();
  let account: KestrelOneAccountStatus = signedInAccount(ACCOUNT_A, [
    ENVIRONMENT_A,
    ENVIRONMENT_B,
  ]);
  const service = new DesktopBrowserPersonalDomainService({
    resolveAccount: async () => account,
    readSettings: () => settings,
    persistSettings: async (next) => {
      settings = next;
    },
    adoptionCoordinator: noActiveDesktopBrowserSessions(),
  });

  await service.remember({
    environmentId: ENVIRONMENT_A,
    destination: "https://example.com",
    approvalId: "approval-account-a",
    approvedAt: "2026-08-29T12:00:00.000Z",
  });
  account = signedInAccount(ACCOUNT_B, [ENVIRONMENT_A, ENVIRONMENT_B]);
  assert.deepEqual((await service.list(ENVIRONMENT_A)).domains, []);
  assert.deepEqual(
    (await service.revoke({
      environmentId: ENVIRONMENT_A,
      canonicalDomain: "example.com",
    })).domains,
    [],
  );

  account = signedInAccount(ACCOUNT_A, [ENVIRONMENT_A, ENVIRONMENT_B]);
  assert.equal((await service.list(ENVIRONMENT_A)).domains[0]?.state, "active");
  assert.deepEqual((await service.list(ENVIRONMENT_B)).domains, []);
  await service.revoke({
    environmentId: ENVIRONMENT_B,
    canonicalDomain: "example.com",
  });
  assert.equal((await service.list(ENVIRONMENT_A)).domains[0]?.state, "active");

  account = signedInAccount(ACCOUNT_A, [ENVIRONMENT_B]);
  await assert.rejects(
    service.list(ENVIRONMENT_A),
    /not available to the signed-in account/u,
  );
});

test("Desktop Browser service aborts a mutation when the account switches before persistence", async () => {
  let settings = createDefaultDesktopSettings();
  let resolutions = 0;
  let persisted = 0;
  const service = new DesktopBrowserPersonalDomainService({
    resolveAccount: async () => {
      resolutions += 1;
      return signedInAccount(
        resolutions === 1 ? ACCOUNT_A : ACCOUNT_B,
        [ENVIRONMENT_A],
      );
    },
    readSettings: () => settings,
    persistSettings: async (next) => {
      persisted += 1;
      settings = next;
    },
    adoptionCoordinator: noActiveDesktopBrowserSessions(),
  });

  await assert.rejects(
    service.remember({
      environmentId: ENVIRONMENT_A,
      destination: "https://example.com",
      approvalId: "approval-switch",
      approvedAt: "2026-08-29T12:00:00.000Z",
    }),
    /account changed before Browser settings were saved/u,
  );
  assert.equal(persisted, 0);
  assert.deepEqual(settings.browserPersonalDomains.partitions, []);
});

test("Desktop Browser service persists before adoption and waits for exact revision confirmation", async () => {
  let settings = createDefaultDesktopSettings();
  const operations: string[] = [];
  let releaseAdoption: (() => void) | undefined;
  let resolved = false;
  const service = new DesktopBrowserPersonalDomainService({
    resolveAccount: async () => signedInAccount(ACCOUNT_A, [ENVIRONMENT_A]),
    readSettings: () => settings,
    persistSettings: async (next) => {
      operations.push("persist:1");
      settings = next;
    },
    adoptionCoordinator: {
      async adoptPersonalRevision(input) {
        operations.push(`adopt:${input.personalRevision}`);
        await new Promise<void>((resolve) => {
          releaseAdoption = resolve;
        });
        return {
          personalRevision: input.personalRevision,
          closedUnauthorizedConnections: 0,
        };
      },
    },
  });

  const remembering = service.remember({
    environmentId: ENVIRONMENT_A,
    destination: "https://example.com",
    approvalId: "approval-ordered",
    approvedAt: "2026-08-29T12:00:00.000Z",
  }).then((result) => {
    resolved = true;
    return result;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(operations, ["persist:1", "adopt:1"]);
  assert.equal(resolved, false);
  releaseAdoption?.();
  assert.equal((await remembering).revision, 1);
  assert.equal(resolved, true);
});

test("Desktop Browser remember and revoke fail closed on adoption failure and retry an unchanged revision", async () => {
  let settings = createDefaultDesktopSettings();
  let failAdoption = true;
  const adoptedRevisions: number[] = [];
  const service = new DesktopBrowserPersonalDomainService({
    resolveAccount: async () => signedInAccount(ACCOUNT_A, [ENVIRONMENT_A]),
    readSettings: () => settings,
    persistSettings: async (next) => {
      settings = next;
    },
    adoptionCoordinator: {
      async adoptPersonalRevision(input) {
        adoptedRevisions.push(input.personalRevision);
        if (failAdoption) throw new Error("desktop Browser host unavailable");
        return {
          personalRevision: input.personalRevision,
          closedUnauthorizedConnections: 0,
        };
      },
    },
  });
  const request = {
    environmentId: ENVIRONMENT_A,
    destination: "https://example.com",
    approvalId: "approval-retry",
    approvedAt: "2026-08-29T12:00:00.000Z",
  };

  await assert.rejects(service.remember(request), /host unavailable/u);
  assert.equal(
    projectDesktopBrowserPersonalDomains(settings, {
      accountId: ACCOUNT_A,
      environmentId: ENVIRONMENT_A,
    }).revision,
    1,
  );
  failAdoption = false;
  assert.equal((await service.remember(request)).revision, 1);
  failAdoption = true;
  const revocation = {
    environmentId: ENVIRONMENT_A,
    canonicalDomain: "example.com",
    revokedAt: "2026-08-29T12:01:00.000Z",
  };
  await assert.rejects(service.revoke(revocation), /host unavailable/u);
  assert.equal(
    projectDesktopBrowserPersonalDomains(settings, {
      accountId: ACCOUNT_A,
      environmentId: ENVIRONMENT_A,
    }).revision,
    2,
  );
  failAdoption = false;
  assert.equal((await service.revoke(revocation)).revision, 2);
  assert.deepEqual(adoptedRevisions, [1, 1, 2, 2]);
});

test("Desktop Browser service rejects mismatched or malformed revision confirmations", async () => {
  for (const confirmation of [
    { personalRevision: 0, closedUnauthorizedConnections: 0 },
    {
      personalRevision: 1,
      closedUnauthorizedConnections: undefined as unknown as number,
    },
    { personalRevision: 1, closedUnauthorizedConnections: -1 },
    { personalRevision: 1, closedUnauthorizedConnections: 0.5 },
    {
      personalRevision: 1,
      closedUnauthorizedConnections: Number.MAX_SAFE_INTEGER + 1,
    },
  ]) {
    let settings = createDefaultDesktopSettings();
    const service = new DesktopBrowserPersonalDomainService({
      resolveAccount: async () => signedInAccount(ACCOUNT_A, [ENVIRONMENT_A]),
      readSettings: () => settings,
      persistSettings: async (next) => {
        settings = next;
      },
      adoptionCoordinator: {
        async adoptPersonalRevision() {
          return confirmation;
        },
      },
    });
    await assert.rejects(
      service.remember({
        environmentId: ENVIRONMENT_A,
        destination: "https://example.com",
        approvalId: "approval-invalid-confirmation",
        approvedAt: "2026-08-29T12:00:00.000Z",
      }),
      /did not confirm the exact personal-domain revision/u,
    );
  }
});

test("Desktop Browser service serializes sign-out ahead of later reads", async () => {
  let account: KestrelOneAccountStatus = signedInAccount(ACCOUNT_A, [ENVIRONMENT_A]);
  const service = new DesktopBrowserPersonalDomainService({
    resolveAccount: async () => account,
    readSettings: () => createDefaultDesktopSettings(),
    persistSettings: async () => undefined,
    adoptionCoordinator: noActiveDesktopBrowserSessions(),
  });
  const signedOut = service.signOut(async () => {
    account = { status: "signed_out" };
    return account;
  });
  const laterRead = service.list(ENVIRONMENT_A);

  assert.deepEqual(await signedOut, { status: "signed_out" });
  await assert.rejects(laterRead, /Kestrel One sign-in is required/u);
});

function signedInAccount(
  accountId: string,
  environmentIds: readonly string[],
): KestrelOneAccountStatus {
  return {
    status: "signed_in",
    baseUrl: "https://kestrel.example",
    projection: {
      account: {
        id: accountId,
        name: accountId,
        email: `${accountId}@example.com`,
      },
      organizations: [],
      projects: environmentIds.map((environmentId, index) => ({
        id: `project-${index}`,
        organizationId: "organization-1",
        name: `Project ${index + 1}`,
        environmentId,
        environmentProvider: "desktop",
        role: "owner",
      })),
      threads: [],
    },
  };
}

function noActiveDesktopBrowserSessions() {
  return {
    async adoptPersonalRevision(input: {
      accountId: string;
      environmentId: string;
      personalRevision: number;
    }) {
      return {
        personalRevision: input.personalRevision,
        closedUnauthorizedConnections: 0,
      };
    },
  };
}
