import test from "node:test";
import assert from "node:assert/strict";

import type { TuiProfile } from "../../cli/contracts.js";
import {
  applyRequiredManagedWorkspacePolicy,
  createModelGatewayForProfile,
  createRuntimeFactoryWithStore,
  resolveManagedWorktreesEnabledForRuntime,
} from "../../cli/runtime/KestrelChatRuntime.js";
import type { ModelGateway } from "../../src/kestrel/contracts/model-io.js";
import { InMemorySessionStore } from "../../src/store/InMemorySessionStore.js";


const BASE_PROFILE: TuiProfile = {
  id: "reference",
  label: "Reference",
  agent: "reference-react",
  sessionPrefix: "reference",
};

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
