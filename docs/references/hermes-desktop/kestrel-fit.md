---
id: hermes-desktop-kestrel-fit
domain: docs
status: active
owner: kestrel-agent
last_verified_at: 2026-06-02
depends_on: [../../index.md, ./feature-inventory.md, ./ui-map.md, ./ux-review.md]
---

# Hermes Desktop Fit For Kestrel

See also: [Docs index](../../index.md).

Source repo: `fathah/hermes-desktop`

Audited commit: `1b16ef33c82a594207e346655da4f35193cb3e43`

Audit mode: code-grounded repo review. This fit analysis is based on implemented Hermes Desktop surfaces and Kestrel's current contract-first runtime goals, not on a live fork or integration experiment.

## Bottom Line

Hermes Desktop is useful as a reference app for desktop information architecture, onboarding flow, and operator tooling. It is not a good direct implementation template for Kestrel's runtime layer.

The strongest reusable value is in the shell UX. The weakest fit is in the runtime coupling model. Hermes Desktop assumes direct ownership of an upstream install directory, edits runtime config files in place, and uses several hard-coded catalogs plus heuristic affordances that do not align well with Kestrel's deterministic, contract-driven posture.

## Best Reuse Candidates

### 1. Onboarding flow

Hermes Desktop has a solid progression:

1. splash
2. install detection
3. guided install
4. provider setup
5. main shell

That is a strong pattern for a future Kestrel desktop product, especially if Kestrel needs to bridge:

- local bootstrap
- runtime readiness
- provider configuration
- workspace or profile selection

### 2. Sidebar shell and screen partitioning

The single-window shell with a stable left nav is a good reference for Kestrel because it separates operator concerns cleanly:

- active work surface
- history
- profiles/workspaces
- configuration
- operations

Kestrel could reuse the high-level IA without copying the exact categories.

### 3. Session browser

The session list plus local cache is one of the more directly portable ideas:

- grouped recency buckets
- local cache for fast rendering
- generated fallback titles
- full-text search path

For Kestrel, the same idea should be driven from Kestrel-owned runtime records, not from a borrowed SQLite shape.

### 4. Memory and settings structure

The Hermes Memory screen is a strong reference for how to make a complicated concept feel manageable. The split between:

- built-in entries
- user profile
- external providers

is clean and teachable.

Likewise, Hermes Settings shows that operators want:

- health/doctor actions
- logs
- backups
- upgrade controls
- network overrides

That is directionally valuable for Kestrel.

## Partial Reuse Candidates

### 1. Chat surface

Hermes Chat is a good reference for:

- streaming display
- tool progress
- token usage
- model picker placement options
- empty-state suggestion prompts

But Kestrel should not copy the slash-command or approval behavior blindly.

### 2. Profiles

Hermes profiles are a useful analog for isolated operator contexts. Kestrel could reuse the card-based comparison model if Kestrel's equivalent concept is:

- workspace profile
- runtime profile
- operator persona
- environment preset

The naming and semantics should stay Kestrel-native.

### 3. Model library

A saved model library with chat-picker integration is worth borrowing. The risky part is Hermes' heavy dependence on hard-coded provider lists and manual model IDs.

For Kestrel, any model-selection UX should stay grounded in explicit provider/runtime contracts.

## Poor Fits For Kestrel

### 1. Direct config-file mutation as the product contract

Hermes Desktop edits:

- `.env`
- `config.yaml`
- `MEMORY.md`
- `USER.md`
- `SOUL.md`
- `models.json`
- `cron/jobs.json`

That is a pragmatic shell for Hermes, but it is not the right default shape for Kestrel if Kestrel wants stronger runtime invariants, deterministic replay, and explicit state transitions.

Kestrel should prefer typed contracts and owned persistence boundaries over regex-based or line-based file mutation.

### 2. Hard-coded capability catalogs

Hermes Desktop hard-codes:

- providers
- local presets
- toolsets
- gateway platforms
- settings env fields
- deliver targets

That can work for a fast-moving shell around a known upstream project. For Kestrel, this becomes dangerous when the UI drifts from runtime truth.

Kestrel should prefer contract-backed capability discovery where possible.

### 3. Heuristic approval detection

Hermes Desktop shows approve/deny controls when assistant text matches a regex. That conflicts directly with Kestrel's preference for explicit runtime evidence and contract-driven control flow.

If Kestrel needs approval UX, it should come from structured runtime events.

### 4. Uneven connector/runtime symmetry

Hermes Desktop's broad connector UI is inspiring, but the gateway toggle implementation is narrower than the surface suggests. Kestrel should not copy a pattern where the UI advertises more control symmetry than the runtime actually provides.

## Kestrel-Specific Recommendations

### Use Hermes Desktop as a shell reference, not a runtime reference

Good areas to study:

- app-state funnel
- shell navigation
- operator tooling layout
- session browser
- settings affordances
- desktop notifications and updater placement

Do not treat it as the model for:

- runtime state ownership
- durable config mutation
- approval semantics
- connector discovery
- contract enforcement

### Prefer Kestrel-native contracts underneath any borrowed UX

If Kestrel adopts comparable screens, each should hang off explicit Kestrel contracts:

- session detail feed
- task / run status
- model capability records
- approval state
- integration manifests
- automation definitions

That keeps the UI honest and preserves replayability.

### Keep the operator shell narrower at first

Hermes Desktop ships a very broad set of screens. Kestrel would likely benefit from a tighter first pass:

1. primary work surface
2. sessions/history
3. runtime/settings
4. logs/diagnostics
5. optional profiles/workspaces

Connector marketplaces, giant secret-management forms, and broad schedule catalogs should wait until Kestrel has equally strong runtime backing.

## Suggested Kestrel Follow-Up Work

### Near-term

- Use Hermes Desktop as inspiration for a Kestrel desktop IA sketch.
- Extract the strongest patterns into a Kestrel-specific shell proposal:
  - onboarding
  - navigation
  - chat/task surface
  - session browser
  - operations/settings

### Medium-term

- Define the contract-backed Kestrel equivalents for:
  - session metadata
  - approval events
  - model library records
  - automation records
  - integration manifests

### Do not do first

- Do not start by cloning Hermes Desktop's config-editing approach.
- Do not start by mirroring its connector count.
- Do not start by porting its heuristics into Kestrel runtime behavior.

## Decision

Recommended stance: use Hermes Desktop as a strong desktop-shell reference and a weak runtime-architecture reference.

That is the useful framing for Kestrel:

- borrow the operator-facing shell ideas
- reject the heuristic and config-file-driven runtime patterns
- rebuild any adopted surface on Kestrel-native contracts
