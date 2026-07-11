---
id: packaged-desktop-first-run-capability-audit-2026-06-03
domain: analysis
status: active
owner: kestrel-desktop
last_verified_at: 2026-06-03
depends_on:
  - ../../README.md
  - ../../apps/desktop/src/main.ts
  - ../../apps/desktop/src/settingsStore.ts
  - ../../apps/web/app/_components/ChatPageClient.tsx
  - ../../apps/web/app/_components/SettingsPageClient.tsx
  - ../../src/desktopShell/readiness.ts
  - ../index.md
---

# Packaged Desktop First-Run Capability Audit

See also: [Docs index](../index.md).

## Goal

Map the packaged Kestrel Desktop first-run journey as it exists today, identify what a new user can actually configure from the product, and separate true blockers from discoverability and documentation gaps.

This is a code-grounded audit, not a live usability session and not a fix pass.

## Scope And Defaults

- Focus on the packaged Desktop user journey, not repo checkout or `desktop:dev`.
- Treat [apps/web/app/_components/ChatPageClient.tsx](../../apps/web/app/_components/ChatPageClient.tsx), [apps/web/app/_components/SettingsPageClient.tsx](../../apps/web/app/_components/SettingsPageClient.tsx), and [apps/desktop/src/settingsStore.ts](../../apps/desktop/src/settingsStore.ts) as the highest-signal source of truth.
- Default packaged path is provider-first, project-second.
- Shared model policy still carries an internal OpenRouter default, but pristine first-run no longer treats that latent default as a user-facing provider choice.

## Implemented First-Run State Machine

### Launch to cockpit

1. Desktop boot starts in [apps/desktop/src/main.ts](../../apps/desktop/src/main.ts).
2. Boot readiness is derived from:
   - local resource presence
   - settings load
   - provider credential readiness
   - database status
   - runtime status
   - cockpit server readiness
   - bridge connectivity
   - registered project count
3. The boot splash in [apps/desktop/static/boot.html](../../apps/desktop/static/boot.html) can show readiness items and action labels, but it does not directly open settings or project setup before the cockpit loads.

### Cockpit entry conditions

- If desktop runtime health is `blocked`, chat renders the recovery screen instead of the guided setup wizard.
- Provider-choice and provider-key gaps during incomplete onboarding now surface as degraded onboarding work, not blocked recovery.
- If runtime health is not blocked and onboarding is incomplete, chat renders the guided setup wizard automatically and resumes the first unfinished milestone.
- If runtime health is not blocked, the guided setup wizard can also be reopened manually through the `desktopSetup=1` chat route flag.
- Manual relaunch resumes the first unfinished milestone when onboarding is incomplete, and starts at `welcome` after onboarding is complete.
- Onboarding completion now depends on explicit provider selection, provider credential satisfaction when required, project onboarding, and `setupCompletedAt`.

### Guided setup flow

The setup wizard in [apps/web/app/_components/ChatPageClient.tsx](../../apps/web/app/_components/ChatPageClient.tsx) is implemented as:

1. `welcome`
2. `provider`
3. `key`
4. `project`
5. `finish`

On successful completion it:

- persists explicit provider selection through desktop settings
- persists the selected provider key through desktop settings
- adds the chosen project to the project library
- writes `setupCompletedAt`
- restarts the runtime through the desktop bridge
- creates or reuses a build thread for the chosen workspace

## Entry Surfaces A Fresh User Sees

### Surface 1: boot splash

- Present before the cockpit is ready.
- Good for startup status and failure framing.
- Limited for onboarding because `open_settings` and `add_project` actions only explain that those flows are available after the cockpit opens.

### Surface 2: blocked recovery screen

- Present when runtime health is `blocked`.
- Includes readiness checklist, settings entry, logs, help-packet actions, retry actions, and conditional recovery actions such as database restart/repair or runtime-store reset.
- This is now reserved for non-onboarding failures such as missing resources, database faults, or runtime boot failures.

### Surface 3: guided setup wizard

- Shown automatically only when setup is incomplete and runtime health is not blocked.
- Can also be reopened manually when runtime health is not blocked.
- This is the intended first-run funnel:
  - confirm or change provider
  - enter key
  - add project
  - enter workspace

### Surface 4: settings

- Reachable from the recovery screen or later navigation.
- More capable than the setup wizard.
- Acts as the real configuration control plane for model, database, services, project library, and diagnostics.

## Required First-Run Inputs

### Required to clear provider gating

- One explicit provider choice:
  - `openrouter`
  - `openai`
  - `anthropic`
  - `ollama`
  - `lmstudio`
- One key for the selected hosted provider:
  - `OPENROUTER_API_KEY`
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`

Notes:

- Local providers (`ollama`, `lmstudio`) do not require an API key by default.

### Required for the default guided path to feel complete

- One project folder selection in the setup wizard.

Notes:

- Project selection is required to finish the guided setup wizard.
- Project selection is not required to reach Settings or to clear the provider-key runtime blocker.

### Conditionally required

- `DATABASE_URL` only when Settings switches database mode to `External`.

## Optional Advanced Inputs

### Provider-specific advanced fields

- OpenRouter:
  - base URL
  - site URL
  - app name
- OpenAI:
  - base URL
  - organization ID
  - project ID
- Anthropic:
  - base URL
  - API version

### Shared model controls

- active provider model
- model timeout
- per-stage model overrides
- image input capability flag

### Service environment

- `TAVILY_API_KEY`
- `TAVILY_BASE_URL`
- `TAVILY_PROJECT`
- `TAVILY_HTTP_PROXY`
- `TAVILY_HTTPS_PROXY`

### Project and runtime controls

- project library add/remove
- runtime restart
- database restart/repair
- diagnostics bundle and logs

## What Is Implemented Beyond First-Run

- Provider switching is implemented in Settings, not only in setup.
- Shared model policy is persisted separately from desktop settings and remains the canonical provider/model authority across desktop, web, and CLI.
- Desktop settings persist local secret and env-like values for:
  - model providers
  - external database mode
  - Tavily service environment
  - project library
- Runtime readiness and recovery flows are implemented with actionable states rather than a generic failure page.

## True Blockers

### 1. External database mode without `DATABASE_URL` blocks runtime startup

- Desktop intentionally does not fall back to local defaults when external database mode is selected without a URL.
- This is correct contract behavior, but still a first-run hard stop when selected too early.

Impact:

- Recoverable through Settings.
- Blocks runtime startup and usable control-plane readiness, even though the Desktop shell can still open into recovery UI.

## Confusing But Recoverable Gaps

### 1. Boot splash actions are informative, not truly navigational

- The splash can show `Open Settings` and `Add Project`.
- Before cockpit load, those actions only update explanatory text.

Impact:

- Users may read the splash as interactive recovery when it is mostly staged messaging.

### 2. Settings still owns configuration power beyond the guided path

- Guided setup now resumes correctly, but Settings still exposes the broader control plane for provider tuning, services, diagnostics, and database mode.

Impact:

- Useful for legacy migration.
- Weak for a strict first-run funnel because the app may decide setup is “done enough” before the intended workspace handoff occurred.

### 3. Settings information architecture is broader than the visible section list suggests

- `DesktopSettingsSection` defines `services`, `workspace`, and `advanced`.
- The current section list only includes:
  - `general`
  - `models`
  - `database`
  - `projects`
  - `advanced`
- A dedicated `services` render branch exists, but normal navigation does not expose it.
- In normal navigation, the fallback render path makes `advanced` the combined diagnostics and service-environment screen.
- `workspace` is labeled in constants but not exposed as a navigable section.

Impact:

- The product has real configuration depth, but the structure is not self-evident from names alone.
- “Advanced” currently mixes actionable service env fields with mostly diagnostic material.

## Present But Undiscoverable Flows

- Guided setup relaunch is exposed from Settings through `?desktopSetup=1`, and the chat route honors that flag after hydration.
- The relaunch flag still does not win over blocked recovery. If runtime health is `blocked`, recovery continues to take precedence over the wizard.
- Provider-specific advanced fields exist in Settings, not in guided setup.
- Shared model timeout, stage overrides, and image input capability exist in Settings, not in guided setup.
- Tavily service environment exists in Settings, not in guided setup.
- Recovery screen provides a good rescue path, but it is not framed as “you are in setup, continue here.”

## Documented Versus Undocumented

### Documented

- Repo and docs quickstarts explain how to launch Desktop.
- Desktop README documents database mode behavior.
- README positions Desktop as the flagship surface.

### Undocumented

- The packaged first-run journey from launch to usable workspace.
- Which credentials a packaged user must enter first.
- The difference between guided setup and Settings-based setup.
- The fact that provider gating can force a recovery-first path.
- Which advanced fields are available only after entering Settings.

## Ownership Of First-Run Concerns

### Provider and model ownership

- Shared model policy:
  - [src/profile/modelPolicy.ts](../../src/profile/modelPolicy.ts)
  - desktop bridge model-policy read/write in [apps/desktop/src/main.ts](../../apps/desktop/src/main.ts)

Why:

- Provider/model selection is shared runtime policy, not desktop-only UI state.

### Local secret and desktop config persistence

- [apps/desktop/src/settingsStore.ts](../../apps/desktop/src/settingsStore.ts)

Why:

- Desktop settings own local persisted provider secrets, database mode, Tavily env, project library, and setup-completion markers.

### Startup messaging, readiness, and recovery

- [apps/desktop/src/main.ts](../../apps/desktop/src/main.ts)
- [src/desktopShell/readiness.ts](../../src/desktopShell/readiness.ts)
- recovery and setup gating in [apps/web/app/_components/ChatPageClient.tsx](../../apps/web/app/_components/ChatPageClient.tsx)

Why:

- These surfaces decide whether the user sees boot progress, blocked recovery, or guided setup.

## Test Scenario Results To Verify

| Scenario | Expected current behavior | Audit result |
| --- | --- | --- |
| Fresh install, no settings, no provider key | Guided setup auto-opens at provider choice; runtime health stays degraded instead of blocked | Confirmed by onboarding helper plus runtime-health gating |
| Fresh install, provider selected, no key | Guided setup resumes at key entry instead of recovery | Confirmed by onboarding helper plus runtime-health gating |
| Fresh install, persisted valid key, no project added | Guided setup resumes at project selection | Confirmed by onboarding helper next-step logic |
| In-wizard key entry, no project added yet | Setup can continue to the project step because the key remains draft state until finish persists settings | Confirmed by guided setup flow |
| External DB mode, missing `DATABASE_URL` | Runtime/database startup blocked | Confirmed by settings/env contract |
| Provider key configured through Settings | Recoverable without using guided setup | Confirmed by settings persistence and runtime restart path |
| Post-setup relaunch | Settings exposes relaunch path; chat honors `desktopSetup=1` when runtime is not blocked | Confirmed |
| Missing desktop resources | Reinstall-style readiness failure separate from provider onboarding | Confirmed by resource readiness checks |
| Settings `Advanced`, `Services`, and `Workspace` | `Advanced` is real but overloaded; a `services` branch exists but is not in nav; `Workspace` is not an exposed section | Confirmed |

## Prioritized Gap List

### True blockers

1. External database mode can create a runtime-start blocker when selected without `DATABASE_URL`.

### Confusing but recoverable

1. Boot splash actions look more interactive than they are before cockpit load.
2. Settings still exposes more capability than guided setup, and that distinction is not obvious without documentation.
3. Settings section structure does not cleanly match the conceptual surface area.

### Docs and discoverability gaps

1. Quickstarts do not describe the packaged first-run credential flow.
2. No user-facing doc explains the difference between guided setup and recovery-through-settings.
3. No user-facing doc enumerates the advanced provider and service-env fields exposed by Desktop.

### Polish-only

1. `Advanced` is acting as a mixed settings-plus-diagnostics bucket instead of a narrower concept.
2. `Workspace` remains a named concept in settings types without a corresponding visible settings section.

## Bottom Line

Kestrel Desktop already has more first-run capability than the docs suggest. The packaged product can guide provider selection, credential entry, project selection, model-policy editing, service-env configuration, database-mode selection, and recovery from blocked runtime states.

The central packaged UX problem is not lack of capability. It is that two state gates override the ideal first-run funnel:

1. missing provider credentials force recovery before automatic setup
2. any persisted provider key marks setup as complete even when project onboarding never happened

Those are the first repair candidates before any broader onboarding redesign.
