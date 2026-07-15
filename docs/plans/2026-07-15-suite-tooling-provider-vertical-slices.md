---
id: suite-tooling-provider-vertical-slices
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-07-15
depends_on: [../../tools/README.md, ../../apps/web/docs/plans/2026-03-19-tools-control-plane-design.md]
---

# Kestrel Suite Tooling Provider Vertical Slices

## Goal

Make Kestrel Suite tools and Kestrel One Apps one governed capability system.
Every provider slice must ship a canonical runtime contract, provider boundary,
Environment and Project policy, App discovery surface, tests, operational
evidence, and packaged desktop resources together.

The shared runtime contract is summarized in the [Tools Slice](../../tools/README.md),
and the Kestrel One policy model began in the
[Tools Control Plane Design](../../apps/web/docs/plans/2026-03-19-tools-control-plane-design.md).

## Ownership

- `tools/` owns canonical tool names, model-visible input/output contracts, and
  normalized provider handlers.
- Kestrel One Apps owns installation, connection, Environment grants, Project
  narrowing, and approval policy for those canonical runtime names.
- Runtime profiles consume only effective App capabilities; they do not create a
  second provider registry or tool alias.
- UI and docs describe the App capability and its connection/readiness state;
  they do not redefine provider behavior.

## Slice 1: Shared Provider Platform

Status: complete.

- Make provider identity, App presentation, connection ownership, connection
  requirement, auth methods, delivery, installation, and capabilities one
  explicit provider definition rather than name-based catalog inference.
- Inject provider-scoped runtime configuration through a redacted resolver;
  shared tool modules must not gain ambient credential authority.
- Use one hosted runtime broker contract with exact capability and target
  allowlists, Project access checks, health degradation, and audit events.
- Publish non-secret provider configuration readiness in tool runtime health.
- Add durable, payload-bound, single-use approval for write capabilities and
  adapters for API keys, personal OAuth, and deployment-managed identities.
- Prove Kestrel One App runtime names reference canonical shared tool
  definitions and preserve legacy policy keys only where stored data requires
  them.

## Slice 2: Weather Resilience

Status: in progress.

- Keep `free.weather.current` and `free.weather.forecast` as the canonical
  Suite contracts and `built_in.weather` as the inherited App.
- Use Open-Meteo first and Visual Crossing second, never hidden provider
  selection. Visual Crossing is an optional Environment connection and a
  Keychain-backed Local Core credential.
- Open-Meteo and Visual Crossing now implement the same normalized provider
  adapter contract. Kestrel One's Visual Crossing transport is routed through
  the generic App broker, while local execution requires the exact scoped
  provider credential; neither path exposes the provider key to model context.
- Normalize both providers into the same current and forecast outputs, retain
  provider attribution, and surface every attempted provider and failure.
- Complete failover within an 18-second provider budget that begins after
  geocoding: one Open-Meteo attempt capped at 8 seconds, no same-provider
  retries, then one Visual Crossing attempt using the remaining budget capped
  at 10 seconds.
- Fail over only for transport errors, timeouts, HTTP 408/425/429/5xx, and
  invalid normalized payloads. Input/geocoding failures and every other 4xx
  remain terminal on the primary path.
- Report a missing Visual Crossing connection as explicit fallback-unavailable
  evidence. Visual Crossing 401/403 responses degrade the App connection, and
  a later successful provider response restores it to connected.
- Desktop exposes Weather under Apps with explicit Open-Meteo primary and
  Visual Crossing fallback readiness. Visual Crossing keys are verified before
  being written through Local Core to macOS Keychain; renderer clients receive
  status only and can replace or remove the fallback without reading its key.
- Kestrel One names Visual Crossing as the optional fallback at the Environment
  connection boundary, verifies and encrypts it on save, and directs operators
  to attach that connection under Project Apps. Project UI continues to show
  Weather as usable through Open-Meteo when no fallback is attached.
- Cover current/forecast parity, malformed payloads, timeouts, missing fallback
  credentials, degraded primary, healthy fallback, and total-budget evidence.

## Slice 3: Tavily

Status: pending.

- Rename all ten model-visible tools to canonical `tavily.*` names through a
  bounded replay-compatible migration.
- Standardize search, advanced search, news, images, extract, crawl, map,
  research, research status, and usage outputs and failure envelopes.
- Use the shared credential resolver locally and the exact hosted broker in
  Kestrel One, with no hidden Exa fallback or heuristic provider routing.
- Finish Apps setup, Environment grants, Project narrowing, approvals, health,
  audit, docs, Desktop resources, and release verification together.

## Slice 4: Exa

Status: pending.

- Add canonical `exa.search`, `exa.contents`, `exa.similar`, and
  `exa.answer` contracts with explicit provider attribution.
- Add API-key connection verification, encrypted local and hosted credentials,
  Apps discovery, Environment and Project policy, runtime broker/handler,
  health, audit, docs, tests, and Desktop packaging.
- Do not route to Tavily when Exa is unavailable; return the normalized Exa
  failure or degraded state.

## Slice 5: Microsoft Teams

Status: pending.

- Support personal delegated OAuth and deployment-managed shared Project
  identities as separate, explicit connection methods.
- Limit discovery, reading, posting, and replies to granted teams and channels;
  enforce personal-before-shared connection precedence only when both are
  policy-eligible.
- Require payload-bound, single-use approval for posting and replies before any
  Microsoft Graph execution.
- Complete Apps, Environment and Project resource controls, runtime, health,
  audit, docs, tests, OAuth callback behavior, and Desktop resources together.

## Slice Completion Contract

Every slice includes its model-visible contract, provider adapter, secure local
and hosted credential handling, Apps discovery, Environment and Project
controls, runtime execution, approvals, health, audit evidence, docs, tests, and
packaged Desktop resources. A slice is not complete when only its provider API
call works.

## Required Gates Per Slice

1. Focused provider and App-policy tests.
2. `pnpm run governance:check`.
3. `pnpm run test`.
4. `pnpm run prompt-suite`.
5. `pnpm run evals:release-check` for runtime/core changes.
6. Desktop resource mirror validation when shared runtime files change.
