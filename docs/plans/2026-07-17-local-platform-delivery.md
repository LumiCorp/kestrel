---
id: local-platform-delivery
domain: architecture
status: active
owner: kestrel-runtime
last_verified_at: 2026-07-17
depends_on:
  - ../../ARCHITECTURE.md
  - ../../packages/protocol/README.md
  - ../../packages/sdk/README.md
---

# Local Platform Delivery

## Outcome

Local Core is the only authority for local execution, durable state, runtime
configuration, credentials, and recovery. Desktop, CLI, and the SDK are
authenticated clients; none starts, embeds, or reconstructs another local
runner.

## Delivery Boundaries

1. **Client authority.** Move every CLI and Desktop execution path to the
   versioned Core transport. Runs survive client disconnects and replay through
   durable cursors. `kestrel web` remains an authenticated proxy, not a runner.
2. **Configuration and credentials.** Core owns immutable, secret-free runtime
   configuration generations and redacted credential status. Desktop sends a
   registered profile reference, never an inline runtime profile, and never
   receives raw credentials. Keychain activation, plaintext migration, and
   removal of Desktop's child runner ship as one cutover.
3. **State and recovery.** PGlite is the default local store in the 0.6 state
   epoch; external Postgres is explicit and never mutated by local recovery.
   Reset/restart share a serialized maintenance boundary, require confirmation,
   archive only canonical Core state, and preserve 0.5 state.
4. **Product lifecycle.** Deliver a private, pinned runtime with signed macOS
   installation, staged activation, health checks, update, rollback, uninstall,
   and no source-tree or system-Node requirement. Remove legacy bundled
   services only after all clients are cut over.

## Milestones And Exit Criteria

| Milestone | Exit criteria |
| --- | --- |
| Core client cutover | CLI, Desktop, and local SDK use Core for execution and evidence reads; no client owns a runner or store. |
| Credential activation | Credential writes are Core/Keychain owned, diagnostics are redacted, and the Desktop child runner is removed. |
| Lifecycle release | Signed install/update/rollback/uninstall works on a clean machine and legacy services are removed. |

## Invariants

- Local access is user-only, authenticated, scoped, revocable, and redacted.
- Equivalent local and hosted executions preserve protocol, result, approval,
  evidence, and cursor semantics.
- A fresh 0.6 state epoch never mutates 0.5 state.
- Maintenance does not race active executions, in-flight evidence reads, or
  runtime-configuration writes.

## Validation

- Focused protocol, lifecycle, credential, and recovery tests per milestone.
- Clean-machine install, update, rollback, and uninstall evidence before release.
- `pnpm run governance:check`, `pnpm run test`, and `pnpm run test-proofs:check`.
