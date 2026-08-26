# Hosted Approval Simplification Product Brief

## Product Narrative

Kestrel users can allow tools to run automatically, require approval before
execution, or block execution through Environment and Project policy. The
current hosted approval implementation does not preserve that model cleanly.
It asks before a durable executable command exists, reconstructs the tool call
after the user responds, and mixes stable approval authority with credentials
that normally change while the request waits.

This composition has caused valid approved work to fail when run IDs, MCP
grants, project-context grants, leases, or pinned handlers change. The Web layer
also offers an `Always Approve` action that changes broad Environment policy
instead of remembering the user's choice inside the current thread.

Kestrel must suspend one already prepared tool invocation and resume that exact
invocation after approval. Environment and Project policy remain Automatic,
Ask First, or Blocked. When an eligible Ask First decision is required, the
approval card must offer Decline, Approve Once, and Remember Approval.

Remember Approval approves the current exact invocation and remembers the tool
for that authenticated user for the life of that thread. Later calls to the
same stable tool run automatically for approval purposes, but each call is
newly prepared, validated, executed, and audited. Remember Approval does not
change Environment or Project policy and does not approve a future payload.

## Outcomes and Delivery Boundary

This initiative must produce these outcomes:

- Hosted approval suspends one durable `PreparedToolCallV1` before execution.
- Approval resumes that same prepared invocation instead of reconstructing it.
- Eligible Ask First cards show Decline, Approve Once, and Remember Approval.
- Approve Once applies only to the current invocation.
- Remember Approval applies to the same authenticated user, thread, and stable
  tool identity for the life of the thread.
- Later remembered calls receive fresh preparation, credential validation,
  execution, outcome tracking, and audit evidence.
- Blocked and stricter approval requirements remain fail-closed.
- The authenticated deciding actor reaches runtime and must match the actor
  allowed to approve the invocation.
- `thread_interactions` becomes the canonical human-decision record.
- Provider-specific records retain payload and one-time consumption duties but
  stop owning a competing approval decision.
- Obsolete reconstruction, policy-detour, duplicate-lifecycle, and incident
  compatibility code is removed after explicit drain gates pass.

The delivery boundary includes hosted Web and Mobile approval, shared approval
contracts, runtime policy resolution, durable interaction state, PostgreSQL
persistence, queue and worker transport, tool execution, provider consumption,
effect outcomes, migration, compatibility, observability, and cleanup.

This initiative does not:

- Change the meaning of Environment or Project Automatic, Ask First, or
  Blocked.
- Add a fourth Environment policy mode.
- Add a remembered-approval list, Forget action, or user-managed revocation
  workflow.
- Share remembered approval between users, threads, projects, or environments.
- Reuse the normalized payload or approval identity of an earlier invocation.
- Let remembered approval override a disabled capability, Blocked policy,
  subject restriction, tool-minimum approval, explicit runtime strictness, or
  missing actor access.
- Redesign generic user-input waits, recovery choices, or non-approval blocked
  runs.
- Replace consume-before-provider atomicity, effect-state reporting, or exact
  payload normalization.
- Make the tactical project-context bridge the final architecture.

## Defining Scenarios

### A user declines an Ask First request

Kestrel prepares and persists the exact invocation before showing the card. The
authenticated user chooses Decline. Kestrel records the denial in the canonical
interaction transaction. The tool does not execute and no remembered approval
is created.

### A user approves one invocation

Kestrel prepares and persists the exact invocation. The authenticated user
chooses Approve Once. Kestrel records that exact decision, refreshes renewable
credentials, validates their authority, and executes the persisted prepared
call. A later invocation of the same tool in the same thread asks again when
policy still resolves to eligible Ask First.

### A user remembers a tool for the thread

Kestrel prepares and persists the exact invocation. The authenticated user
chooses Remember Approval. One transaction records the current exact decision
and one `RememberedToolApprovalV1` record.

Kestrel executes the current prepared call after refreshing and validating its
credentials. For later calls, Kestrel prepares a new invocation and resolves
current policy. If policy still yields eligible Ask First and the stable tool
identity matches, remembered evidence satisfies the ask. Kestrel executes and
audits the new call without showing another approval card.

The remembered record lasts until the thread is deleted. The product does not
offer a listing or Forget action.

### The same user starts a new thread

The remembered record from the first thread does not match the new thread. If
policy resolves to Ask First, Kestrel shows the three approval choices again.

### Another user invokes the same tool

Another project member cannot consume the first user's remembered approval.
Kestrel evaluates policy and approval for the authenticated invoking user. The
same-actor approval rule remains in force unless delegated approval is designed
separately.

### The tool or its approval authority changes

A descriptor contract revision or approval-authority revision creates a new
stable tool identity. An older remembered record does not match. Kestrel asks
again when current policy yields eligible Ask First.

### Policy becomes stricter

Blocked policy, disabled capability, subject restriction, tool-minimum
approval, explicit runtime strictness, or lost actor access takes precedence.
Remembered evidence cannot authorize execution. The record can remain until
thread deletion because every invocation reevaluates current policy and access.

If broad policy changes to Automatic, Kestrel does not need remembered evidence.
If policy later returns to eligible Ask First in the same thread, the existing
thread-lifetime record can satisfy the ask when its user and stable tool
identity still match.

### Credentials rotate while approval waits

The prepared invocation retains immutable action and authority. After approval,
Kestrel reacquires the run segment, grants, leases, execution tickets, and live
handler capability. Runtime validates each credential against the prepared
invocation's stable authority before execution. Credential rotation does not
change what the user approved.

### Runtime cannot rebind or prove the effect state

If a dynamic provider cannot rebind the stable descriptor identity, Kestrel
does not execute the invocation. If an external effect may have started,
Kestrel records `unknown` and does not retry as though nothing happened. A retry
is allowed only when `ToolExecutionOutcomeV1` proves that the effect did not
start.

### An old approval is still pending during migration

Old and new approval interactions carry explicit versions. New requests use
the prepared-invocation and three-way-decision path. Existing old requests
finish through the old compatibility path or expire safely. Kestrel never
silently converts an old pending interaction into the new authority model.

## Business and Process Requirements

- Environment and Project policy must continue to expose Automatic, Ask First,
  and Blocked.
- An eligible Ask First approval card must show exactly Decline, Approve Once,
  and Remember Approval.
- The product must not label a broad Environment policy mutation as a response
  to one thread approval.
- Remember Approval must last for the life of the thread without adding a
  remembered-approval management surface.
- Deleting the thread must delete its remembered approvals.
- Approve Once must ask again for the next eligible invocation.
- Remember Approval must stop repeated eligible prompts for the matching tool
  and user in the matching thread.
- Starting another thread must require a new remembered decision.
- Users must not receive execution success when only the continuation run has
  started. Success must follow the actual tool outcome.
- Approval denial, expiry, execution failure, committed effect, and unknown
  effect must remain distinct user-visible and operational results.
- Compatibility code must have an executable removal condition when introduced.
- Cleanup must be part of this replacement effort rather than an indefinite
  follow-up.
- Environment Apps must remain available for deliberate broad policy changes,
  independent of an approval card.

## Technology Requirements

### Approval and policy contracts

- The versioned decision contract must represent `decline`, `approve_once`, and
  `remember_approval` instead of an optional boolean.
- Old boolean interactions may use a compatibility parser only while old
  interactions remain pending or processable.
- One shared resolver must apply current Environment and Project policy,
  stricter restrictions, stable tool identity, and remembered evidence.
- Automatic must run without an approval card.
- Blocked must never be overridden by remembered evidence.
- Remembered evidence may satisfy only an eligible Ask First result.
- Subject restriction, tool-minimum approval, explicit runtime strictness,
  disabled capability, and missing actor access must remain stricter than
  remembered evidence.
- Web, Mobile, worker, and runtime must use the same decision vocabulary and
  policy result contract.

### Durable prepared invocation

- The approval gate must call `prepareToolCall` before requesting approval.
- Runtime interaction state must persist or durably reference the resulting
  `PreparedToolCallV1`.
- Web must reference the runtime interaction. Web must not serialize a second
  reconstruction snapshot as competing authority.
- `RunnerExternalApprovalBindingV1` must bind the approval to the prepared
  invocation identity, normalized payload, actor, authority, capability,
  thread, and expiry.
- Continuation run IDs must remain execution and audit facts. They must not act
  as approval authority.
- The runtime must execute the persisted prepared call rather than resolving a
  new tool surface and rebuilding the approved action.

### Stable authority and credentials

- A versioned stable authority fingerprint must contain immutable invocation
  authority and exclude renewable execution credential IDs.
- Execution credential requirements must remain explicit beside stable
  authority and must be checked immediately before execution.
- Renewable credentials include continuation run segments, MCP grants,
  project-context grants, workspace leases, source-write grants, provider
  execution tickets, and live handler capabilities.
- Rotated credentials may authorize execution only when they grant the exact
  stable authority required by the prepared invocation.
- Dynamic tools must support deterministic rebind from stable descriptor
  identity or require fresh approval.

### Remembered approval identity and persistence

- `StableToolApprovalIdentityV1` must contain `toolId`,
  `descriptorContractRevision`, and `approvalAuthorityRevision`.
- Stable tool identity must exclude payload hashes, invocation IDs, run IDs,
  sessions, grants, leases, and other renewable credentials.
- `RememberedToolApprovalV1` must contain `version`, `id`, `organizationId`,
  `threadId`, `actorUserId`, `toolIdentity`, `sourceInteractionId`, and
  `createdAt`.
- PostgreSQL must enforce one record for the same organization, thread, actor,
  and complete stable tool identity.
- The remembered record must be created atomically with the current exact
  `remember_approval` decision in the existing durable response transaction.
- The thread must own record lifetime through referential deletion.
- The remembered record must not contain the previously approved payload or
  renewable execution credentials.
- The host-to-runtime evidence contract must carry the same actor, thread, and
  stable tool identity as a typed versioned projection.
- Runtime must match evidence against the authenticated actor, current thread,
  and newly prepared call before changing Ask First to automatic-for-thread.
- Current access, capability state, and policy must be evaluated for every
  invocation.

### Actor and state ownership

- The requesting actor and authenticated deciding actor must travel as separate
  facts through Web, queue, worker, and runtime.
- The response boundary and runtime must enforce the current same-actor rule.
- `thread_interactions` must own the canonical human decision and its user-facing
  lifecycle projection.
- Runtime interaction state must own the suspended prepared invocation.
- Queue and execution rows must record transport and execution, not approval
  authority.
- `app_operation_approvals` must retain encrypted provider payload,
  connection/resource binding, expiry, redaction, and atomic one-time
  consumption.
- App-operation records must stop owning independent pending, approved, and
  denied human-decision transitions.

### Outcomes, expiry, and retries

- `ToolExecutionOutcomeV1` must determine terminal effect state.
- Starting a continuation run must not resolve an approval or erase failure and
  effect evidence.
- Expired exact invocations must fail closed and must not create remembered
  approval when no valid decision was committed.
- Provider payload expiry must revoke execution availability and redact
  sensitive payload through a persisted transition.
- Retry must be allowed only when effect evidence says `not_started`.
- `started`, `committed`, and `unknown` must not be treated as safe-to-repeat.
- Consume-before-provider atomicity and idempotency must remain unchanged.

### Migration, deployment, and cleanup

- The change requires a PostgreSQL migration, Web deployment, shared protocol
  and runtime package release, Mobile contract update, and hosted turn-worker
  image.
- CLI, Desktop, and TUI must accept the versioned shared contracts but do not
  need to persist hosted remembered approvals.
- New approval requests must use an explicit prepared-invocation version.
- Old interactions must finish on their original path or expire safely.
- Runtime eligibility and parsing must remain fail-closed across mixed Web and
  worker versions.
- Approval-specific `blockedToolScope`, `resolveBlockedResumeScope`, grant-ID
  omission comparisons, blocked static rehydration, rebuilt-call execution,
  and original-run rebinding must be removed after drain gates pass.
- The legacy Web `approvalResponse` branch and boolean-only Mobile and runtime
  responses must be removed after old interactions drain.
- The approval-card `Always Approve` action, Environment Apps return query, and
  auto-approve detour must be removed. Independent policy editing remains.
- App-operation decision transitions, incident reconciliation code, temporary
  project-context execution fallback, and obsolete compatibility tests must be
  removed after their named consumers reach terminal state.
- Compatibility code may be removed after telemetry shows zero old consumers
  for at least the maximum old-interaction lifetime plus one complete worker
  rollout cycle.

### Verification and observability

- Contract tests must cover the three decision values and reject malformed or
  ambiguous responses.
- Policy tests must cover Automatic, eligible Ask First, Blocked, and every
  stricter override with and without remembered evidence.
- PostgreSQL tests must prove atomic current approval and remembered-record
  creation, uniqueness, and thread-cascade deletion.
- Isolation tests must cover different users, threads, tools, descriptor
  revisions, and approval-authority revisions.
- Hosted acceptance must prove Decline, Approve Once followed by another ask,
  Remember Approval followed by automatic later calls, and a new thread that
  asks again.
- Hosted acceptance must prove current calls use fresh payloads, prepared
  invocation identities, credentials, outcomes, and audit records.
- Tests must cover project-context and MCP grant rotation, worker and registry
  restart, dynamic provider rebind failure, expiry, provider consumption,
  effect-not-started failure, and unknown effect state.
- Web and Mobile must prove equivalent decision behavior.
- Telemetry must identify approval version, decision, stable tool identity
  revision, policy result, remembered-evidence match or rejection reason,
  credential refresh result, execution outcome, and compatibility-path use
  without exposing payloads or credentials.
- The full portable `pnpm validate` gate and the boundary-specific PostgreSQL
  and process validation gates must pass before publication.

## People and Operating Requirements

- The authenticated user who initiated the tool invocation owns the approval
  decision under the current same-actor policy.
- Another project member must not approve or consume that user's remembered
  approval.
- Users decide only among Decline, Approve Once, and Remember Approval when an
  eligible Ask First card appears.
- Users do not manage remembered approvals after choosing Remember Approval.
  The remembered choice ends with the thread.
- Organization and Environment administrators retain ownership of deliberate
  broad app policy changes in Environment Apps.
- Kestrel owns stable tool identity, policy evaluation, prepared-call
  persistence, credential refresh, effect tracking, and truthful status.
- Operators own migration sequencing, mixed-version monitoring, legacy drain
  confirmation, incident-row closure, and removal of compatibility paths.
- Operators must deploy the PostgreSQL migration before code that writes
  remembered approvals and must keep Web and worker contract versions
  compatible throughout rollout.
- Support must be able to distinguish denial, actor mismatch, stale tool
  identity, stricter policy, expired invocation, credential refresh failure,
  unrebindable provider, and unknown external effect from structured evidence.
- No new approval administrator, manual grant manager, or remembered-approval
  support workflow is introduced.

## Success and Readiness

Success is observable when:

- Every eligible Ask First card shows Decline, Approve Once, and Remember
  Approval in Web and Mobile.
- Approve Once executes the exact prepared call and asks again next time.
- Remember Approval executes the exact current call and suppresses later
  eligible prompts only for the same user, thread, and stable tool identity.
- A new thread, different user, or changed tool authority asks again.
- Blocked and stricter requirements always take precedence.
- Credential rotation and worker restart do not change the approved action or
  prevent a valid prepared invocation from executing.
- Every future remembered call has a new payload binding, invocation identity,
  credential check, outcome, and audit record.
- One canonical interaction decision agrees with provider consumption and
  terminal effect projection.
- No new hosted approval uses reconstructed tool calls, broad-policy approval
  detours, or duplicate decision ledgers.
- Old approval paths and incident code are removed after their drain evidence
  passes.
- The full hosted acceptance path, PostgreSQL tests, policy matrix, Web and
  Mobile contract tests, restart and rotation tests, and required validation
  gates pass.

**Readiness: Ready for issue creation.**

The product behavior, policy order, identity contracts, state ownership,
thread lifetime, deployment units, compatibility rules, cleanup boundary, and
operating responsibilities are settled. The implementation worktree must start
from deployed-source revision `b36756002321b7a7e942d9a08799e7b01fa387f3` or a
verified descendant because the design-artifact worktree was older when the
blast radius was captured.

The tactical project-context bridge remains a separate production incident
choice. It may be used only as a bounded bridge with an explicit removal gate;
it does not change this Product Brief. The exact wall-clock observation period
is derived from the configured old-interaction lifetime and worker rollout
cycle, so it does not block issue creation.

## Source Artifacts

- [Hosted Approval Simplification Change Design](../design/hosted-approval-simplification-change-design.md)
- [Hosted Approval Simplification Design Notebook](../../.design/hosted-approval-simplification/notebook.md)
- [Thread Remembered Tool Approval Blast Radius](../../.analysis/blast-radius/thread-remembered-tool-approval.md)
- [Thread Remembered Tool Approval Blast Radius JSON](../../.analysis/blast-radius/thread-remembered-tool-approval.json)
