---
id: plan-agent-admin-stage-model-timeout-implementation-2026-04-21
domain: runtime
status: draft
owner: kestrel-runtime
last_verified_at: 2026-06-11
depends_on: [../../PLANS.md, ../specs/2026-04-21-agent-admin-stage-model-settings-design.md]
---

# Agent Admin Stage Model + Timeout Implementation Plan

See also: [Docs index](../../index.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add profile-level Agent Admin settings that support stage-wise model overrides plus a global model timeout (`modelTimeoutMs`) used by runtime model gateways for new runs.

**Architecture:** Add a contract-driven stage manifest in `agents/reference-react`, persist overrides on `TuiProfile`, expose/validate via `/api/kchat/profile`, render/edit in `/settings`, and resolve into runtime registration + gateway timeout during bootstrap. Keep behavior deterministic: unknown stages rejected, invalid timeout rejected, active runs unchanged.

**Tech Stack:** TypeScript, Next.js app router (`apps/web`), Node test runner (`node --test` via `pnpm`), Kestrel runtime (`cli/runtime`), ReAct agent package (`agents/reference-react`).

---

## File Structure Map

- Create: `agents/reference-react/src/stageModelConfig.ts`
  - Owns stage manifest and deterministic translation from `stageId -> ReActRegistrationOptions` fields.
- Modify: `agents/reference-react/src/index.ts`
  - Re-export stage config contracts/helpers.
- Modify: `cli/contracts.ts`
  - Add typed `agentStageConfig` and `modelTimeoutMs` fields to `WorkspaceProfileConfig` and `TuiProfile`.
- Modify: `src/web/profile.ts`
  - Ensure default profile shape carries new fields (empty/default).
- Modify: `apps/web/lib/server/profileConfigStore.ts`
  - Add setters for `agentStageConfig.modelByStage` and `modelTimeoutMs`.
- Modify: `apps/web/app/api/kchat/profile/route.ts`
  - Extend GET payload and PATCH parser/validator.
- Modify: `apps/web/app/_components/SettingsPageClient.tsx`
  - Add web settings UI for agent stage model map + timeout field.
- Modify: `cli/runtime/AgentFactory.ts`
  - Accept stage override map and pass mapped options to `registerReActReferenceAgent`.
- Modify: `cli/runtime/KestrelChatRuntime.ts`
  - Resolve timeout precedence from profile/env/default and pass to gateway constructors.
- Create/Modify tests:
  - Create: `tests/unit/reference-react-stage-model-config.test.ts`
  - Modify: `apps/web/tests/profile-route.test.ts`
  - Modify: `apps/web/tests/ui-smoke.test.ts`
  - Create: `tests/unit/runtime-model-timeout-resolution.test.ts`

## Task 1: Add ReAct Stage Model Manifest + Mapping Helper

**Files:**
- Create: `agents/reference-react/src/stageModelConfig.ts`
- Modify: `agents/reference-react/src/index.ts`
- Test: `tests/unit/reference-react-stage-model-config.test.ts`

- [ ] **Step 1: Write failing tests for manifest + mapping**

```ts
// tests/unit/reference-react-stage-model-config.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import {
  REACT_MODEL_CONFIG_STAGES,
  applyStageModelOverridesToReActOptions,
} from "../../agents/reference-react/src/stageModelConfig.js";

test("manifest contains expected model-configurable stage ids", () => {
  assert.deepEqual(
    REACT_MODEL_CONFIG_STAGES.map((item) => item.stageId),
    [
      "react.route",
      "react.chat",
      "react.extractor",
      "react.planner",
      "react.thinker",
      "react.resolver",
      "react.observer",
    ],
  );
});

test("mapping helper converts stage ids into ReActRegistrationOptions fields", () => {
  const mapped = applyStageModelOverridesToReActOptions({
    "react.route": "google/gemini-3.1-flash-lite-preview",
    "react.planner": "openai/gpt-5.2",
  });
  assert.equal(mapped.routeModel, "google/gemini-3.1-flash-lite-preview");
  assert.equal(mapped.plannerModel, "openai/gpt-5.2");
});

test("mapping helper ignores unknown stage ids", () => {
  const mapped = applyStageModelOverridesToReActOptions({
    "react.unknown": "foo/bar",
  });
  assert.deepEqual(mapped, {});
});
```

- [ ] **Step 2: Run test to verify failure**

Run:
```bash
pnpm test -- tests/unit/reference-react-stage-model-config.test.ts
```

Expected: FAIL with module/file not found.

- [ ] **Step 3: Implement manifest + mapping helper**

```ts
// agents/reference-react/src/stageModelConfig.ts
import type { ReActRegistrationOptions } from "./types.js";

export type ReActModelOptionKey =
  | "routeModel"
  | "chatModel"
  | "extractorModel"
  | "plannerModel"
  | "thinkerModel"
  | "resolverModel"
  | "observerModel";

export interface AgentModelConfigStage {
  stageId: string;
  label: string;
  modelOptionKey: ReActModelOptionKey;
  modelConfigurable: true;
}

export const REACT_MODEL_CONFIG_STAGES: readonly AgentModelConfigStage[] = [
  { stageId: "react.route", label: "Route", modelOptionKey: "routeModel", modelConfigurable: true },
  { stageId: "react.chat", label: "Chat", modelOptionKey: "chatModel", modelConfigurable: true },
  { stageId: "react.extractor", label: "Extractor", modelOptionKey: "extractorModel", modelConfigurable: true },
  { stageId: "react.planner", label: "Planner", modelOptionKey: "plannerModel", modelConfigurable: true },
  { stageId: "react.thinker", label: "Thinker", modelOptionKey: "thinkerModel", modelConfigurable: true },
  { stageId: "react.resolver", label: "Resolver", modelOptionKey: "resolverModel", modelConfigurable: true },
  { stageId: "react.observer", label: "Observer", modelOptionKey: "observerModel", modelConfigurable: true },
];

const MODEL_KEY_BY_STAGE = new Map(REACT_MODEL_CONFIG_STAGES.map((s) => [s.stageId, s.modelOptionKey]));

export function applyStageModelOverridesToReActOptions(
  modelByStage: Record<string, string> | undefined,
): Partial<ReActRegistrationOptions> {
  if (modelByStage === undefined) {
    return {};
  }
  const next: Partial<ReActRegistrationOptions> = {};
  for (const [stageId, model] of Object.entries(modelByStage)) {
    const key = MODEL_KEY_BY_STAGE.get(stageId);
    if (key === undefined) {
      continue;
    }
    if (typeof model === "string" && model.trim().length > 0) {
      next[key] = model.trim();
    }
  }
  return next;
}
```

```ts
// agents/reference-react/src/index.ts
export {
  REACT_MODEL_CONFIG_STAGES,
  applyStageModelOverridesToReActOptions,
  type AgentModelConfigStage,
} from "./stageModelConfig.js";
```

- [ ] **Step 4: Run tests to verify pass**

Run:
```bash
pnpm test -- tests/unit/reference-react-stage-model-config.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agents/reference-react/src/stageModelConfig.ts agents/reference-react/src/index.ts tests/unit/reference-react-stage-model-config.test.ts
git commit -m "feat(agent-admin): add react stage model manifest and mapping helper"
```

## Task 2: Persist + Validate Agent Stage Config and Model Timeout in Profile API

**Files:**
- Modify: `cli/contracts.ts`
- Modify: `src/web/profile.ts`
- Modify: `apps/web/lib/server/profileConfigStore.ts`
- Modify: `apps/web/app/api/kchat/profile/route.ts`
- Test: `apps/web/tests/profile-route.test.ts`

- [ ] **Step 1: Write failing API tests for new profile fields**

```ts
// append to apps/web/tests/profile-route.test.ts
test("profile route GET includes stage config and model timeout fields", async () => {
  resetWebDemoProfile();
  const response = await GET();
  const body = (await response.json()) as {
    ok: boolean;
    profile?: {
      agentStageConfig?: { modelByStage?: Record<string, string> };
      modelTimeoutMs?: number;
    };
  };
  assert.equal(body.ok, true);
  assert.equal(typeof body.profile?.agentStageConfig, "object");
});

test("profile route PATCH accepts modelTimeoutMs and stage model map", async () => {
  resetWebDemoProfile();
  const response = await PATCH(new Request("http://localhost/api/kchat/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      modelTimeoutMs: 45000,
      agentStageConfig: { modelByStage: { "react.route": "google/gemini-3.1-flash-lite-preview" } },
    }),
  }));
  assert.equal(response.status, 200);
});

test("profile route PATCH rejects invalid modelTimeoutMs", async () => {
  resetWebDemoProfile();
  const response = await PATCH(new Request("http://localhost/api/kchat/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ modelTimeoutMs: 0 }),
  }));
  assert.equal(response.status, 400);
});
```

- [ ] **Step 2: Run route tests to verify failure**

Run:
```bash
pnpm --filter @kestrel/web test -- tests/profile-route.test.ts
```

Expected: FAIL due unknown patch keys / missing parsing logic.

- [ ] **Step 3: Extend profile contracts + store + route parsing**

```ts
// cli/contracts.ts (both WorkspaceProfileConfig and TuiProfile)
agentStageConfig?:
  | {
      modelByStage?: Record<string, string> | undefined;
    }
  | undefined;
modelTimeoutMs?: number | undefined;
```

```ts
// src/web/profile.ts (default profile)
agentStageConfig: { modelByStage: {} },
modelTimeoutMs: undefined,
```

```ts
// apps/web/lib/server/profileConfigStore.ts
export function setWebDemoProfileAgentStageModelByStage(modelByStage: Record<string, string>): TuiProfile {
  storeProfile = {
    ...cloneProfile(storeProfile),
    agentStageConfig: { modelByStage: { ...modelByStage } },
  };
  profileVersion += 1;
  return cloneProfile(storeProfile);
}

export function setWebDemoProfileModelTimeoutMs(modelTimeoutMs: number | undefined): TuiProfile {
  storeProfile = {
    ...cloneProfile(storeProfile),
    ...(modelTimeoutMs !== undefined ? { modelTimeoutMs } : { modelTimeoutMs: undefined }),
  };
  profileVersion += 1;
  return cloneProfile(storeProfile);
}
```

```ts
// apps/web/app/api/kchat/profile/route.ts (ProfilePatchBody + parseProfilePatch)
type ProfilePatchBody = {
  mcpServers?: unknown;
  codeMode?: unknown;
  toolAllowlist?: unknown;
  presetId?: unknown;
  capabilityPacks?: unknown;
  modelTimeoutMs?: unknown;
  agentStageConfig?: unknown;
};

function parseProfilePatch(value: unknown): {
  mcpServers?: McpServerConfig[] | undefined;
  toolAllowlist?: string[] | undefined;
  codeModeEnabled?: boolean | undefined;
  presetId?: ShellPresetId | undefined;
  capabilityPacks?: CapabilityPackId[] | undefined;
  modelTimeoutMs?: number | undefined;
  agentStageModelByStage?: Record<string, string> | undefined;
} {
  // include hasModelTimeout/hasAgentStageConfig checks in the same required-field guard
}
```

```ts
// apps/web/app/api/kchat/profile/route.ts (PATCH handler application)
if (patch.agentStageModelByStage !== undefined) {
  profile = setWebDemoProfileAgentStageModelByStage(patch.agentStageModelByStage);
}
if (patch.modelTimeoutMs !== undefined) {
  profile = setWebDemoProfileModelTimeoutMs(patch.modelTimeoutMs);
}
```

- [ ] **Step 4: Re-run route tests**

Run:
```bash
pnpm --filter @kestrel/web test -- tests/profile-route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/contracts.ts src/web/profile.ts apps/web/lib/server/profileConfigStore.ts apps/web/app/api/kchat/profile/route.ts apps/web/tests/profile-route.test.ts
git commit -m "feat(agent-admin): persist and validate stage model config and model timeout in profile api"
```

## Task 3: Add Web Settings UI for Stage Models and Model Timeout

**Files:**
- Modify: `apps/web/app/_components/SettingsPageClient.tsx`
- Modify: `apps/web/app/globals.css`
- Test: `apps/web/tests/ui-smoke.test.ts`

- [ ] **Step 1: Write failing UI smoke assertions**

```ts
// append to apps/web/tests/ui-smoke.test.ts settings assertions
assert.match(settingsPageSource, /Stage model settings/);
assert.match(settingsPageSource, /Model timeout \\(ms\\)/);
assert.match(settingsPageSource, /Save profile settings/);
```

- [ ] **Step 2: Run UI smoke test to verify failure**

Run:
```bash
pnpm --filter @kestrel/web test -- tests/ui-smoke.test.ts
```

Expected: FAIL because markers do not exist yet.

- [ ] **Step 3: Implement settings UI state, fetch, and patch**

```tsx
// SettingsPageClient.tsx (new web-only state)
const [profileModelTimeoutDraft, setProfileModelTimeoutDraft] = useState<string>("");
const [stageModelDraft, setStageModelDraft] = useState<Record<string, string>>({});
const [stageManifest, setStageManifest] = useState<Array<{ stageId: string; label: string }>>([]);
```

```tsx
// load profile on non-desktop
useEffect(() => {
  if (isDesktopApp) return;
  void fetch("/api/kchat/profile", { cache: "no-store" })
    .then(async (response) => {
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw new Error("Failed to load profile settings.");
      setStageManifest(body.agentStageManifest ?? []);
      setStageModelDraft(body.profile?.agentStageConfig?.modelByStage ?? {});
      setProfileModelTimeoutDraft(
        typeof body.profile?.modelTimeoutMs === "number" ? String(body.profile.modelTimeoutMs) : "",
      );
    })
    .catch((error) => setSettingsError(error instanceof Error ? error.message : String(error)));
}, [isDesktopApp]);
```

```tsx
// web save branch in saveSettings()
if (isDesktopApp === false) {
  await fetch("/api/kchat/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      agentStageConfig: { modelByStage: stageModelDraft },
      ...(profileModelTimeoutDraft.trim().length > 0
        ? { modelTimeoutMs: Number.parseInt(profileModelTimeoutDraft, 10) }
        : {}),
    }),
  });
}
```

```tsx
// new web section markup in renderGeneralSection()
<div className="kdesktop-settings-group">
  <div>
    <p className="kdesktop-settings-label">Stage model settings</p>
    <p className="kdesktop-settings-copy">Configure per-stage model overrides for new runs.</p>
  </div>
  {stageManifest.map((stage) => (
    <label key={stage.stageId} className="kdesktop-settings-field">
      <span className="kdesktop-settings-label">{stage.label}</span>
      <input
        className="kdesktop-settings-input"
        value={stageModelDraft[stage.stageId] ?? ""}
        onChange={(event) => setStageModelDraft((current) => ({ ...current, [stage.stageId]: event.target.value }))}
      />
    </label>
  ))}
</div>
<div className="kdesktop-settings-group">
  <label className="kdesktop-settings-field">
    <span className="kdesktop-settings-label">Model timeout (ms)</span>
    <input
      className="kdesktop-settings-input"
      value={profileModelTimeoutDraft}
      onChange={(event) => setProfileModelTimeoutDraft(event.target.value)}
    />
  </label>
</div>
```

- [ ] **Step 4: Re-run UI smoke test**

Run:
```bash
pnpm --filter @kestrel/web test -- tests/ui-smoke.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/_components/SettingsPageClient.tsx apps/web/app/globals.css apps/web/tests/ui-smoke.test.ts
git commit -m "feat(settings): add web agent stage model and model timeout controls"
```

## Task 4: Wire Runtime Bootstrap to Stage Overrides and Timeout Precedence

**Files:**
- Modify: `cli/runtime/AgentFactory.ts`
- Modify: `cli/runtime/KestrelChatRuntime.ts`
- Test: `tests/unit/runtime-model-timeout-resolution.test.ts`
- Test: `tests/unit/react-model-defaults.test.ts`

- [ ] **Step 1: Add failing tests for timeout precedence helper + stage override wiring helper**

```ts
// tests/unit/runtime-model-timeout-resolution.test.ts
import test from "node:test";
import assert from "node:assert/strict";
import { resolveModelTimeoutMs } from "../../cli/runtime/KestrelChatRuntime.js";

test("resolveModelTimeoutMs prefers profile over env", () => {
  const timeout = resolveModelTimeoutMs({ profileTimeoutMs: 45000, envTimeoutMs: 15000 });
  assert.equal(timeout, 45000);
});

test("resolveModelTimeoutMs falls back to env", () => {
  const timeout = resolveModelTimeoutMs({ profileTimeoutMs: undefined, envTimeoutMs: 15000 });
  assert.equal(timeout, 15000);
});
```

```ts
// tests/unit/react-model-defaults.test.ts (append)
import { applyStageModelOverridesToReActOptions } from "../../agents/reference-react/src/stageModelConfig.js";

test("stage override helper maps route and thinker stages", () => {
  const mapped = applyStageModelOverridesToReActOptions({
    "react.route": "provider/fast",
    "react.thinker": "provider/deep",
  });
  assert.equal(mapped.routeModel, "provider/fast");
  assert.equal(mapped.thinkerModel, "provider/deep");
});
```

- [ ] **Step 2: Run targeted unit tests to verify failure**

Run:
```bash
pnpm test -- tests/unit/runtime-model-timeout-resolution.test.ts tests/unit/react-model-defaults.test.ts
```

Expected: FAIL because helper/export does not exist yet.

- [ ] **Step 3: Implement runtime resolution and agent registration overrides**

```ts
// cli/runtime/AgentFactory.ts
export interface RegisterAgentOptions {
  stageModelByStage?: Record<string, string> | undefined;
}

if (agent === "reference-react") {
  return registerReActReferenceAgent(kestrel, {
    ...applyStageModelOverridesToReActOptions(options?.stageModelByStage),
    ...(options?.thinkerTools !== undefined ? { thinkerTools: options.thinkerTools } : {}),
    ...(options?.thinkerToolsProvider !== undefined ? { thinkerToolsProvider: options.thinkerToolsProvider } : {}),
    ...(options?.resolverTools !== undefined ? { resolverTools: options.resolverTools } : {}),
    ...(options?.resolverToolsProvider !== undefined ? { resolverToolsProvider: options.resolverToolsProvider } : {}),
    ...(options?.capabilityManifest !== undefined ? { capabilityManifest: options.capabilityManifest } : {}),
    ...(options?.capabilityManifestProvider !== undefined
      ? { capabilityManifestProvider: options.capabilityManifestProvider }
      : {}),
  });
}
```

```ts
// cli/runtime/KestrelChatRuntime.ts
export function resolveModelTimeoutMs(input: {
  profileTimeoutMs: number | undefined;
  envTimeoutMs: number | undefined;
}): number | undefined {
  return input.profileTimeoutMs ?? input.envTimeoutMs;
}

const envTimeoutMs = parseEnvInt("KCHAT_MODEL_TIMEOUT_MS");
const timeoutMs = resolveModelTimeoutMs({
  profileTimeoutMs: profile.modelTimeoutMs,
  envTimeoutMs,
});
```

```ts
// registerAgent call in bootstrap
const registration = registerAgent(kestrel, profile.agent, {
  thinkerToolsProvider: () => toolRegistry.getModelTools(),
  capabilityManifestProvider: () => toolRegistry.getCapabilityManifest(),
  stageModelByStage: profile.agentStageConfig?.modelByStage,
});
```

- [ ] **Step 4: Re-run targeted unit tests**

Run:
```bash
pnpm test -- tests/unit/runtime-model-timeout-resolution.test.ts tests/unit/react-model-defaults.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cli/runtime/AgentFactory.ts cli/runtime/KestrelChatRuntime.ts tests/unit/runtime-model-timeout-resolution.test.ts tests/unit/react-model-defaults.test.ts
git commit -m "feat(runtime): apply profile stage model overrides and model timeout precedence"
```

## Task 5: Final Verification Gates and Documentation Sync

**Files:**
- Optional modify: `docs/superpowers/specs/2026-04-21-agent-admin-stage-model-settings-design.md` (only if implementation decisions diverge)
- No feature-scope expansion in this task.

- [ ] **Step 1: Run focused web route/UI tests**

Run:
```bash
pnpm --filter @kestrel/web test -- tests/profile-route.test.ts tests/ui-smoke.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run focused runtime/unit tests**

Run:
```bash
pnpm test -- tests/unit/reference-react-stage-model-config.test.ts tests/unit/runtime-model-timeout-resolution.test.ts tests/unit/react-model-defaults.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run required repo gates from AGENTS.md**

Run:
```bash
pnpm run governance:check
pnpm run test
pnpm run prompt-suite
pnpm run evals:release-check
```

Expected: all PASS; if failures are unrelated, capture exact failing suites before proceeding.

- [ ] **Step 4: If test-driven adjustments were needed, apply minimal fixes and re-run only affected suites**

```bash
pnpm --filter @kestrel/web test -- tests/profile-route.test.ts
pnpm test -- tests/unit/runtime-model-timeout-resolution.test.ts
```

Expected: PASS for all previously failing suites.

- [ ] **Step 5: Final commit and summary**

```bash
git add -A
git commit -m "feat(agent-admin): ship stage model overrides and profile model timeout settings"
git status
```

Expected: clean working tree, commit ready for PR.

## Spec-to-Plan Coverage Check

- Stage manifest sourced from agent definition: Task 1.
- Profile persistence for stage map + timeout: Task 2.
- Settings UI for stage models + timeout: Task 3.
- Runtime application on new runs only: Task 4.
- Validation + gates (`governance:check`, `test`, `prompt-suite`, `evals:release-check`): Task 5.

No uncovered spec requirements remain.
