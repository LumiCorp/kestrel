# Persist the exact tool invocation before approval

## Useful outcome

Every new hosted tool approval durably identifies the executable command before
the user sees an approval card. Kestrel can prove that the pending request owns
one normalized action and stable authority without depending on run-local
credentials.

This is the expansion slice. It introduces the versioned prepared-approval
contracts, dormant remembered-approval storage, and typed evidence needed for
exact execution and safe migration. It does not switch old interactions to a
new execution path or honor remembered approval.

## What changes

Prepare and normalize approval-gated tool calls before the reference agent
enters the approval wait. Persist or durably reference the resulting
`PreparedToolCallV1` in runtime interaction state. The pending approval must
point to that prepared invocation instead of storing metadata from which a
later run must reconstruct it.

Add a versioned stable authority fingerprint. It must contain immutable actor,
tenant, project, thread, resource, policy, capability, descriptor, and
normalized-action authority. It must exclude continuation run IDs, sessions,
MCP grants, project-context grants, workspace leases, source-write grants,
execution tickets, expiries for renewable grants, and pinned handler instances.
Keep those execution requirements explicit beside the stable authority.

Define `StableToolApprovalIdentityV1` with `toolId`,
`descriptorContractRevision`, and `approvalAuthorityRevision`. The identity
must not contain a payload hash, invocation ID, run ID, session, grant, lease,
or other renewable credential.

Define the strict versioned hosted decision vocabulary as `decline`,
`approve_once`, or `remember_approval`. This issue establishes the contract but
does not expose Remember Approval in the product; the remembered behavior and
producers belong to issue 03.

Define `RememberedToolApprovalV1` with `version`, `id`, `organizationId`,
`threadId`, `actorUserId`, `toolIdentity`, `sourceInteractionId`, and
`createdAt`. Add its PostgreSQL table, complete stable-identity uniqueness, and
thread-cascade deletion. Add strict data access and a typed host-to-runtime
evidence projection, but do not write records from approval responses or honor
the evidence in policy resolution yet.

The typed evidence must carry organization, current project and Environment
authority derived from the owning thread, actor, thread, stable tool identity,
and source interaction. Runtime parsers must accept an empty evidence set so
CLI, Desktop, TUI, and old hosted producers remain compatible without
persisting hosted remembered approvals.

Version the hosted approval interaction and external binding so the binding
names the prepared invocation identity as approval authority. Keep the exact
normalized payload, authenticated actor authority, capability, thread, and
expiry bindings. Run IDs remain execution and audit facts.

Keep `RunnerExternalApprovalBindingV1` semantics and parsing for old
interactions. Represent the new prepared-invocation authority through a
separately discriminated version. Do not reinterpret stored version-1 bindings
in place.

Persist the new version additively. Old pending interactions must continue to
parse through their existing version and must never be silently upgraded.
Strict parsers must reject incomplete or mixed-version authority.

## Requirements and delivery context

The canonical requirements are in the [Hosted Approval Simplification Product Brief](../../hosted-approval-simplification-product-brief.md).

Start from revision `b36756002321b7a7e942d9a08799e7b01fa387f3` or a verified
descendant. The current seams include:

- `PreparedToolCallV1` and `ToolExecutionOutcomeV1` in
  `src/kestrel/contracts/tool-invocation.ts`.
- Prepared-call creation and scope fingerprinting in
  `src/io/ToolInvocationSupport.ts`, `src/io/ToolGateway.ts`, and
  `tools/runtime/UnifiedToolRegistry.ts`.
- `RunnerExternalApprovalBindingV1` in `packages/protocol/src/approvals.ts`.
- The pre-execution approval wait in
  `agents/reference-react/src/steps/acter/policyGates.ts`.
- Runtime state, effect persistence, and prepared-call parsing in
  `src/runtime`, `src/effects`, and `src/kestrel/contracts/store.ts`.
- Remembered persistence and hosted evidence seams in
  `apps/web/drizzle/schema.ts`, versioned Web migrations,
  `apps/web/lib/turns/store.ts`, `tools/contracts.ts`, and protocol execution
  profiles.

Reuse these contracts and stores. Do not add a second resume envelope, another
scope snapshot, a field-by-field credential-rotation allowlist, or heuristic
identity matching. Preserve generic non-tool waits and existing old-version
behavior until the final contract issue removes it.

## Done when

- A new-version approval request persists one parseable `PreparedToolCallV1`
  before the wait and can reload it after process restart.
- Approval-card projection for the new version reads the persisted prepared
  invocation and does not build a second action or payload snapshot.
- The pending approval and external binding identify that prepared invocation,
  exact payload, actor authority, capability, thread, and expiry.
- Stable authority and `StableToolApprovalIdentityV1` are deterministic and
  exclude every renewable credential named above.
- Changing a renewable credential does not change stable authority, while
  changing normalized input, actor authority, thread, descriptor revision, or
  approval-authority revision does.
- Old approval interactions still parse only through their old version, and
  malformed or mixed versions fail closed.
- The additive remembered-approval migration enforces exact uniqueness and
  thread-cascade deletion; storage and evidence parsers round-trip without any
  active product writer or policy effect.
- CLI, Desktop, and TUI accept the versioned shared contracts with no remembered
  evidence and retain their current behavior.
- Focused shared-contract, policy-gate, persistence, replay, and mutation-proof
  tests pass.
- `pnpm validate`, `pnpm validate:process`, and `pnpm validate:postgres` pass.
