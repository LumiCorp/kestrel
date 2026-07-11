# Tools Control Plane Design

## Summary

Build a unified org-scoped Admin Tools control plane that manages both built-in tools and external integrations used by agents. This replaces the current split between hardcoded tool registration and the narrow bot-focused integrations page.

The immediate trigger is a real product failure in chat `82090159-f8b1-4ead-9b34-8321b6667d26`: the weather tool did not fail at the provider layer. It was stored in the database as a tool call stuck in `approval-requested` state, followed by an empty assistant message. The current implementation hardcodes `needsApproval: true` in the weather tool, which is not appropriate for a low-risk read-only built-in tool.

V1 should treat built-in and external tools uniformly, use a standardized org-wide settings model, and avoid per-agent overrides.

## Goals

- Provide a single admin surface for agent-usable tools.
- Support built-in tools and external providers under the same model.
- Let admins control which tools are enabled for an organization.
- Standardize settings across tools while allowing provider-specific options.
- Centralize approval policy instead of embedding it in individual tool definitions.
- Make runtime availability explicit: enabled, connected, ready, denied, failed.
- Create a clean expansion path for more built-in and OAuth-backed tools.

## Non-Goals

- User-defined arbitrary custom tools in v1.
- Per-agent tool overrides in v1.
- Fully dynamic end-user tool authoring.
- Reworking prompt configuration and agent personality settings as part of this change.

## Product Decision Summary

- Scope: org-wide only in v1
- Coverage: built-in tools and external integrations
- Control style: standardized settings model with provider-specific extensions
- Surface: evolve `Admin > Integrations` into `Admin > Tools`

## Problem Statement

Today, tools are assembled partly through hardcoded application wiring:

- chat route tool injection in `app/api/chats/[id]/route.ts`
- runtime tool assembly in `lib/agent/runtime.ts`
- built-in weather approval policy in `lib/ai/tools/get-weather.ts`

At the same time, the admin integrations page only covers a narrow slice of provider readiness, mainly Discord and GitHub bot runtime state.

This creates several problems:

- admins cannot see all tools agents can use
- harmless built-in tools can be blocked by hardcoded approval policy
- external integration readiness and agent capability exposure are not modeled together
- tool state is not consistently visible in admin
- adding future providers would continue to expand hardcoded paths

## Investigated Failure

The chat investigation found:

- chat row exists in `chats`
- message history exists in `messages`
- the assistant emitted a `tool-getWeather` part in `approval-requested` state
- the tool never reached `output-available`
- a later assistant message was empty

This indicates:

- the failure was not Open-Meteo
- the failure was not geocoding
- the failure was an approval/UI/runtime control issue

The design must therefore move approval policy into a centralized tool configuration layer.

## Approaches Considered

### 1. Evolve `Admin > Integrations` into `Admin > Tools` (Recommended)

Keep a single control plane for inbound adapters, built-in tools, provider connections, and agent-available capabilities.

Pros:

- fits the existing admin information architecture
- avoids splitting connection and capability management
- supports current GitHub and Discord state while expanding the model
- minimizes admin confusion

Cons:

- the existing page name and framing are too narrow and will need migration

### 2. Add a Separate `Admin > Tools` Page

Preserve `Integrations` for inbound adapters and create a distinct capability surface.

Pros:

- conceptually cleaner separation

Cons:

- creates duplicated admin concepts
- forces admins to think about the same provider in multiple places
- complicates navigation and onboarding

### 3. Add Tool Controls Under Agent Config

Keep integrations narrow and place tool toggles under the agent config page.

Pros:

- fastest initial implementation

Cons:

- mixes policy, credentials, and prompt tuning
- does not scale to provider connection workflows
- weak fit for org-scoped operational control

## Recommended Product Model

Introduce three core concepts:

### Tool Providers

System-defined provider entries such as:

- `weather`
- `web_search`
- `search_knowledge_documents`
- `github`
- `discord`
- `slack`
- `notion`

Providers define the source of a set of capabilities and the auth mode they require.

### Tool Connections

Org-scoped connection state for a provider.

Examples:

- built-in provider: a lightweight settings-backed connection row
- OAuth provider: linked Better Auth account or normalized token reference
- API-key provider: reference to admin-managed credential material

### Tool Capabilities

The concrete agent-callable actions exposed from a provider connection.

Examples:

- weather: `get_weather`
- github: `search_repos`, `read_issues`, `create_issue`
- slack: `read_channels`, `post_message`

Capabilities are the runtime unit of enablement and approval policy.

## Standardized Settings Model

Every capability should support the same base settings:

- `enabled`
- `approval_mode`
- `visibility`
- `rate_limit_mode`
- `logging_mode`

Suggested semantics:

- `enabled`
  - capability is exposed to runtime or not
- `approval_mode`
  - `auto`, `ask`, `deny`
- `visibility`
  - whether the capability is visible to all chat modes that can use it
- `rate_limit_mode`
  - `default`, `strict`, `relaxed`
- `logging_mode`
  - `full`, `metadata_only`, `minimal`

Provider-specific settings live alongside the standardized model.

Examples:

- weather
  - units
  - geocoding mode
  - timeout and retry values
- web search
  - allowed domains
  - recency defaults
- GitHub
  - allowed repos
  - write actions enabled
- Slack
  - allowed workspaces and channels
  - posting enabled

## Architecture

### Tool Registry

A system-owned registry defines all supported providers and capabilities.

Registry metadata should include:

- provider id
- capability id
- display name and description
- built-in vs external classification
- auth type
- read/write classification
- default approval policy
- standardized settings defaults
- provider-specific settings schema

This registry is system-defined in v1. Admins do not create arbitrary custom tools.

### Org Tool Config Store

Persistent org-scoped records hold:

- provider enabled state
- capability enabled state
- approval mode overrides
- standardized settings
- provider-specific settings

### Connection Manager

A normalized layer resolves whether a provider is ready for runtime.

Built-ins:

- always system-backed
- may still be disabled or misconfigured

External providers:

- use Better Auth-linked accounts where OAuth is supported
- use admin-managed service credentials where OAuth is not available
- expose normalized readiness status to the runtime and admin UI

### Runtime Tool Builder

Replace hardcoded runtime tool assembly with registry-driven assembly.

Runtime flow:

1. load org tool provider and capability config
2. resolve provider connection readiness
3. filter to enabled and ready capabilities
4. apply centralized approval policy
5. construct the final toolset exposed to the agent

This removes policy decisions from individual tool files.

## Admin UX

### Navigation

Rename `Admin > Integrations` to `Admin > Tools`.

The page remains org-scoped and becomes the single control plane for:

- built-in tools
- external agent integrations
- inbound adapters already represented in admin

### Page Structure

#### Overview Strip

Show summary counts:

- enabled
- connected
- action required

Provide filters:

- all
- built-in
- OAuth
- API key
- inbound adapters

#### Provider Grid or List

One card per provider.

Each card shows:

- enabled or disabled
- connection status
- capability count
- approval summary
- last test result or last error when available

#### Provider Detail View

Each provider detail should include:

- description
- connection section
- capability list
- standardized settings
- provider-specific settings
- test action
- status or audit history

### Example: Built-In Weather Provider

Provider:

- `weather`

Capabilities:

- `get_weather`

Connection state:

- `system`

Settings:

- enabled
- approval mode
- logging mode
- units
- geocoding mode

Default approval mode should be `auto`.

### Example: GitHub Provider

Connection states:

- connected
- missing auth
- env-backed
- degraded

Capabilities:

- search repos
- read issues
- create issue

Settings:

- standardized settings per capability
- allowed repos
- write actions enabled

Write capabilities should default to a stricter approval mode than read capabilities.

## Data Model

Recommended v1 tables:

### `tool_providers`

System catalog row per provider.

Fields:

- `id`
- `key`
- `display_name`
- `kind`
- `auth_type`
- `metadata_json`

### `tool_capabilities`

System catalog row per capability.

Fields:

- `id`
- `provider_id`
- `capability_key`
- `display_name`
- `access_mode`
- `default_settings_json`
- `metadata_json`

### `organization_tool_providers`

Org-level provider state.

Fields:

- `organization_id`
- `provider_id`
- `enabled`
- `connection_status`
- `settings_json`
- timestamps

### `organization_tool_capabilities`

Org-level capability state.

Fields:

- `organization_id`
- `capability_id`
- `enabled`
- `approval_mode`
- `visibility`
- `rate_limit_mode`
- `logging_mode`
- `settings_json`
- timestamps

### `organization_tool_connections`

Normalized external connection state.

Fields:

- `organization_id`
- `provider_id`
- `auth_source`
- `account_id` or `credential_ref`
- `status`
- `metadata_json`
- timestamps

## Runtime Behavior

Runtime rules:

- only org-enabled capabilities are exposed
- built-in and external tools use the same gating model
- approval policy is resolved centrally
- disconnected providers are either omitted or surfaced as typed not-configured states
- empty assistant turns after tool interruptions are treated as a bug

Every tool execution should move through structured states:

- unavailable
- approval required
- running
- succeeded
- denied
- failed

This state model should be consistent in the UI, persistence layer, and runtime events.

## Migration Plan

1. Introduce registry and org config tables.
2. Seed built-in providers and capabilities:
   - `weather`
   - `web_search`
   - `search_knowledge_documents`
   - artifact-related capabilities if worth making configurable
3. Backfill org defaults for existing organizations.
4. Map current GitHub and Discord integration state into the provider model.
5. Replace hardcoded runtime tool assembly with registry-driven assembly.
6. Rename `/admin/integrations` to `/admin/tools` and provide redirects.

## Immediate Product Fix

Before the full control plane lands, weather should be corrected as a low-risk built-in:

- remove hardcoded `needsApproval: true` from `lib/ai/tools/get-weather.ts`
- default weather to org policy `approval_mode=auto` once the new system exists

This addresses the observed chat failure while aligning with the long-term architecture.

## Testing Strategy

### Unit Tests

- registry resolution
- org capability filtering
- approval policy resolution
- provider-specific settings validation

### Integration Tests

- built-in tool enabled and disabled behavior
- approval mode `auto`, `ask`, and `deny`
- provider readiness affecting runtime tool exposure
- organization isolation

### End-to-End Tests

- admin can enable and disable a built-in tool
- admin can configure a provider
- chat respects org tool settings
- weather completes without approval when set to auto
- denied tools show a user-visible explanation
- tool interruption does not produce an empty assistant message

## Expansion Path After V1

Initial expansion set:

- weather
- web search
- search knowledge documents
- GitHub read tools
- GitHub write tools with stronger approval defaults
- Slack
- Notion

Future optional expansion:

- per-agent overrides
- policy templates
- custom tool bundles
- usage analytics and cost views per capability
- admin-run connection test suites

## Open Implementation Notes

- Better Auth should remain the base for org scoping and OAuth-capable providers.
- Service credentials should be normalized behind the same connection abstraction.
- The runtime should consume connection records rather than scattering provider-specific env logic throughout tool registration.
- The admin UI must clearly distinguish:
  - disabled by policy
  - not connected
  - runtime error

## Recommendation

Proceed with a unified Admin Tools control plane in v1, org-scoped only, backed by a system-defined registry and a standardized capability settings model. Use that system to absorb both built-in tools and external integrations, and centralize approval policy so read-only tools like weather are no longer blocked by hardcoded implementation details.
