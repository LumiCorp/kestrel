# Prove the hosted rollout and remove legacy approval paths

## Useful outcome

Production uses one tested hosted approval architecture. Operators can prove
the browser decision, durable state, credential refresh, worker execution,
provider consumption, and terminal effect outcome before deleting the
reconstruction system and incident repairs it replaces.

This is the contract slice. It completes migration and removes compatibility
only after no old interaction can use it.

## What changes

Extend the hosted approval canary into a full browser-to-effect acceptance path.
It must first prove the dedicated hosted policy pack, effective
`exec_command` visibility, and no-spend exact-tool preflight. It must cover
Decline, Approve Once followed by another ask, Remember Approval followed by
automatic later calls, and a new thread that asks again. It must also prove a
truthful policy-hidden terminal result without another model call; cross-user,
cross-project, cross-Environment, and stale-tool isolation; same-actor
enforcement; credential rotation; worker and registry restart; expiry;
provider one-time consumption; effect-not-started failure; unknown effect
handling; and nonzero telemetry when cancellation follows model work.

The canary must compare the card's server-owned request with the persisted
prepared invocation, approval binding, and consuming execution. Request ID,
prepared invocation ID, stable tool identity, normalized action, payload hash,
actor, organization, project, Environment, thread, and approval-authority
revision must match. A rendered `Approved` state is not execution proof.

Add production-safe telemetry for approval version, decision, stable tool
identity revision, policy result, remembered-evidence match or rejection,
credential refresh, model usage, validation rejection, cancellation reason,
execution outcome, and compatibility-path use. Do not log payloads,
credentials, prompts, or provider secrets.

Deploy issue 01's additive database migration and empty-evidence parsers before
any new writer. Deploy compatible shared runtime and turn-worker readers before
the Web and Mobile producers from issue 03. Run the full hosted proof against
the inactive new protocol path, then activate the new Web writer last. Old
interactions must finish on their old path or expire safely. New requests must
never fall back silently to reconstruction.

After telemetry shows zero old consumers for the maximum configured
old-interaction lifetime plus one complete worker rollout cycle, remove:

- Approval-specific `blockedToolScope` creation and propagation.
- `resolveBlockedResumeScope`, grant-ID omission comparison, and blocked static
  rehydration used only by approvals.
- Rebuilt-call execution, original-run rebinding, and approval-specific
  `preparedRunId` handling.
- Legacy Web `approvalResponse` parsing and boolean-only Runtime and Mobile
  responses.
- Old `Always Approve` policy-return compatibility code and tests.
- Independent app-operation decision transitions retained only for old rows.
- The tactical project-context execution fallback after no old path consumes
  it.
- `reconcile-hosted-approval-incident.ts`, its command, and its test after every
  target row has a recorded terminal state.
- Version-1 scope-fingerprint parsing and obsolete implementation-detail tests
  after no stored interaction or active runtime package can carry that version.

Keep generic `resumeBlockedRun`, generic `resumeRequestId`, exact payload
normalization, live-run handler pinning, consume-before-provider atomicity,
`ToolExecutionOutcomeV1`, and fail-closed behavior for expired, changed, or
unrebindable invocations.

## Requirements and delivery context

The canonical requirements are in the [Hosted Approval Simplification Product Brief](../../hosted-approval-simplification-product-brief.md).

The completed user experience from
[issue 03](03-remember-thread-tool-approval.md) and canonical lifecycle from
[issue 04](04-canonicalize-approval-lifecycle.md) remain the approval
foundation. The effective hosted tool decision from
[issue 06](06-unify-hosted-tool-decision.md) and cancellation evidence from
[issue 07](07-preserve-cancellation-telemetry.md) must be complete before this
issue can finish production qualification or contract legacy paths.

Current compatibility and proof surfaces include
`apps/web/scripts/github-approval-canary.ts`,
`apps/web/scripts/reconcile-hosted-approval-incident.ts`, Web and Mobile request
contracts, `InteractionManager`, `ThreadRuntime`, `ExecutionEngine`,
`UnifiedToolRegistry`, app-operation migrations, and their contract and
PostgreSQL tests.

Removal evidence must be executable and retained with the change. A focused
source-regex test, successful process startup, or UI `Approved` label is not
end-to-end execution proof. Do not remove unrelated generic continuation or
provider-consumption behavior.

## Done when

- The full hosted canary proves browser decision, PostgreSQL persistence,
  authenticated actor transport, credential refresh, worker execution,
  provider consumption, and terminal effect projection for every defining
  scenario above.
- The canary proves `exec_command` is visible under the real hosted profile,
  policy-hidden tools terminate truthfully without correction retries, and an
  unavailable exact tool fails before model spend.
- Production cancellation evidence preserves nonzero usage, validation
  rejection, cost, and terminal reason after model activity.
- Mixed-version tests prove old interactions finish or expire safely and new
  interactions never reconstruct or silently downgrade.
- CLI, Desktop, and TUI parse the final shared contracts with no hosted
  remembered evidence and retain their existing approval behavior.
- Production telemetry exposes every compatibility consumer without leaking
  sensitive data.
- Zero-consumer evidence covers the maximum old-interaction lifetime plus one
  complete worker rollout cycle before deletion begins.
- Every listed legacy path, duplicate transition, temporary bridge, incident
  command, and obsolete test is removed after its drain condition passes.
- Generic blocked-run resume, live-run pinning, exact normalization,
  consume-before-provider behavior, and effect outcomes remain covered and
  unchanged in purpose.
- Release notes and the hosted approval operating guidance name migration
  order, rollback boundary, observation evidence, terminal incident status, and
  final production units: PostgreSQL, Web, Mobile, shared profile, protocol,
  agent and runtime packages, and turn-worker.
- The complete hosted acceptance suite passes after cleanup with no legacy
  compatibility consumer.
- `pnpm validate`, `pnpm validate:postgres`, `pnpm validate:process`, and
  `pnpm validate:audit` pass.

## Depends on

- [Make hosted tool availability and approval one truthful decision](06-unify-hosted-tool-decision.md)
- [Preserve completed model telemetry when a run is canceled](07-preserve-cancellation-telemetry.md)
