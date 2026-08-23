import test from "node:test";
import assert from "node:assert/strict";

import type { TuiProfile } from "../../cli/contracts.js";
import {
  applyRequiredManagedWorkspacePolicy,
  createModelGatewayForProfile,
  createRuntimeFactoryWithStore,
  resolveManagedWorktreesEnabledForRuntime,
  resolveSandboxCapabilityAudienceFromEnvironment,
  resolveSandboxCapabilityBrokerAuthorityFromEnvironment,
  resolveSandboxCapabilityRuntimeEnvironment,
} from "../../cli/runtime/KestrelChatRuntime.js";
import type { ModelGateway } from "../../src/kestrel/contracts/model-io.js";
import { KESTREL_EXECUTION_BOUNDARY_POLICY } from "../../src/security/ExecutionBoundaryPolicy.js";
import { InMemorySessionStore } from "../../src/store/InMemorySessionStore.js";


const BASE_PROFILE: TuiProfile = {
  id: "reference",
  label: "Reference",
  agent: "reference-react",
  sessionPrefix: "reference",
};

const CAPABILITY_PROFILE: TuiProfile = {
  ...BASE_PROFILE,
  codeMode: {
    enabled: true,
    languages: ["javascript"],
    sandbox: {
      executor: "docker",
      timeoutMs: 1_000,
      memoryMb: 128,
      cpuShares: 256,
      pidsLimit: 64,
      maxOutputBytes: 16_000,
      maxArtifacts: 8,
      maxArtifactBytes: 1_000_000,
      workspaceSizeMb: 64,
      workspaceInodes: 4_096,
      tmpSizeMb: 32,
      tmpInodes: 2_048,
      networkDefault: "off",
      allowDependencyInstall: false,
    },
    retention: { persistSummary: true, persistArtifacts: true },
    approvalMode: "auto",
    capabilities: [{
      version: 1,
      capabilityId: "tavily.search.read",
      operations: ["search"],
      resource: "https://api.tavily.com/search",
      audience: { tenantId: "tenant-a", environmentId: "environment-a" },
      maxRequests: 1,
      maxQueryChars: 100,
      maxResults: 3,
      maxResponseBytes: 4_096,
      timeoutMs: 1_000,
      maxExpiryMs: 5_000,
      brokerAuthority: { authorityId: "broker-a", revision: "revision-a" },
    }],
  },
};

function resolveCapabilityRuntime(
  profile: TuiProfile,
  trustedAudience: { tenantId: string; environmentId: string } | undefined,
  trustedBrokerAuthority: { authorityId: string; revision: string } | undefined,
) {
  let credentialResolutions = 0;
  const resolved = resolveSandboxCapabilityRuntimeEnvironment(
    profile,
    trustedAudience,
    trustedBrokerAuthority,
    "a".repeat(64),
    "b".repeat(64),
    async () => {
      credentialResolutions += 1;
      return { credentialId: "tool.tavily.default", revision: "credential-a", secret: "secret-a" };
    },
    () => undefined,
    (value) => value,
  );
  return { resolved, credentialResolutions };
}

test("sandbox capability runtime binds the authored audience to independent runtime identity", () => {
  const { resolved } = resolveCapabilityRuntime(CAPABILITY_PROFILE, {
    tenantId: "tenant-a",
    environmentId: "environment-a",
  }, { authorityId: "broker-a", revision: "revision-a" });
  assert.ok(resolved?.sandboxCapabilityRuntime);
  assert.deepEqual(
    {
      tenantId: resolved?.sandboxCapabilityRuntime.tenantId,
      environmentId: resolved?.sandboxCapabilityRuntime.environmentId,
      boundaryRevision: resolved?.sandboxCapabilityRuntime.executionBoundaryRevision,
    },
    {
      tenantId: "tenant-a",
      environmentId: "environment-a",
      boundaryRevision: KESTREL_EXECUTION_BOUNDARY_POLICY.revision,
    },
  );
});

test("sandbox capability runtime rejects forged tenant and environment audiences before credential resolution", () => {
  for (const trustedAudience of [
    { tenantId: "tenant-b", environmentId: "environment-a" },
    { tenantId: "tenant-a", environmentId: "environment-b" },
  ]) {
    let credentialResolutions = 0;
    assert.throws(
      () => resolveSandboxCapabilityRuntimeEnvironment(
        CAPABILITY_PROFILE,
        trustedAudience,
        { authorityId: "broker-a", revision: "revision-a" },
        "a".repeat(64),
        "b".repeat(64),
        async () => {
          credentialResolutions += 1;
          return { credentialId: "tool.tavily.default", revision: "credential-a", secret: "secret-a" };
        },
        () => undefined,
        (value) => value,
      ),
      /audience does not match/u,
    );
    assert.equal(credentialResolutions, 0);
  }
});

test("sandbox capability runtime fails closed without an independent runtime identity", () => {
  assert.throws(
    () => resolveCapabilityRuntime(
      CAPABILITY_PROFILE,
      undefined,
      { authorityId: "broker-a", revision: "revision-a" },
    ),
    /trusted tenant and environment identity is unavailable/u,
  );
});

test("sandbox capability runtime rejects forged broker authority before credential resolution", () => {
  for (const trustedBrokerAuthority of [
    { authorityId: "broker-b", revision: "revision-a" },
    { authorityId: "broker-a", revision: "revision-b" },
  ]) {
    const result = () => resolveCapabilityRuntime(
      CAPABILITY_PROFILE,
      { tenantId: "tenant-a", environmentId: "environment-a" },
      trustedBrokerAuthority,
    );
    assert.throws(result, /broker authority does not match/u);
  }
});

test("sandbox capability runtime fails closed without independent broker authority", () => {
  assert.throws(
    () => resolveCapabilityRuntime(
      CAPABILITY_PROFILE,
      { tenantId: "tenant-a", environmentId: "environment-a" },
      undefined,
    ),
    /trusted broker authority is unavailable/u,
  );
});

test("local capability authority is assembled only from host runtime variables", () => {
  const env = {
    KESTREL_TENANT_ID: "tenant-a",
    KESTREL_ENVIRONMENT_ID: "environment-a",
    KESTREL_SANDBOX_BROKER_AUTHORITY_ID: "broker-a",
    KESTREL_SANDBOX_BROKER_AUTHORITY_REVISION: "revision-a",
  };
  assert.deepEqual(resolveSandboxCapabilityAudienceFromEnvironment(env), CAPABILITY_PROFILE.codeMode?.capabilities?.[0]?.audience);
  assert.deepEqual(resolveSandboxCapabilityBrokerAuthorityFromEnvironment(env), CAPABILITY_PROFILE.codeMode?.capabilities?.[0]?.brokerAuthority);
  assert.equal(resolveSandboxCapabilityAudienceFromEnvironment({ KESTREL_TENANT_ID: "tenant-a" }), undefined);
  assert.equal(resolveSandboxCapabilityBrokerAuthorityFromEnvironment({ KESTREL_SANDBOX_BROKER_AUTHORITY_ID: "broker-a" }), undefined);
});

test("gateway profile credential identity cannot replace host-resolved capability authority", () => {
  let credentialResolutions = 0;
  const gatewayProfile: TuiProfile = {
    ...CAPABILITY_PROFILE,
    modelCredential: {
      source: "kestrel-one",
      runId: "run-a",
      gatewayId: "gateway-a",
      organizationId: "tenant-a",
      environmentId: "environment-a",
      rawModelId: "openai/gpt-5.4",
      provider: "openai",
    },
  };
  assert.throws(
    () => resolveSandboxCapabilityRuntimeEnvironment(
      gatewayProfile,
      { tenantId: "tenant-a", environmentId: "host-environment" },
      { authorityId: "broker-a", revision: "revision-a" },
      "a".repeat(64),
      "b".repeat(64),
      async () => {
        credentialResolutions += 1;
        return { credentialId: "tool.tavily.default", revision: "credential-a", secret: "secret-a" };
      },
      () => undefined,
      (value) => value,
    ),
    /audience does not match/u,
  );
  assert.equal(credentialResolutions, 0);
});

test("resolveManagedWorktreesEnabledForRuntime defaults off and honors explicit opt-in", () => {
  assert.equal(resolveManagedWorktreesEnabledForRuntime({}), false);
  assert.equal(resolveManagedWorktreesEnabledForRuntime({ KESTREL_ENABLE_MANAGED_WORKTREES: "true" }), true);
  assert.equal(resolveManagedWorktreesEnabledForRuntime({ KESTREL_ENABLE_MANAGED_WORKTREES: "false" }), false);
});

test("runtime factory preserves managed-worktree host capability paths", async () => {
  const store = new InMemorySessionStore();
  const emptyEnvironment = {
    runtimeEnv: {},
    modelEnv: {},
    internetEnv: {},
    mcpEnv: {},
  };
  const createBootstrap = (
    profile: TuiProfile,
    options: Parameters<typeof createRuntimeFactoryWithStore>[1] = {},
  ) =>
    createRuntimeFactoryWithStore(store, {
      resolveEnvironment: () => emptyEnvironment,
      ...options,
    }).create(profile, (payload) => payload);

  const defaultBootstrap = createBootstrap(BASE_PROFILE);
  const disabledBootstrap = createBootstrap(BASE_PROFILE, {
    enableManagedWorktrees: false,
  });
  const enabledBootstrap = createBootstrap(BASE_PROFILE, {
    enableManagedWorktrees: true,
  });
  const desktopBootstrap = createBootstrap({
    ...BASE_PROFILE,
    shellKind: "desktop",
  });
  const environmentBootstrap = createBootstrap(BASE_PROFILE, {
    resolveEnvironment: () => ({
      ...emptyEnvironment,
      runtimeEnv: { KESTREL_ENABLE_MANAGED_WORKTREES: "true" },
    }),
  });

  try {
    assert.equal(defaultBootstrap.kestrel.getManagedTaskWorktreeService(), undefined);
    assert.equal(disabledBootstrap.kestrel.getManagedTaskWorktreeService(), undefined);
    assert.notEqual(enabledBootstrap.kestrel.getManagedTaskWorktreeService(), undefined);
    assert.notEqual(desktopBootstrap.kestrel.getManagedTaskWorktreeService(), undefined);
    assert.notEqual(environmentBootstrap.kestrel.getManagedTaskWorktreeService(), undefined);
  } finally {
    await Promise.all([
      defaultBootstrap.close(),
      disabledBootstrap.close(),
      enabledBootstrap.close(),
      desktopBootstrap.close(),
      environmentBootstrap.close(),
    ]);
  }
});

test("required managed Workspace policy injects the Environment-owned canonical root", () => {
  assert.deepEqual(
    applyRequiredManagedWorkspacePolicy(undefined, {
      KESTREL_REQUIRE_MANAGED_WORKTREE: "true",
      KESTREL_WORKSPACE_ID: "workspace-1",
      KESTREL_WORKSPACE_ROOT: "/workspace",
      KESTREL_MANAGED_WORKTREE_ISOLATION: "session",
    }),
    {
      workspaceId: "workspace-1",
      workspaceRoot: "/workspace",
      appRoot: ".",
      commands: {},
      managedWorktreeRequired: true,
      sourceWorkspaceRoot: "/workspace",
      managedWorktreeIsolation: "session",
    },
  );
});

test("required managed Workspace policy cannot be weakened by a client turn", () => {
  assert.deepEqual(
    applyRequiredManagedWorkspacePolicy(
      {
        workspaceId: "client-workspace",
        workspaceRoot: "/tmp/client-root",
        appRoot: "client-app",
        commands: { test: "pnpm test" },
        managedWorktreeRequired: false,
      },
      {
        KESTREL_REQUIRE_MANAGED_WORKTREE: "true",
        KESTREL_WORKSPACE_ID: "workspace-1",
        KESTREL_WORKSPACE_ROOT: "/workspace",
        KESTREL_MANAGED_WORKTREE_ISOLATION: "session",
      },
    ),
    {
      workspaceId: "workspace-1",
      workspaceRoot: "/workspace",
      appRoot: ".",
      commands: {},
      managedWorktreeRequired: true,
      sourceWorkspaceRoot: "/workspace",
      managedWorktreeIsolation: "session",
    },
  );
});

test("required managed Workspace policy fails closed when its root binding is incomplete", () => {
  assert.throws(
    () =>
      applyRequiredManagedWorkspacePolicy(undefined, {
        KESTREL_REQUIRE_MANAGED_WORKTREE: "true",
        KESTREL_WORKSPACE_ID: "workspace-1",
      }),
    /requires KESTREL_WORKSPACE_ID and KESTREL_WORKSPACE_ROOT/u,
  );
});

test("gateway-managed profiles use the credential broker path instead of provider environment defaults", () => {
  const brokeredGateway = { call: async <T>() => ({ ok: true }) as T } satisfies ModelGateway;
  let capturedProfile: TuiProfile | undefined;

  const resolved = createModelGatewayForProfile(
    {
      ...BASE_PROFILE,
      modelProvider: "openrouter",
      model: "openai/gpt-5.4",
      modelCredential: {
        source: "kestrel-one",
        runId: "run-managed",
        organizationId: "org-acme",
        environmentId: "environment-default",
        gatewayId: "gateway-openrouter",
        rawModelId: "openai/gpt-5.4",
        provider: "openrouter",
      },
    },
    {
      createGatewayManaged(profile) {
        capturedProfile = profile;
        return brokeredGateway;
      },
    },
  );

  assert.equal(resolved, brokeredGateway);
  assert.equal(capturedProfile?.model, "openai/gpt-5.4");
  assert.equal(capturedProfile?.modelCredential?.gatewayId, "gateway-openrouter");
});

test("non-managed profiles retain their environment-backed provider behavior", () => {
  const original = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "runner-environment-key";
  try {
    assert.doesNotThrow(() =>
      createModelGatewayForProfile({
        ...BASE_PROFILE,
        modelProvider: "openrouter",
        model: "openai/gpt-5.4",
      })
    );
  } finally {
    if (original === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = original;
    }
  }
});

test("non-model runtime surfaces initialize before environment provider credentials are present", async () => {
  const original = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try {
    const gateway = createModelGatewayForProfile({
      ...BASE_PROFILE,
      modelProvider: "openrouter",
      model: "openai/gpt-5.4",
    });
    await assert.rejects(
      gateway.call({ input: "model admission should resolve credentials now" }),
      /OPENROUTER_API_KEY is required/u
    );
  } finally {
    if (original === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = original;
    }
  }
});

test("model gateway treats an explicit environment as authoritative", async () => {
  const original = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "ambient-key-must-not-leak";
  try {
    const gateway = createModelGatewayForProfile({
      ...BASE_PROFILE,
      modelProvider: "openrouter",
      model: "openai/gpt-5.4",
    }, { env: {} });
    await assert.rejects(
      gateway.call({ input: "explicit runtime environment only" }),
      /OPENROUTER_API_KEY is required/u,
    );
  } finally {
    if (original === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = original;
    }
  }
});
