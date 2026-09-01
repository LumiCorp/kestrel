import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalCoreDesktopBrowserAuthorityResolver } from "../../src/localCore/desktopBrowserAuthority.js";
import { projectDesktopBrowserPersonalDomainAuthority } from "../../src/desktopShell/browserPersonalDomains.js";

test("Local Core resolves current Desktop account, Environment, Project, and personal authority", async () => {
  const homePath = await mkdtemp(path.join(os.tmpdir(), "desktop-browser-authority-"));
  await mkdir(path.join(homePath, "settings"), { recursive: true });
  await writeFile(path.join(homePath, "settings", "local-core-settings.json"), JSON.stringify({
    browserPersonalDomains: {
      version: "desktop_browser_personal_domains_v1",
      partitions: [{
        version: "desktop_browser_personal_domain_partition_v1",
        accountId: "account-1",
        environmentId: "environment-1",
        revision: 4,
        domains: [domainRecord("personal-example.com", "approval-1")],
      }],
    },
  }));
  const resolver = new LocalCoreDesktopBrowserAuthorityResolver({
    homePath,
    account: { account: async () => signedInAccount() as any },
    environments: { snapshot: async () => environmentProjection() as any },
  });
  const authority = await resolver.resolve({
    runId: "run-1",
    threadId: "thread-1",
    projectId: "local-project",
    mode: "operator",
    destination: "https://personal-example.com",
  });
  assert.equal(authority.userId, "account-1");
  assert.equal(authority.environmentId, "environment-1");
  assert.equal(authority.projectId, "local-project");
  assert.deepEqual(
    authority.publicDomains.map((entry) => entry.canonicalDomain),
    ["configured-example.com", "personal-example.com"],
  );
  const adopted = await resolver.resolveForPersonalRevision({
    runId: "run-1",
    threadId: "thread-1",
    projectId: "local-project",
    mode: "operator",
    destination: "https://personal-example.com",
    accountId: "account-1",
    environmentId: "environment-1",
  });
  assert.equal(adopted.personalRevision, 4);
  assert.equal(adopted.authority.effectiveAllowlistRevision, authority.effectiveAllowlistRevision);
});

test("Local Core rejects a current account that no longer owns the trusted workspace mapping", async () => {
  const homePath = await mkdtemp(path.join(os.tmpdir(), "desktop-browser-authority-"));
  const account = signedInAccount() as any;
  account.projection.projects[0].desktopWorkspaceRef = "other-workspace";
  const resolver = new LocalCoreDesktopBrowserAuthorityResolver({
    homePath,
    account: { account: async () => account },
    environments: { snapshot: async () => environmentProjection() as any },
  });
  await assert.rejects(
    resolver.resolve({
      runId: "run-1",
      threadId: "thread-1",
      projectId: "local-project",
      mode: "operator",
    }),
    /policy is unavailable/u,
  );
});

test("Local Core never rewrites mismatched account Project or Organization identity", async () => {
  for (const mutate of [
    (account: any) => { account.projection.projects[0].id = "other-project"; },
    (account: any) => { account.projection.projects[0].organizationId = "other-organization"; },
  ]) {
    const homePath = await mkdtemp(path.join(os.tmpdir(), "desktop-browser-authority-"));
    const account = signedInAccount() as any;
    mutate(account);
    const resolver = new LocalCoreDesktopBrowserAuthorityResolver({
      homePath,
      account: { account: async () => account },
      environments: { snapshot: async () => environmentProjection() as any },
    });
    await assert.rejects(
      resolver.resolve({
        runId: "run-1",
        threadId: "thread-1",
        projectId: "local-project",
        mode: "operator",
      }),
      /policy is unavailable/u,
    );
  }
});

test("approved Browser execution persists only a still-required personal grant", async () => {
  const homePath = await mkdtemp(path.join(os.tmpdir(), "desktop-browser-authority-"));
  await mkdir(path.join(homePath, "settings"), { recursive: true });
  const settingsPath = path.join(homePath, "settings", "local-core-settings.json");
  await writeFile(settingsPath, JSON.stringify({
    browserPersonalDomains: {
      version: "desktop_browser_personal_domains_v1",
      partitions: [],
    },
  }));
  const account = signedInAccount() as any;
  const resolver = new LocalCoreDesktopBrowserAuthorityResolver({
    homePath,
    account: { account: async () => account },
    environments: { snapshot: async () => environmentProjection() as any },
  });
  const request = {
    runId: "run-1",
    threadId: "thread-1",
    projectId: "local-project",
    mode: "operator" as const,
    approvalId: "approval-current-1",
  };

  const configured = await resolver.rememberPersonalDomain({
    ...request,
    destination: "https://configured-example.com/private",
  });
  assert.deepEqual(
    configured.publicDomains.map((entry) => entry.canonicalDomain),
    ["configured-example.com"],
  );
  assert.deepEqual(
    JSON.parse(await readFile(settingsPath, "utf8")).browserPersonalDomains.partitions,
    [],
    "already-allowed policy must not create a personal record",
  );

  account.projection.projects[0].browserAuthority.project.blockedPublicDomains = [
    domain("blocked-example.com"),
  ];
  await assert.rejects(
    resolver.rememberPersonalDomain({
      ...request,
      destination: "https://blocked-example.com/",
    }),
    /blocked by current policy/u,
  );
  assert.deepEqual(
    JSON.parse(await readFile(settingsPath, "utf8")).browserPersonalDomains.partitions,
    [],
  );

  const granted = await resolver.rememberPersonalDomain({
    ...request,
    approvalId: "approval-current-2",
    destination: "https://personal-example.com/path?secret=discarded",
  });
  assert.deepEqual(
    granted.publicDomains.map((entry) => entry.canonicalDomain),
    ["configured-example.com", "personal-example.com"],
  );
  const persisted = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(persisted.browserPersonalDomains.partitions[0].revision, 1);
  assert.equal(
    persisted.browserPersonalDomains.partitions[0].domains[0].authority.canonicalDomain,
    "personal-example.com",
  );
  assert.equal(
    persisted.browserPersonalDomains.partitions[0].domains[0].provenance.approvalId,
    "approval-current-2",
  );
  assert.doesNotMatch(JSON.stringify(persisted), /secret=discarded/u);
});

test("shared Desktop personal authority rejects duplicate domains and impossible timestamp order", () => {
  const base: any = {
    version: "desktop_browser_personal_domains_v1",
    partitions: [{
      version: "desktop_browser_personal_domain_partition_v1",
      accountId: "account-1",
      environmentId: "environment-1",
      revision: 1,
      domains: [domainRecord("example.com", "approval-1")],
    }],
  };
  assert.throws(
    () => projectDesktopBrowserPersonalDomainAuthority({
      ...base,
      partitions: [{ ...base.partitions[0], domains: [base.partitions[0].domains[0], base.partitions[0].domains[0]] }],
    }, { accountId: "account-1", environmentId: "environment-1" }),
    /duplicate domains/u,
  );
  assert.throws(
    () => projectDesktopBrowserPersonalDomainAuthority({
      ...base,
      partitions: [{
        ...base.partitions[0],
        domains: [{
          ...base.partitions[0].domains[0],
          createdAt: "2026-08-30T12:00:00.000Z",
        }],
      }],
    }, { accountId: "account-1", environmentId: "environment-1" }),
    /timestamps are out of order/u,
  );
});

function signedInAccount() {
  return {
    status: "signed_in",
    baseUrl: "https://kestrel.test",
    projection: {
      account: { id: "account-1", name: "Person", email: "person@example.com" },
      organizations: [{ organizationId: "organization-1", organizationName: "Org", organizationSlug: "org", organizationRole: "member" }],
      projects: [{
        id: "local-project",
        organizationId: "organization-1",
        name: "Project",
        environmentId: "environment-1",
        environmentProvider: "desktop",
        desktopWorkspaceRef: "workspace-ref-1",
        role: "owner",
        browserAuthority: {
          environment: {
            version: "browser_environment_domain_authority_v1",
            environmentId: "environment-1",
            revision: "environment-revision-1",
            enabledModes: ["operator"],
            personalGrantsEnabled: true,
            configuredPublicDomains: [domain("configured-example.com")],
            blockedPublicDomains: [],
          },
          project: {
            version: "browser_project_domain_authority_v1",
            projectId: "local-project",
            revision: "project-revision-1",
            enabledModes: ["operator"],
            personalGrantsEnabled: true,
            blockedPublicDomains: [],
          },
        },
      }],
      threads: [],
    },
  };
}

function environmentProjection() {
  return {
    enrollments: [],
    environments: [{
      connectionId: "connection-1",
      environmentId: "environment-1",
      organizationId: "organization-1",
      baseUrl: "https://kestrel.test",
      desktopName: "Desktop",
      status: "active",
      connectionStatus: "online",
      capacity: 1,
      activeRuns: 0,
      models: [],
      workspaces: [{ projectId: "local-project", workspaceRef: "workspace-ref-1", label: "Project", available: true }],
    }],
    globalCapacity: 1,
    activeRuns: 0,
    activity: [],
  };
}

function domain(canonicalDomain: string) {
  return { version: "browser_public_domain_authority_v1", scheme: "https", canonicalDomain, includeSubdomains: true, port: 443 };
}

function domainRecord(canonicalDomain: string, approvalId: string) {
  return {
    version: "desktop_browser_personal_domain_record_v1",
    authority: domain(canonicalDomain),
    state: "active",
    provenance: {
      version: "desktop_browser_personal_domain_provenance_v1",
      source: "browser.request_grant",
      approvalId,
      approvedAt: "2026-08-29T12:00:00.000Z",
    },
    createdAt: "2026-08-29T12:00:00.000Z",
    updatedAt: "2026-08-29T12:00:00.000Z",
  };
}
