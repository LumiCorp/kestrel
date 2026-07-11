---
id: spec-agent-admin-stage-model-settings-2026-04-21
domain: runtime
status: draft
owner: kestrel-runtime
last_verified_at: 2026-06-11
depends_on: [../../PLANS.md]
---

# Agent Admin MVP: Stage-wise Model Settings

See also: [Docs index](../../index.md).

Date: 2026-04-21  
Status: Approved design  
Scope: Web settings UX + profile-backed persistence + runtime wiring for new runs

## 1. Summary

Build a first MVP of an agent admin settings experience that dynamically lists model-configurable stages from the selected agent definition and lets operators assign a model per stage.

For this MVP:
- Persistence scope is profile-level (global default across sessions).
- Config applies to new runs only.
- Stage configuration is model-only; provider remains profile-level.
- Add a profile-level model timeout setting that controls `KCHAT_MODEL_TIMEOUT_MS` behavior.
- Initial target agent is `reference-react`.

This is intentionally a narrow slice that can later expand into an agent designer.

## 2. Goals and Non-goals

### Goals
- Expose a clean settings workflow for stage-wise model assignment.
- Drive the stage list from agent-owned contract data (not UI hardcoding).
- Persist stage overrides in profile configuration.
- Resolve effective per-stage model deterministically at run setup.
- Expose profile-level control for model gateway timeout in settings.

### Non-goals (MVP)
- Per-stage provider overrides.
- Per-project or per-thread configuration scopes.
- Retrofitting active runs with newly saved stage settings.
- Policy editing beyond model assignment.

## 3. Key Decisions Locked

- Persistence scope: profile-level.
- Configurable stages: model-calling stages only.
- Application timing: new runs only.
- Field set: model only (provider is profile-level).
- Timeout control: single global timeout per profile (milliseconds).
- UI layout: matrix-first settings table.

## 4. Architecture

### 4.1 Agent-owned stage manifest

Add a manifest export in `agents/reference-react` describing model-configurable stages.

Proposed contract:

```ts
type AgentModelConfigStage = {
  stageId: string;        // e.g. "react.route"
  label: string;          // e.g. "Route"
  modelOptionKey:         // maps to ReActRegistrationOptions key
    | "routeModel"
    | "chatModel"
    | "extractorModel"
    | "plannerModel"
    | "thinkerModel"
    | "resolverModel"
    | "observerModel";
  modelConfigurable: true;
};
```

Initial stage entries:
- `react.route` -> `routeModel`
- `react.chat` -> `chatModel`
- `react.extractor` -> `extractorModel`
- `react.planner` -> `plannerModel`
- `react.thinker` -> `thinkerModel`
- `react.resolver` -> `resolverModel`
- `react.observer` -> `observerModel`

This keeps configuration contract-driven and avoids heuristic stage inference.

### 4.2 Profile configuration extension

Extend profile configuration with a stage model map:

```ts
type AgentStageConfig = {
  modelByStage?: Record<string, string>;
};
```

Add profile-level runtime timeout field:

```ts
type AgentModelRuntimeConfig = {
  modelTimeoutMs?: number;
};
```

Placement:
- Profile runtime shape returned by `apps/web/lib/server/profileConfigStore.ts`.
- Stored in the existing in-memory web demo profile path for current web behavior.

Validation:
- Key must match a known manifest `stageId`.
- Value must be a non-empty string.
- Unknown stages are rejected.
- `modelTimeoutMs` must be a positive integer.

### 4.3 Settings page UX

Use `/settings` and add an Agent section (within existing settings experience) with:
- Agent context header sourced from the active profile (`profile.agent`); no manual selector in MVP.
- Matrix rows: Stage, Effective Default Model, Override Model selector/input.
- Global model timeout input: `Model timeout (ms)` with helper text that it applies to new runs.
- Actions: `Reset to defaults`, `Save changes`.

Layout direction is matrix-first for fast scan/edit.

Agent support in MVP:
- If active profile agent is `reference-react`, render editable stage matrix.
- For other agents, render an empty-state message until their manifest export is added.

### 4.4 Runtime model resolution

At run setup / agent registration:
- Read profile stage overrides.
- Map `stageId -> modelOptionKey`.
- Construct `ReActRegistrationOptions` stage model fields from overrides.
- Pass those options into `registerReActReferenceAgent(...)`.
- Preserve current fallback behavior when no override exists.
- Resolve model timeout from profile config before gateway construction.

Effective model resolution per stage:

```text
effectiveModel(stage) =
  profile.agentStageConfig.modelByStage[stageId]
  ?? agent-default-stage-model
```

Provider remains profile-level; stage config does not alter provider.

Model timeout resolution:

```text
effectiveModelTimeoutMs =
  profile.modelTimeoutMs
  ?? env.KCHAT_MODEL_TIMEOUT_MS
  ?? gateway-default
```

This keeps env compatibility while allowing settings-driven control.

## 5. API Changes

### GET `/api/kchat/profile`

Add payload fields:
- `agentStageManifest`: list of model-configurable stages.
- `agentStageConfig`: current persisted `modelByStage`.
- `modelTimeoutMs`: current profile-level model timeout.

### PATCH `/api/kchat/profile`

Accept partial patch field:
- `agentStageConfig.modelByStage`
- `modelTimeoutMs`

Patch behavior:
- Validate all stage keys against manifest.
- Validate all model values as non-empty strings.
- Validate `modelTimeoutMs` as a positive integer when provided.
- Persist only validated data.

Error semantics:
- 400 for schema/validation failures (`WEB_PROFILE_BODY_INVALID` envelope style).
- 500 for store/runtime failures (`WEB_PROFILE_PATCH_FAILED` envelope style).

## 6. Data Flow

1. User opens `/settings`.
2. Client requests profile payload (existing profile route).
3. Server returns profile + stage manifest + current `modelByStage`.
4. User edits per-stage models and/or `Model timeout (ms)`.
5. Client PATCHes `agentStageConfig.modelByStage` and/or `modelTimeoutMs`.
6. Server validates and persists profile update.
7. Future runs apply new stage settings and timeout through runtime bootstrap.

## 7. Error Handling

UI behavior:
- Field-level inline errors for invalid stage/model entries.
- Field-level inline errors for invalid timeout input.
- Non-blocking error banner for save failures.
- Success notice on save.
- Reset action clears stage overrides and restores agent defaults.

Server behavior:
- Strict boundary parsing before profile mutation.
- Deterministic rejection for unknown stage IDs.
- No silent coercion.

Runtime behavior:
- If no override exists or override block is absent, run with existing defaults.
- If no profile timeout exists, keep env/default timeout behavior unchanged.

## 8. Testing Strategy

### Unit
- Manifest contract tests in `agents/reference-react`:
  - unique stage IDs
  - all `modelOptionKey` values are valid option keys
- Profile route parser tests:
  - accepts valid `modelByStage`
  - rejects unknown stages
  - rejects empty model values
  - accepts valid `modelTimeoutMs`
  - rejects non-positive/non-integer `modelTimeoutMs`

### Integration
- Settings page flow:
  - load manifest + config
  - edit stage model
  - save success path
  - reset path
  - validation and error states

### Runtime wiring
- Agent registration test verifies stage overrides are translated into `ReActRegistrationOptions` model fields.
- New run behavior test confirms updated model map is used after save.
- Runtime bootstrap test verifies profile `modelTimeoutMs` is passed to model gateway timeout.

## 9. Rollout Plan

1. Add agent stage manifest contract and `reference-react` manifest export.
2. Extend profile route/store to read/write `agentStageConfig.modelByStage`.
3. Extend profile route/store to read/write `modelTimeoutMs`.
4. Add matrix-first Agent Admin section in `/settings` with timeout input.
5. Wire runtime registration mapping for stage overrides and timeout.
6. Land tests for manifest, API validation, UI flow, and runtime wiring.

## 10. Acceptance Criteria

- Settings page shows `reference-react` configurable stages dynamically from manifest.
- User can set a model for each listed stage and save.
- Saved values round-trip from API and persist in profile config.
- `modelTimeoutMs` round-trips from API and persists in profile config.
- New runs use overridden stage models.
- New runs use persisted model timeout value.
- Active runs are unchanged after save.
- Unknown stage IDs and invalid model values are rejected with explicit errors.
- Invalid timeout values are rejected with explicit errors.
