# Kestrel Browser App Design Notebook

## Current Position

Build `built_in.browser` as a small Kestrel wrapper around a replaceable browser
engine.

Kestrel owns the tools, domain policy, Thread isolation, takeover, and artifacts.
The engine opens pages and performs actions. Existing Kestrel tool preparation,
exact-effect, result, and artifact contracts do the rest.

The design does not need separate Browser Action or Browser Evidence systems.
It does not need separate navigation and resource grant types in v1.

## Requested Change

Support four scenarios:

- Test a Desktop localhost application.
- Test a published Kestrel Edge preview.
- Operate a public website allowed by App policy.
- Let a person take over for passwords, SSO, passkeys, or MFA, then return
  control to the agent.

## Starting Sources

- User-supplied `Kestrel Browser App v1` plan.
- `ARCHITECTURE.md` and `SECURITY.md`.
- `packages/protocol/src/apps.ts`.
- `tools/contracts.ts` and `tools/runtime/UnifiedToolRegistry.ts`.
- `src/kestrel/contracts/tool-invocation.ts`.
- `src/engine/ExecutionEngine.ts`.
- Hosted App catalog, tool registry, App transport, and relay code.
- agent-browser release and security documentation.

## Relevant Current Behavior

Kestrel already has the main control plane this App needs:

- a shared first-party App and tool registry;
- a `SharedToolContext` for host services;
- policy and approval resolution before tool execution;
- durable prepared invocations and exact effect handling;
- normalized tool results and artifact references;
- Desktop Local Core and hosted runner authority.

Prepared invocations contain exact effective tool input. Browser actions should
use that existing contract. Browser-specific persistence must not duplicate it.

The hosted App relay is useful for bounded control requests. It is not suitable
for live frames or large screenshots and downloads.

## Affected Surface

- Shared App identity and browser tool descriptors.
- `SharedToolContext` and one `BrowserServicePort`.
- Minimal browser session storage with the resolved domain policy revision.
- Desktop engine packaging, launch, and viewer IPC.
- Hosted browser worker lifecycle and viewer routes.
- Existing Thread attachment and artifact storage.

## External Research

agent-browser remains too broad to expose directly. Its security controls are
opt-in, and its MCP surface includes capabilities Kestrel does not want to give
the model.

Its domain allowlist applies to navigation and page resources. This may cause a
page to fail until App policy allows all required destinations. That limitation
is acceptable for a strict v1 and does not justify a second policy model yet.

Exact agent-browser and Chrome versions belong in a checked-in release manifest,
not the stable Browser App contract.

## Candidate Seams and Options

### Raw agent-browser MCP

Rejected. It exposes the engine contract and cannot own Kestrel policy, Thread
isolation, takeover, or artifacts.

### First-party Browser App

Selected. Stable Kestrel tools call `BrowserServicePort`. Desktop and hosted
provide different implementations behind the same interface.

### New browser-specific action and evidence systems

Rejected. Existing prepared tool calls, effects, normalized results, events,
and artifacts already own those responsibilities.

## Proposed Delta

Register `built_in.browser` and expose a narrow set of `browser.*` tools: open,
request grant, snapshot, inspect, navigate, interact, tabs, capture, upload,
download, takeover, and close.

Add `BrowserServicePort` to `SharedToolContext`. It receives a prepared browser
operation and returns a normal Kestrel tool result.

Keep one browser session per Thread. Persist only the browser-specific facts
needed across requests:

- session ID;
- Thread ID;
- mode and lifecycle state;
- engine revision and generation;
- resolved domain allowlist and revision;
- timestamps, expiry, and terminal reason.

Use one domain rule: every browser network request must match the effective App
allowlist. Environment policy sets the maximum and Project policy may narrow it.
The effective list combines preconfigured domains with the person's remembered
domain grants. The rule applies to navigation, redirects, scripts, images,
requests, workers, sockets, and beacons.

The allowlist is the authorization. If a destination is allowed, the agent may
open it, navigate, interact, and capture screenshots without an approval card.
This remains true when the destination is new to the current session. If a
destination is not allowed, `browser.request_grant` canonicalizes it to one
tenant-bounded wildcard and asks the person once to allow and remember it.

If approved, Kestrel persists the domain in the person's Browser App allowlist,
updates the active session's allowlist revision, and continues. Future browser
sessions for that person include the domain automatically. If the domain is
already allowed, `browser.request_grant` returns `already_allowed` without an
approval interaction. If Environment or Project policy forbids the destination,
the request is blocked and approval cannot expand that ceiling. Remembered
domains are visible and revocable in Browser App settings.

Uploads and download promotion retain their existing explicit approval because
they cross the Thread file boundary. Human takeover remains an explicit control
change, not a domain approval.

Use existing prepared invocations and exact-effect handling for navigation and
interaction. Do not add a durable `BrowserAction` entity. A timeout after
dispatch reports an unknown outcome and is not retried.

Use existing normalized tool results and Thread artifacts for snapshots,
screenshots, and downloads. Do not add a durable `BrowserEvidence` entity.

Agent-entered ordinary text follows the existing tool-input contract. Durable
presentations and logs redact fill/type values. Passwords, one-time codes,
passkeys, and other authentication values must be entered during human
takeover, never through `browser.interact`.

Desktop launches one clean browser process and temporary profile per Thread
session. Hosted launches one isolated browser worker per Thread session. Engine
loss closes the session; Kestrel does not restore cookies or repeat uncertain
actions.

## Domain Model

- **Browser App:** the Kestrel-owned tool and product capability.
- **Browser engine:** the replaceable program that drives Chrome.
- **Browser session:** one browser process or worker owned by one Thread.
- **Domain allowlist:** the effective App policy that authorizes browser network
  destinations.
- **Remembered domain:** a tenant-bounded wildcard that a person approved once
  and that Kestrel includes in their future Browser App sessions.
- **Takeover:** exclusive human input control. Takeover input is not tool data.

Invariants:

- A browser session never crosses a Thread.
- A request never escapes the session's effective domain allowlist.
- Agent actions stop while a person has control.
- Authentication input never enters tool calls or durable logs.
- Engine loss is terminal.
- Unknown action outcomes are never retried automatically.

## Decisions

- Use a first-party Browser App, not raw MCP. Confidence: high.
- Keep the browser engine replaceable. Confidence: high.
- Reuse Kestrel's current approval, effect, result, and artifact contracts.
  Confidence: high.
- Keep one session per Thread. Confidence: high.
- Use the effective App allowlist for every browser request in v1. Confidence:
  high.
- Treat allowlisted destinations as already authorized for navigation,
  interaction, and screenshots. Confidence: high.
- Do not show browser approval cards for allowlisted destinations, including
  destinations new to the session. Confidence: high.
- Keep `browser.request_grant` as an allow-and-remember operation for a domain
  not yet on the person's allowlist. Confidence: high.
- Apply an approved remembered domain to the active session and future sessions
  without asking again. Confidence: high.
- Require human takeover for authentication input. Confidence: high.
- Keep one isolated hosted worker per session for the initial design.
  Confidence: medium.

## Active Change Frontier

- No product decision blocks the Product Brief.

## Decision Map

- Status: not needed
- Path: none
- Destination: none
- Return condition: none

## Best Next Move

Create the canonical Product Brief. Remembered domains are personal across an
Environment, and Project policy may narrow them.
