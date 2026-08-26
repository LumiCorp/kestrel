# Hosted Approval Simplification Design Notebook

## Current Position

Keep Kestrel's exact-action, fail-closed approval guarantees, but change the
unit that pauses and resumes. A hosted approval must suspend one already
prepared tool invocation. Approval must not start a new run that reconstructs
the invocation and then tries to prove that the reconstruction is equivalent.

The current design mixes stable authority with renewable execution credentials
inside `scopeFingerprint`. It then persists only a small subset of that scope
while waiting. Each credential that rotates across the wait therefore needs a
new exception or bridge. This is the root pattern behind the project-context
grant failure, MCP grant special-casing, pinned-handler failures, and run-ID
rebinding.

The simpler design reuses `PreparedToolCallV1`,
`RunnerExternalApprovalBindingV1`, and `ToolExecutionOutcomeV1`. It does not add
a second resume envelope.

The design also adds the missing approval layer: a remembered approval belongs
to one authenticated user, one thread, and one stable tool identity. It
satisfies later Environment or Project Ask First decisions without changing
Environment or Project policy. Future calls remain newly prepared and audited.

The latest runtime trace exposed an earlier failure plane. `workspace_hosted`
advertises developer-shell tools and binds them to `ci_bot`, but that pack
allows `shell.exec` while denying the `external_side_effect` class that contains
every developer-shell tool. Kestrel removes `exec_command` from the model
request, rejects the model's accurate unavailable-tool response against the
unfiltered capability manifest, and spends more model calls on alternatives.

The selected design now starts with one effective tool decision per tool. That
decision separates availability from approval mode. It drives model exposure,
execution validation, approval presentation, remembered-approval eligibility,
and diagnostics. The prepared-invocation design begins only after that decision
admits the tool.

## Requested Change

Determine the exact blast radius of the hosted approval findings and select a
less complex architecture before implementing or deploying another repair.

For an eligible Ask First tool, the approval card must present exactly three
choices: Decline, Approve Once, and Remember Approval. Remember Approval
approves the current exact invocation and treats later invocations of that tool
as automatic for that user in that thread.

The production priority remains recoverability, but PR 533 stays paused until
the repair is classified as either a safe tactical bridge or part of the
selected design.

## Starting Sources

- Current deployed-source revision `b36756002321b7a7e942d9a08799e7b01fa387f3`.
- `src/kestrel/contracts/tool-invocation.ts`.
- `src/kestrel/contracts/tool-contract.ts`.
- `packages/protocol/src/approvals.ts`.
- `agents/reference-react/src/steps/acter/policyGates.ts`.
- `src/engine/ExecutionEngine.ts`.
- `src/io/ToolInvocationSupport.ts`.
- `src/orchestration/InteractionManager.ts`.
- `tools/runtime/UnifiedToolRegistry.ts`.
- `apps/web/lib/turns/store.ts`.
- `apps/web/lib/turns/process-runtime.ts`.
- `apps/web/lib/agent/kestrel-runtime-core.ts`.
- `apps/web/lib/apps/app-operation-approvals.ts`.
- `apps/web/lib/apps/runtime-approval-policy.ts`.
- `apps/web/components/chatbot/interaction-panel.tsx`.
- `.analysis/blast-radius/thread-remembered-tool-approval.md`.
- `apps/web/drizzle/schema.ts`.
- Existing unit, PostgreSQL, contract, product, and canary tests.

## Relevant Current Behavior

The approval gate calculates normalized tool input and stores a lightweight
`pendingApproval` containing approval identity, tool identity, expiry, and an
external binding. It does not store a `PreparedToolCallV1`.

After approval, the continuation rebuilds a tool-surface snapshot, resolves an
activation, creates a new prepared call, and executes it. The code preserves
the original run ID through the external binding, while the registry separately
restores blocked MCP context and permits MCP grant-ID rotation.

`fingerprintToolRunScopeV1` includes stable authority and identity fields such
as tenant, project, thread, policy, tool allowlist, and workspace roots. It also
includes renewable or run-local credentials such as run ID, session ID, MCP
grant ID, project context grant ID, workspace lease ID, and source-write grant
IDs and expiries.

The Web layer independently persists a generic `thread_interactions` lifecycle
and an app-specific `app_operation_approvals` lifecycle. Runtime orchestration
also persists its own interaction request and durable turn/run state. These
states can advance independently.

The authenticated responder is stored in Web, but the continuation runtime is
constructed with the original turn author. The runtime's actor equality check
therefore compares the original actor with a reconstructed original actor and
does not protect ordinary hosted runtime approvals from a different project
member approving.

The current approval card has no thread memory. Its persistent-looking action
is an `Always Approve` link into Environment Apps. That flow edits broad policy
and then approves the pending request once. Runtime approvals use an optional
boolean response, so they cannot distinguish Approve Once from Remember
Approval. The durable decision transaction is already the correct atomic seam
for recording both the exact current decision and a remembered approval.

The current branch has added the three-way decision and remembered evidence,
but the hosted profile prevents that design from operating for developer-shell
tools. `ci_bot` allows `shell.exec`, denies `external_side_effect`, and sets
`strictApprovalPerCall` to true. `exec_command` is hidden before the approval
gate. If another tool reaches the gate, Acter replaces an Environment or
remembered disposition with `runtime_strict` Ask. Web and Mobile then hide
Remember Approval.

The full capability manifest and model-visible tool surface are separate facts.
The decision validator treats the unfiltered manifest as proof that a
policy-hidden tool is available. It rejects `requested_tool_unavailable` and
prescribes `request_policy_or_approval_change`, but the noninteractive control
surface exposes no such action. Generic validation feedback then amplifies the
contradiction into more model calls.

## Root Design Assessment

The design is not wrong in its security intent. These decisions are correct and
should remain:

- approval is exact-action and normalized-payload bound;
- authority revision and expiry are explicit;
- external effects are fail-closed;
- provider consumption is one-time and happens before the provider call;
- tool descriptors and activations are immutable references;
- outcomes distinguish whether an external effect started or committed.

The hosted composition is wrong at two connected seams. Before approval, the
profile and policy layers produce contradictory availability facts. After a
tool is selected, the lifecycle models approval as a generic interaction
followed by a newly reconstructed run, rather than a pause in one durable
prepared invocation. Both mistakes existed before the recent patches; the
patches expose them rather than create them.

## External Research

NIST SP 800-162 defines an access decision over the subject, object, requested
operation, environment, and policy together. It also describes metapolicy as
the mechanism that resolves conflicts between policies. This supports one
composed decision for a tool invocation rather than independent class and
capability answers that downstream code interprets differently.

- Source: [NIST SP 800-162](https://csrc.nist.gov/pubs/sp/800/162/upd2/final).
- Code implication: Kestrel should compute one effective result from tool,
  actor, environment, project, mode, class, capability, and remembered
  evidence. It should retain the inputs for explanation, not expose conflicting
  partial answers as separate availability facts.

Open Policy Agent documents a policy decision point that returns one decision
to a policy enforcement point and records decisions for audit. Kestrel does not
need OPA, but the responsibility split is useful: policy composition owns the
decision; model filtering, execution, and clients enforce or project it.

- Source: [Open Policy Agent deployment model](https://www.openpolicyagent.org/docs/deploy).
- Code implication: the deliberator, Acter, Web, Mobile, and canary should not
  re-decide policy from different subsets of the same evidence.

NIST SP 800-207 requires authorization to be evaluated against current dynamic
policy and least-privilege context. Presentation is therefore not durable
execution authority.

- Source: [NIST SP 800-207](https://nvlpubs.nist.gov/nistpubs/specialpublications/NIST.SP.800-207.pdf).
- Code implication: model presentation and execution use the same resolver and
  revisioned inputs, but execution reevaluates current strictness. A stricter
  policy revision after presentation or approval fails closed or requires a
  fresh approval.

These sources shape the responsibility boundary. They do not establish
Kestrel's product policy, which remains defined by the settled Environment,
Project, and remembered-approval behavior in this notebook.

## Domain Model

- **Invocation identity:** descriptor revision, normalized effective input,
  actor and tenant/project/thread/resource authority, and policy revision. It is
  immutable across an approval wait.
- **Execution credentials:** run segment, MCP grant, project-context grant,
  workspace lease, execution ticket, and time-bounded write grants. They may be
  renewed, but must be reacquired and validated against the immutable authority.
- **Approval decision:** one authenticated actor's Decline, Approve Once, or
  Remember Approval decision for one prepared invocation before expiry.
- **Remembered approval:** durable evidence that one authenticated user chose
  to satisfy later Ask First decisions for one stable tool identity in one
  thread. It is not an approval of a future payload and is not Environment or
  Project policy.
- **Stable tool identity:** tool ID, descriptor contract revision, and approval
  authority revision. It excludes run IDs and renewable credentials. A changed
  identity requires a new remembered approval.
- **Baseline policy:** Environment and Project Automatic, Ask First, or Blocked
  policy, plus stricter subject, tool-minimum, and runtime requirements.
- **Effective tool decision:** one computed result for one tool in one turn. It
  states whether the tool is available, why it is unavailable when blocked,
  and whether an available invocation is Automatic, Ask First, or Blocked.
  Model exposure and execution consume the same result.
- **Effect lifecycle:** not started, started, committed, or unknown, derived from
  `ToolExecutionOutcomeV1` rather than inferred from queue or run status.
- **Provider capability:** an app-specific, one-time consumption record that
  stores provider payload and connection/resource binding. It is not a second
  approval decision.

Invariants:

- A decision can authorize exactly one immutable invocation identity.
- Remember Approval separately authorizes later Ask First resolution for the
  same user, thread, and stable tool identity. Each later invocation still has
  its own identity and outcome.
- Environment Automatic skips the card. Ask First consults remembered approval.
  Blocked always blocks.
- An Ask First tool remains model-visible. Selecting it creates an approval
  interaction. Approval policy must not be implemented by hiding the tool.
- A tool blocked by mode, class, or capability is absent from both the model
  surface and the validator's effective available-tool set.
- The model-visible tool surface is a revisioned snapshot, not execution
  authority. Execution reruns the same effective resolver against current
  inputs and fails closed or requests fresh approval if authority became
  stricter.
- Every external-side-effect tool declares at least one approval capability.
  Class permission cannot expose an unclassified external effect.
- The hosted runtime pack is a capability ceiling. Environment and Project
  policy own Automatic, Ask First, and Blocked. The pack does not silently
  replace an eligible Ask First decision with runtime-strict approval.
- Remembered approval cannot override Project Blocked, subject restriction,
  tool-minimum Ask, explicit runtime strictness, disabled capability, or lost
  actor access.
- One user's remembered approval never authorizes another project member.
- The actual authenticated deciding actor is carried end to end.
- Renewable credential IDs never define invocation identity.
- A credential may be refreshed only when its stable authority still matches.
- A tool cannot execute unless the exact prepared invocation is approved and
  current credentials satisfy its authority requirements.
- One canonical decision owns approval status; UI, queue, runtime, and provider
  records are projections or effect records, not competing decision ledgers.

## Blast Radius

### Hosted profile and policy composition

Primary owners are `runtimeProfile`, `kestrelOnePolicy`,
`approvalPolicyPacks`, `KestrelChatRuntime`, the tool catalog, and mode
contracts. `workspace_hosted` needs a policy pack that permits its intended
developer-shell class and capabilities without imposing runtime-strict
approval. Catalog validation must reject any external-effect tool without an
approval capability. Profile satisfiability must evaluate real descriptors
against the compiled policy instead of inferring permission from a pack ID.

### Effective model and execution surface

Primary owners are deliberator tool filtering, `DecisionPolicy`, approval
disposition, and runtime diagnostics. They must consume one effective tool
decision. A policy-hidden tool cannot remain "available" only because it exists
in the full catalog. An accurate unavailable-tool response must terminate a
noninteractive turn instead of entering an impossible correction loop.

### Approval presentation and remembered eligibility

Primary owners are `resolveToolApprovalDispositionV1`, Acter policy gates, the
hosted request envelope, Web, and Mobile. Remember eligibility must come from
the effective policy result. Web and Mobile must not independently reconstruct
it from reason strings. Eligible Environment or Project Ask First decisions
expose Decline, Approve Once, and Remember Approval. Subject Ask, tool-minimum
Ask, runtime strictness, and Blocked remain ineligible.

### Stable invocation versus renewable credentials

Primary owners are `ToolInvocationSupport`, `ToolGateway`, tool activation
contracts, `UnifiedToolRegistry`, and integrity tests. This is broad in shared
runtime code and reaches hosted worker, CLI, Desktop, and TUI packaging. It does
not require changing every tool implementation. Versioned activation parsing
can preserve compatibility while `scopeFingerprint` is split into stable
authority identity and execution credential requirements.

### Prepare before approval and resume the same command

Primary owners are the reference ReAct approval gate, `ExecutionEngine`, the
runtime interaction request, and durable effect persistence. `PreparedToolCallV1`
already carries activation, normalized input, policy, approval authority, and
call identity, so this is a lifecycle reordering rather than a new command
contract.

### Actual deciding actor

Primary owners are the Thread response route/store, durable response envelope,
worker runtime reconstruction, and runtime actor validation. This affects every
hosted approval kind but does not require provider-specific changes. The
requesting actor remains part of invocation authority; the deciding actor is a
separate fact and policy decides whether delegation is allowed. Current policy
can remain same-actor until explicit delegation is designed.

### Thread-scoped remembered approval

Primary owners are the approval decision contract, `thread_interactions`
transaction, a new remembered-approval persistence record, worker context
assembly, tool approval disposition, and Web and Mobile cards. The remembered
record is keyed by organization, thread, authenticated user, and stable tool
identity. It lasts for the thread, is deleted with the thread, and becomes
unusable when policy or tool authority changes. There is no Forget workflow.

This requires a PostgreSQL migration, Web deployment, shared protocol/runtime
update, and turn-worker image. CLI, Desktop, and TUI receive compatible shared
types but need not persist hosted remembered approvals.

### Canonical approval lifecycle

Primary owners are `thread_interactions`, runtime interaction records,
`app_operation_approvals`, turn processing, UI projection, and provider routes.
This is the only likely schema-migration area. `thread_interactions` should own
the human decision. The app record should retain encrypted/provider payload,
resource binding, expiry, and one-time consumption only; it should not maintain
an independent pending/approved/denied decision lifecycle.

### Terminal status and retries

Primary owners are turn-worker start/failure recording, interaction status
projection, and `ToolExecutionOutcomeV1` handling. A run starting is not an
approval completing. Terminal interaction state must be driven by tool outcome,
including `not_started`, `committed`, and `unknown`, with retries permitted only
when the effect is known not to have started.

### Expiry and redaction

Primary owners are the canonical approval transaction and app provider payload
record. Expiry must be a persisted transition that revokes execution and
redacts sensitive payload. Opportunistic reads may enforce expiry but cannot be
the only lifecycle mechanism.

### Dynamic MCP tools

Primary owners are MCP tool registration and registry rebind behavior. A
dynamic tool must either provide deterministic rebind from stable descriptor
identity or require a fresh approval. An in-memory pinned handler is an
execution credential, not durable invocation identity.

### Legacy response protocol

Primary owners are the Thread API route, request builder, chat client, canary,
and contract tests. The legacy `approvalResponse` path should be retired after
the canonical interaction response is proven end to end.

## Candidate Seams and Options

### Change `ci_bot` in place

Adding `external_side_effect` and disabling strict approval would make the
current hosted profile work. It would also change every explicit CI Bot profile
and Desktop or job configuration. The current code does not establish that
those consumers want interactive hosted semantics. Reject as the default
design because it broadens the change outside the named environment.

### Bind `workspace_hosted` to the developer pack

The `dev` pack exposes shell execution but also permits network, MCP, and
confirmation capabilities that the hosted preset does not need. Reject because
it widens authority and hides the actual composition defect.

### Give `workspace_hosted` a coherent hosted pack

Add one hosted policy pack that permits read-only, sandboxed, and
external-side-effect classes; permits only the exact capabilities intended by
the hosted preset; and leaves `strictApprovalPerCall` false. Environment and
Project policy then decide Automatic, Ask First, or Blocked. Keep `ci_bot`
unchanged until its real consumers and desired semantics are reviewed. This is
the selected profile seam because it changes only hosted workspaces.

### Compute one effective tool decision

Keep class, capability, mode, Environment, Project, subject, tool minimum,
runtime strictness, and remembered evidence as explainable inputs. Resolve them
once into availability, approval mode, reason, and Remember eligibility. Feed
that result to model exposure, execution, approval presentation, Web, Mobile,
and diagnostics. This is the selected policy seam. It removes contradictory
projections without adding another persisted authority model.

### Treat Remember Approval as an Environment or Project policy edit

This is the current `Always Approve` direction. It changes policy outside the
thread, can affect other projects or users, and still approves the pending
request through a separate action. It does not implement remembered approval.
Reject and remove the approval-card detour. Environment Apps remains available
for deliberate broad policy management.

### Reuse the exact current approval for later tool calls

This would bind later payloads to an approval for a different invocation. It
would violate exact-action approval and make audit records misleading. Reject.

### Persist user-thread-tool approval evidence

Record Remember Approval beside the exact current decision. Resolve it only
after baseline policy yields an eligible Ask First result. Carry typed,
authority-bound evidence into runtime for later prepared calls. This is the
selected seam because it matches the requested scope without weakening current
or future invocation validation.

### Extend `blockedToolScope` for every rotating field

Persist the original project context, workspace lease, source-write grants,
policy settings, and every future credential alongside run and MCP context.

This is the smallest immediate patch but the worst design. It duplicates the
entire run context, retains secrets longer, and requires code to classify each
new field as fixed or rotatable. Reject as the architectural solution. PR 533
may still be evaluated as a short-lived production bridge, but it cannot be the
endpoint.

### Persist a complete resume snapshot and allow declared rotations

Store all fingerprint inputs at approval time and compare the continuation
against a list of allowed credential rotations. This is safer than the current
partial snapshot, but it preserves reconstruction as the model and creates a
second versioned scope contract. Keep only as a migration bridge if preparing
before approval cannot be introduced atomically.

### Suspend one prepared invocation and refresh credentials at execution

Prepare and normalize the tool call before requesting approval. Persist the
prepared call with the interaction. Bind approval to its stable invocation
identity. On approval, execute that exact prepared call after reacquiring and
validating renewable credentials. Do not rebuild the tool request from a new
surface snapshot.

This is the selected option. It uses existing contracts, deletes the need for
field-by-field resume exceptions, and makes the security proof understandable.

## Proposed Delta

### Before tool selection

- Add a hosted policy pack and bind `workspace_hosted` to it. Permit the
  intended developer-shell class and exact capabilities. Do not impose runtime
  strictness on ordinary hosted turns.
- Require every external-side-effect descriptor to declare at least one
  approval capability.
- Replace hardcoded pack-name satisfiability checks with descriptor-level
  validation against the compiled policy.
- Compute one effective tool decision per tool and turn. Keep availability and
  approval mode distinct: Ask First tools are visible; denied tools are not.
- Validate `requested_tool_unavailable` against the effective available surface.
  Do not prescribe a policy-change action that the control surface cannot make.
- Carry one authoritative Remember-eligibility result to Web and Mobile. It is
  true for eligible Environment or Project Ask First and false for subject Ask,
  tool-minimum Ask, runtime strictness, Blocked, or unavailable tools.
- Make exact-command canaries preflight the effective tool decision before any
  paid model request. Bound model and validation attempts, record decision
  rejection, and preserve nonzero telemetry on cancellation.

### After tool selection

1. Introduce a versioned stable authority fingerprint that excludes run-local
   and renewable credential IDs. Keep credential requirements explicit beside
   it for execution-time validation.
2. Define a versioned stable tool identity from tool ID, descriptor contract
   revision, and approval authority revision.
3. Move `prepareToolCall` ahead of the approval wait for tool approvals. Persist
   the resulting `PreparedToolCallV1` in the durable interaction/effect state.
4. Replace the runtime approval boolean with an explicit `decline`,
   `approve_once`, or `remember_approval` decision. Keep a compatibility parser
   only for old interactions.
5. For an eligible Ask First interaction, render Decline, Approve Once, and
   Remember Approval in Web and Mobile.
6. In the existing durable response transaction, record the current exact
   decision and upsert the user-thread-tool remembered approval atomically when
   the user chooses Remember Approval.
7. Resolve remembered approval only after Environment and Project policy yields
   Ask First. Do not apply it to Blocked, subject restriction, tool minimum,
   explicit runtime strictness, or disabled tools.
8. Load active remembered approvals for the authenticated actor and thread.
   Carry typed authority-bound evidence to runtime. Later calls are newly
   prepared and audited; remembered evidence changes only the ask decision.
9. Bind `RunnerExternalApprovalBindingV1` to the prepared call's stable
    invocation identity and normalized payload. Treat continuation run IDs as
    execution segments, not approval identity.
10. Carry requesting actor and authenticated deciding actor separately through
    Web, queue, worker, and runtime. Enforce current same-actor policy at the
    response boundary and again at execution.
11. Make `thread_interactions` the canonical hosted human-decision record.
    Reduce app-operation rows to provider payload/resource and one-time
    consumption state linked to that interaction.
12. Drive interaction terminal status from `ToolExecutionOutcomeV1`, reacquire
    renewable credentials before execution, and require deterministic dynamic
    provider rebind.
13. Add a full hosted path that proves effective shell visibility, first Ask
    First, Remember Approval, and later automatic invocations for the life of
    the thread. Include new-thread, cross-user, cross-tool, stale-authority,
    credential rotation, restart, expiry, and effect-state cases.
14. Remove the old approval reconstruction path, boolean decisions, Environment
    Apps approval-return detour, duplicate app-decision transitions, incident
    reconciliation, and compatibility tests after their removal gates pass.

## Removal Map

### Delete after the new path is active and old approvals have drained

- Approval-specific `blockedToolScope` creation in `InteractionManager` and its
  propagation through `ThreadRuntime`.
- `resolveBlockedResumeScope`, `withoutGrantId`, and the blocked-scope branch in
  `UnifiedToolRegistry.rehydrateStaticBuiltInExecution`.
- Approval continuation logic that rebuilds a tool snapshot and call, restores
  the binding's original run ID through `preparedRunId`, and then rechecks the
  rebuilt payload hash in `ExecutionEngine`.
- The legacy Web `approvalResponse` schema, request-builder extraction, Thread
  route branch, canary encoding, and their contract tests.
- `Always Approve`, `alwaysApprovalAction`, `environmentAppsHref`, and the
  approval-return query/auto-approve flow in Environment Apps. Independent
  Environment policy editing remains.
- The old boolean-only runtime and Mobile approval response after old
  interactions drain.
- `reconcile-hosted-approval-incident.ts`, its package script, and its test once
  the affected production rows have a recorded terminal state.
- Temporary context-grant execution fallback from PR 533 after no old approval
  path can consume it.
- Version 1 scope-fingerprint compatibility parsing and tests after no stored
  prepared invocation or active runtime package can carry that version.

### Simplify rather than delete

- `app_operation_approvals`: keep provider payload, connection/resource
  binding, expiry, and atomic consumption. Remove its independent
  pending/approved/denied decision transitions and decision-actor columns after
  `thread_interactions` becomes the decision owner.
- `recordDurableRuntimeStarted`: keep execution telemetry, but remove its power
  to mark an interaction resolved or clear failure/effect state.
- `RunnerExternalApprovalBindingV1`: keep exact action, payload, capability,
  authority, thread, and expiry binding. Replace run identity as authority with
  the prepared invocation identity.
- `fingerprintToolRunScopeV1`: replace it with a stable authority fingerprint
  plus explicit execution credential requirements. Do not preserve renewable
  IDs in the stable hash.
- Pinned execution: keep exact handler pinning within a live registry. Replace
  approval-specific historical rehydration with deterministic provider rebind;
  require fresh approval when rebind is unsupported.
- `pendingApproval`: retain a pending-decision marker, but make it reference or
  contain the durable prepared invocation instead of reconstructible metadata.
- `runtime-approval-policy`: retain policy explanation and Remember eligibility,
  but remove broad-policy navigation as an approval decision.

### Retain unchanged in purpose

- Generic `resumeBlockedRun` and `resumeRequestId`. User-input waits, recovery
  choices, and non-approval continuation use them independently of tool
  approval.
- Exact payload normalization and hashing.
- Same-actor enforcement until delegated approval becomes an explicit policy.
- Consume-before-provider atomicity and idempotency.
- `ToolExecutionOutcomeV1` effect-state semantics.
- Fail-closed behavior for expired, changed, or unrebindable invocations.
- Environment Automatic, Ask First, and Blocked semantics. Remembered approval
  is a subordinate thread authorization, not a new Environment mode.

### Removal gates

Code is removable only when all of these facts are executable proofs:

- New approval requests persist a versioned prepared invocation before the
  wait.
- Web and worker execute only the prepared-invocation path for that version.
- No pending or processing interaction uses the old approval version.
- The full hosted canary covers approval, credential refresh, execution, and
  terminal effect projection.
- Production telemetry shows no old response protocol or blocked-scope resume
  consumers during the agreed observation window.
- Production telemetry shows no old `Always Approve` return flow or boolean
  approval consumer during the agreed observation window.
- Incident-specific reconciliation has completed and its target rows are
  terminal.

The cleanup must ship as part of the replacement effort, not as an open-ended
follow-up. Compatibility branches need an explicit removal gate when they are
introduced.

## Delivery Boundaries

The safe sequence is compatibility-first:

1. Add versioned stable authority and prepared-call persistence without
   changing execution behavior.
2. Add stable tool identity, remembered-approval persistence, and the typed
   host-to-runtime evidence contract without honoring it yet.
3. Add the prepare-before-wait path and three-way decision behind an explicit
   hosted approval version.
4. Switch Web, Mobile, and turn-worker together. Old interactions remain on the
   old parser/path until terminal.
5. Enable remembered resolution after full hosted proof.
6. Migrate app approval lifecycle ownership and add expiry/redaction handling.
7. Remove reconstruction, boolean response, Environment Apps detour, duplicate
   lifecycle, incident script, and compatibility tests after removal gates pass.

Production units affected are the shared runtime package and images, hosted
turn-worker image, Web deployment, and likely one PostgreSQL migration. Redis
project-context grants remain in place; only their role changes from immutable
invocation identity to renewable execution credential.

## Decisions

- Bind `workspace_hosted` to a dedicated `hosted_workspace` policy pack. Keep
  `ci_bot` unchanged until its non-hosted consumers and product intent are
  reviewed. Confidence: high.
- The hosted pack permits the intended external-effect class only with exact
  allowed approval capabilities and does not set runtime strictness.
  Confidence: high.
- Compute one effective tool decision and project it everywhere. Do not add a
  second persisted policy engine. Persist the selected disposition and authority
  revision only where the prepared invocation and approval audit require them.
  Confidence: high.
- Treat Environment or Project Ask First as eligible for Remember Approval.
  Web and Mobile must consume the authoritative eligibility result instead of
  recomputing it from reason strings. Confidence: high.
- Accept an unavailable-tool terminal response against the effective surface
  when no available control can change the blocking policy. Confidence: high.
- Fail exact-command qualification before model spending when the required
  tool is not effectively visible. Confidence: high.
- The security goal is sound; the pause/resume composition is structurally
  wrong. Confidence: high.
- For the observed hosted-shell failure, the first wrong component is
  profile/policy composition. For calls that do reach approval, the first
  lifecycle defect is the approval gate asking before a durable prepared
  invocation exists. Confidence: high.
- `scopeFingerprint` currently conflates identity and credentials. Confidence:
  high.
- `PreparedToolCallV1` is the existing surface that should own the durable
  suspended command. Confidence: high.
- The app provider record is necessary for atomic consume-before-provider, but
  its independent human-decision lifecycle is not. Confidence: high.
- No new heuristic matching, fallback ranking, or field-by-field rotation list
  should be introduced. Confidence: high.
- Generic blocked-run resume and live-run handler pinning are not approval
  debris and must remain. Confidence: high.
- Compatibility code is part of the change only when its deletion condition is
  defined in the same change. Confidence: high.
- Remember Approval is a user-thread-tool authorization, not Environment or
  Project policy and not a reusable payload approval. Confidence: high.
- Remembered approval applies only to Ask First caused by Environment or
  Project policy. Stricter requirements remain per-invocation. Confidence:
  high.
- Stable tool and approval-authority revision changes invalidate remembered
  approval. Confidence: high.
- The current `Always Approve` approval-card flow is the wrong product concept
  and should be removed. Confidence: high.
- Remembered approval lasts for the thread. There is no listing, Forget, or
  user-managed revocation workflow. Confidence: high.
- PR 533 is at most a tactical bridge for currently blocked production work;
  it is not the architectural repair. Confidence: high.

## Settled Delivery Constraints and External Incident Choice

- The tactical PR 533 bridge remains a separate production incident choice. If
  used, it must be bounded and removed by the final compatibility drain gate.
- Persist or durably reference `PreparedToolCallV1` in runtime interaction or
  effect state. Web stores the runtime interaction reference and projects the
  card from that prepared call; it does not store a competing resume snapshot.
- Use `StableToolApprovalIdentityV1` with tool ID, descriptor contract revision,
  and approval-authority revision. Use `RememberedToolApprovalV1` with version,
  record ID, organization ID, thread ID, actor user ID, stable tool identity,
  source interaction ID, and creation time. The thread owns record lifetime.
- Keep encrypted provider payload in `app_operation_approvals` and redact it in
  place through a persisted expiry transition. Do not add a separate encrypted
  payload table.
- Delete old Web response and blocked-scope paths only after zero consumers are
  observed for the maximum configured old-interaction lifetime plus one full
  worker rollout cycle.
- No reviewer gate is assumed; verification must therefore be executable and
  evidence-producing inside the repository and production canary.

## Decision Map

- Status: not needed
- Path: none
- Destination: one durable prepared invocation plus user-thread-tool remembered
  approval from Ask First through later automatic resolution and effect outcome
- Return condition: implementation plan is ordered by compatibility and
  production reversibility

## Active Change Frontier

- Cancellation returned zero telemetry despite recorded model calls. The
  design requires truthful terminal telemetry, but the exact owner between
  cancel handling, result reconciliation, and stream projection remains to be
  isolated with a no-provider reproduction.
- The deployed population of explicit `ci_bot` profiles is unknown. The chosen
  dedicated hosted pack avoids making that inventory a blocker.

## Best Next Move

Use a no-provider cancellation reproduction to locate the zero-telemetry owner,
then refresh the existing Product Brief and issue graph against this completed
design before further implementation. Do not treat the current shell canary as
evidence for the prepared-invocation path until effective-tool preflight passes.
