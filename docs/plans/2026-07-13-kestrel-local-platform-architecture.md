---
id: kestrel-local-platform-architecture
domain: architecture
status: active
owner: kestrel-runtime
last_verified_at: 2026-07-13
depends_on:
  - ../../ARCHITECTURE.md
  - ../../packages/protocol/README.md
  - ../../packages/sdk/README.md
  - ../adr/0004-runtime-simplification-boundaries.md
---

# Kestrel Local Platform Architecture

Kestrel 0.6 will make Local Core the sole authority for local execution. The CLI, Desktop application, SDK, and trusted server-side web integrations will be clients of Core instead of embedding, launching, or reconstructing independent runtimes. Local Core will own sessions, runs, approvals, event history, tools, evidence, scheduling, extensions, and durable state. A shared host-only runtime engine will provide the same execution behavior to Local Core and the hosted runner, while clients communicate through the versioned execution protocol and a separate local control API.

The transition is intentionally split into ordered milestones. The execution-contract milestone establishes the authoritative terminal result, including `assistantText` and an independent structured payload. The execution-authority milestone hosts that contract in Local Core, adds PGlite-backed durable event replay, and moves each local client onto the Core transport. The platform-lifecycle milestone then turns the topology into an installable product through a persistent service, client registration, signed versioned artifacts, staged activation, health checks, rollback, and a private pinned runtime. Existing 0.5 state remains untouched; 0.6 begins in a fresh state epoch, uses embedded PGlite by default, and retains external Postgres as an explicit advanced deployment mode.

The first implementation PR for execution authority is deliberately a substrate, not the completed client cutover. It adds the shared runner host, Core-owned runtime/store binding, durable protocol journal, local SDK transport, authority and shutdown invariants, and 0.6 state isolation. Follow-up PRs must migrate CLI and Desktop execution onto that boundary before the execution-authority milestone can be called complete. Packaging, updater, launchd, client credentials, scheduling replacement, and removal of legacy bundled services remain in the platform-lifecycle milestone.

The CLI cutover is the next bounded authority slice. Interactive, job, and operator commands use the authenticated Core transport with explicit actor metadata; execution commands continue after client disconnection. `kestrel web` is an auth-translating TCP proxy to Core rather than another runner host, and replay, doctor, and bundle commands query Core-owned evidence instead of opening a client-selected store. Desktop remains a separate follow-up because its provider credentials and runtime settings must become Core-owned before its child runner can be removed safely.

The SDK now requires every client to select an explicit local or remote target; environment discovery and legacy top-level connection options are no longer part of the public contract. Desktop migration proceeds through two reviewable prerequisites before its behavior changes. First, shared client plumbing gives Desktop a reusable Unix-socket transport and a Core-owned registered profile reference, so the UI can shape requests without sending an inline runtime profile. Second, Core-owned configuration and credential resolution supplies an immutable runtime environment without exposing secrets back to Desktop. Only after both prerequisites land does Desktop replace its managed child runner with the Local Core transport, preserve runs across client disconnects, and stop mutating Core-owned storage directly.

Credential storage and Desktop cutover form one activation boundary even when their substrate is reviewed separately. Local Core may gain typed credential-store and explicit-environment abstractions ahead of the cutover, but plaintext migration, rejection of legacy secret fields, and secure credential activation must not strand the existing Desktop child runner. No control API will lease raw credentials back to a client merely to preserve that temporary execution path.

## Target Topology

```text
CLI / Desktop / SDK / trusted web integrations
                       |
                       v
                  Local Core
                       |
                       v
             Shared runtime engine
                       |
                       v
       Persistence, tools, models, extensions
```

## Goal Completion Signals

- CLI, Desktop, and the local SDK submit execution through Local Core; none launches or embeds a separate local runner.
- Local Core and the hosted runner implement the same execution protocol, terminal-result parser, capability handshake, and cursor semantics.
- Equivalent local and remote workloads produce equivalent sessions, approvals, events, `assistantText`, structured payloads, and evidence.
- PGlite is the default local store, external Postgres passes the same store contract, and the 0.6 state epoch never mutates 0.5 data.
- Runs continue after client disconnects, resume from durable cursors, and recover at committed safe boundaries after Core restarts.
- Local access is confined to a user-only Unix socket with scoped, revocable credentials and redacted diagnostics.
- Browser integrations remain server-mediated, and the SDK selects an explicit local or remote target.
- Signed macOS artifacts install, activate, health-check, update, roll back, and uninstall without a source tree or system Node dependency.
- Protocol, persistence, concurrency, recovery, security, packaging, governance, prompt, and release-evaluation gates pass.
