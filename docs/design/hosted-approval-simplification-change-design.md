# Hosted Approval Simplification Change Design

## Executive Summary

Kestrel must first make hosted tool availability and approval one coherent
decision. `workspace_hosted` should use a dedicated `hosted_workspace` policy
pack. The pack exposes the intended shell tools and exact capabilities without
forcing runtime-strict approval. Environment and Project policy remain the
owners of Automatic, Ask First, and Blocked.

One effective tool decision must drive the model surface, execution checks,
approval presentation, remembered-approval eligibility, Web, Mobile, and
diagnostics. Ask First tools remain visible and pause after selection. Blocked
tools are unavailable everywhere. Kestrel must not tell the model a tool is
unavailable and then reject that answer because the unfiltered catalog still
contains the tool.

Kestrel should approve and resume one durable prepared tool invocation. It
should stop reconstructing a tool call in a continuation run and comparing that
new call with the action shown to the user.

The security requirements remain. Approval stays bound to the normalized
action, payload, actor, authority, capabilities, thread, and expiry. Short-lived
execution credentials are refreshed after approval and checked against that
stable authority. They no longer define the approved invocation.

This change also removes the reconstruction system it replaces. The final code
must not retain approval-specific blocked-run snapshots, credential-rotation
exceptions, original-run rebinding, duplicate decision ledgers, the legacy Web
approval protocol, or incident-specific reconciliation code.

For tools whose effective Environment or Project policy is Ask First, the
approval card presents exactly Decline, Approve Once, and Remember Approval.
Remember Approval approves the current exact prepared invocation and records a
separate authorization for that authenticated user, thread, and stable tool
identity. Later calls are newly prepared, validated, executed, and audited; the
remembered authorization changes only whether the user is asked again. It does
not edit Environment or Project policy.

## Current Behavior and First Wrong Component

The observed hosted-shell failure becomes wrong before an approval card can be
created. `workspace_hosted` advertises developer-shell tools but defaults to
the `ci_bot` policy pack. That pack permits `shell.exec`, denies the
`external_side_effect` class containing `exec_command`, and sets
`strictApprovalPerCall` to true. Profile satisfiability nevertheless accepts
the composition through pack-specific assumptions instead of evaluating the
real tool descriptors against the compiled policy.

The deliberator then removes `exec_command` from the model-visible surface.
The full capability manifest still contains it. When the model accurately
reports that the requested tool is unavailable, `DecisionPolicy` validates the
answer against that unfiltered manifest, rejects it, and asks for a policy or
approval change that the runtime exposes no control to perform. Generic retry
handling turns the contradiction into additional paid model calls.

For this observed failure, the first wrong component is hosted profile and
policy composition. Tool availability is not resolved once and shared by model
exposure, validation, execution, approval, and diagnostics.

There is a second structural failure after an Ask First tool is selected. The
reference approval gate calculates normalized input and writes a lightweight
`pendingApproval`, but does not persist a `PreparedToolCallV1`. After approval,
`ExecutionEngine` resolves another tool surface and activation, then creates
the prepared call in the continuation run. The binding preserves the original
run ID. `UnifiedToolRegistry` separately reconstructs static built-in execution
from `blockedToolScope` and permits an MCP grant-ID change. The system asks for
approval before the durable executable command exists.

`fingerprintToolRunScopeV1` compounds the problem. It hashes stable authority
with renewable values such as run ID, MCP grant ID, project-context grant ID,
workspace lease ID, and expiring source-write grants. A normal approval wait can
change those values. Each change then needs a special resume rule.

The Web layer also duplicates lifecycle ownership. `thread_interactions`
records the user-facing decision and worker state. `app_operation_approvals`
records another pending, approved, denied, consumed, or expired state. Runtime
interaction and turn state add further copies. These records can disagree.

The visible approval contract is also wrong. Runtime responses carry only an
optional boolean, so Approve Once and Remember Approval cannot be represented
as different decisions. The card's persistent-looking `Always Approve` action
navigates to Environment Apps, changes broad policy, and then approves the
pending invocation once. There is no thread-scoped approval memory, and the
broad policy mutation can affect work beyond the current thread.

The current branch can resolve remembered evidence to an automatic disposition
in the registry, but the Acter layer subsequently replaces it with
`runtime_strict` Ask because `ci_bot` requires approval per call. Web and Mobile
then hide Remember Approval. They also duplicate eligibility from reason
strings and currently omit Project Ask First, although the settled product
contract makes both Environment and Project Ask First eligible.

The primary code evidence is concentrated in:

- `src/profile/runtimeProfile.ts`, `src/profile/kestrelOnePolicy.ts`,
  `src/kestrel/contracts/profile.ts`, and `tools/devshell/execCommand.ts` for
  hosted profile composition, policy classes, and shell descriptor authority;
- `agents/reference-react/src/steps/deliberator.ts` and
  `agents/reference-react/src/policy/DecisionPolicy.ts` for the split between
  model-visible tools and unavailable-tool validation;
- `agents/reference-react/src/steps/acter/policyGates.ts` and
  `apps/web/lib/apps/runtime-approval-policy.ts` for disposition ordering and
  remembered-approval eligibility;
- `apps/web/components/chatbot/interaction-panel.tsx` and
  `apps/web/app/api/mobile/v1/threads/[id]/interactions/[checkpointId]/route.ts`
  for Web and Mobile projections;
- `src/engine/ExecutionEngine.ts`, `src/io/ToolInvocationSupport.ts`, and
  `tools/runtime/UnifiedToolRegistry.ts` for prepared-call reconstruction and
  credential-bound resume behavior.

## External Findings That Shaped the Design

[NIST SP 800-162](https://csrc.nist.gov/pubs/sp/800/162/upd2/final)
defines authorization as a decision over subject, object, operation,
environment, and policy together, with a metapolicy resolving conflicts. This
supports one composed effective tool decision while retaining its inputs for
explanation and audit.

The [Open Policy Agent deployment model](https://www.openpolicyagent.org/docs/deploy)
separates a policy decision point from enforcement points and records decisions
for audit. Kestrel does not need an OPA dependency. The relevant lesson is that
policy composition should return one answer; the deliberator, validator,
Acter, Web, Mobile, and canaries should enforce or project that answer instead
of independently re-deciding it from partial evidence.

[NIST SP 800-207](https://nvlpubs.nist.gov/nistpubs/specialpublications/NIST.SP.800-207.pdf)
requires authorization against current dynamic policy and least-privilege
context. The resulting clarification is important: a model-visible tool surface
is a revisioned snapshot, not durable execution authority. Presentation and
execution use the same resolver and revisioned inputs, but execution
reevaluates current strictness and fails closed or requires fresh approval when
authority has become stricter. Applying this to an AI tool catalog is an
architectural inference; the source does not define Kestrel's product modes.

## Chosen Design

Bind `workspace_hosted` to a dedicated `hosted_workspace` policy pack. The pack
permits read-only, sandboxed, and intended external-effect classes plus only
the exact capabilities required by hosted workspaces. It does not impose
runtime-strict approval. Keep `ci_bot` unchanged until its explicit CI,
Desktop, and job consumers are reviewed.

Compute one effective tool decision per tool and turn. It contains
availability, approval mode, reason, Remember eligibility, and authority
revision. Ask First tools remain model-visible and pause only after selection;
Blocked tools are unavailable to both the model and effective-surface
validation. The same decision drives execution checks, Acter, Web, Mobile,
canaries, and diagnostics. This is a computed contract, not a second persisted
policy engine. Execution reevaluates the same resolver against current
revisioned inputs; consistency never authorizes stale authority.

Environment and Project policy remain the owners of Automatic, Ask First, and
Blocked. Eligible Environment or Project Ask First presents Decline, Approve
Once, and Remember Approval. Subject restrictions, tool-minimum Ask, explicit
runtime strictness, disabled capabilities, and lost actor access remain
ineligible and cannot be weakened by remembered evidence.

The approval gate prepares and normalizes the call before it waits. It persists
the resulting `PreparedToolCallV1` with a stable invocation identity.

The stable invocation identity contains:

- descriptor and contract revision;
- normalized effective input;
- requesting actor and tenant, project, thread, and resource authority;
- policy and required capability revision;
- expiry and one-time approval identity.

Execution credentials remain separate:

- continuation run segment;
- MCP access grant;
- project-context grant;
- workspace lease;
- source-write grant;
- provider execution ticket;
- live or rebound handler capability.

After the authenticated decision, the runtime refreshes those credentials. It
validates that each credential grants the stable authority required by the
prepared invocation. It then executes that exact prepared call.

The actual deciding actor travels from the authenticated Web request through
the queue and worker to runtime validation. Requesting actor and deciding actor
remain separate facts. Current policy continues to require equality.

Approval resolution has two distinct products:

- The current decision authorizes one exact prepared invocation before expiry.
- `remember_approval` additionally records durable evidence keyed by
  organization, authenticated user, thread, and stable tool identity.

Stable tool identity is the tool ID plus descriptor contract revision and
approval-authority revision. It deliberately excludes run IDs, grants, leases,
and other renewable credentials. A changed tool or authority revision requires
a new remembered approval.

The policy order is explicit. Environment and Project policy first establish
Automatic, Ask First, or Blocked. Subject restrictions, the tool's minimum
approval requirement, explicit runtime strictness, disabled capability, and
current actor access can only make that result stricter. A remembered approval
may satisfy an otherwise eligible Ask First result. It cannot override any
blocked or stricter result. Without eligible remembered evidence, Ask First
renders Decline, Approve Once, and Remember Approval.

`ToolExecutionOutcomeV1` owns the terminal effect result. Starting a
continuation run does not resolve an approval. A retry is allowed only when the
effect is known not to have started.

## State Ownership

`thread_interactions` becomes the canonical hosted human-decision record. It
owns pending, approved, denied, expired, failed, and effect outcome projection.

A remembered-tool-approval record separately owns the durable future-ask
authorization. It is keyed by organization, authenticated user, thread, and
stable tool identity; records its source interaction and creation time; lasts
for the thread; and is deleted with the thread. It becomes ineligible when tool
authority or current policy becomes stricter. Choosing Remember Approval writes
this record atomically with the current exact interaction decision in the
existing durable response transaction. There is no listing, Forget, or
user-managed revocation workflow.

The app-operation record remains because provider routes need durable payload,
connection/resource binding, and atomic one-time consumption before calling a
provider. It stops owning a separate human-decision lifecycle. It references
the canonical interaction and records availability, consumption, revocation,
and redaction only.

Runtime interaction state owns the suspended prepared invocation. Web projects
that state for the user but does not reconstruct it. Queue and execution rows
record transport and execution, not approval authority.

## Code to Remove

The following code exists to support reconstruction and becomes unnecessary:

- Approval-only `blockedToolScope` creation in `InteractionManager`.
- Approval-only `blockedToolScope` propagation in `ThreadRuntime`.
- `resolveBlockedResumeScope` and `withoutGrantId` in
  `UnifiedToolRegistry`.
- The blocked-scope alternative inside static built-in rehydration.
- `ExecutionEngine` logic that rebuilds an approved call, restores the
  binding's original run ID through `preparedRunId`, and compares the rebuilt
  payload hash.
- The temporary project-context execution fallback introduced for the current
  incident.
- The Web `approvalResponse` request schema, request-builder extraction, route
  branch, canary encoding, and tests.
- The approval card's `Always Approve` action, `alwaysApprovalAction`,
  `environmentAppsHref`, and the Environment Apps approval-return and
  auto-approve detour. Deliberate Environment policy management remains.
- The boolean-only Runtime and Mobile approval response after old interactions
  have drained.
- `reconcile-hosted-approval-incident.ts`, its package command, and its test
  after the target rows reach a recorded terminal state.
- Version 1 scope-fingerprint compatibility code after stored old-version
  invocations and runtime packages have drained.
- App-operation pending, approved, and denied transitions after
  `thread_interactions` owns the decision.

Tests that assert these compatibility behaviors should be deleted with the
code. They must not be rewritten to preserve obsolete implementation details.
Replacement tests should assert the prepared-invocation lifecycle.

## Code to Simplify

`pendingApproval` remains, but it stores or references the prepared invocation.
It no longer stores enough metadata to rebuild one later.

`runtime-approval-policy` remains the owner of policy explanations and
Remember Approval eligibility. It stops treating broad-policy navigation as an
approval response.

The external approval binding remains, but run ID stops acting as invocation
authority. The stable prepared invocation ID takes that role. Run IDs remain
execution and audit facts.

Tool fingerprinting remains, but stable authority and renewable credential
requirements become separate versioned contracts.

Pinned execution remains for active runs. Dynamic tools must support
deterministic rebind from stable descriptor identity to survive a worker or
registry restart. If a provider cannot rebind, Kestrel expires the invocation
and requests fresh approval.

`recordDurableRuntimeStarted` remains as telemetry. It must stop resolving the
interaction or clearing failure and effect state.

## Code That Must Remain

Generic `resumeBlockedRun` and `resumeRequestId` remain. User-input waits,
recovery choices, and non-approval continuations depend on them.

Exact normalization and payload hashing remain. Consume-before-provider
atomicity remains. Effect-state reporting remains. Expired, changed, or
unrebindable invocations remain fail-closed.

Environment and Project Automatic, Ask First, and Blocked remain unchanged in
purpose. Remembered approval is subordinate evidence consulted for an eligible
Ask First result, not a fourth policy mode. Environment Apps remains the place
for deliberate broad policy changes.

## Affected Surface

| Surface | Change | Production unit |
| --- | --- | --- |
| Hosted profile and policy composition | Add a scoped hosted pack; validate real descriptor satisfiability | Shared profile/runtime package and worker image |
| Effective tool decision | One availability and approval result drives model, validator, execution, and clients | Shared agent/runtime packages, Web, Mobile, and worker image |
| Approval gate and engine | Prepare before waiting; execute persisted call | Shared runtime and worker image |
| Tool contracts and registry | Split authority from credentials; remove resume exceptions | Shared runtime packages and images |
| Actor transport | Carry actual deciding actor | Web and worker |
| Interaction persistence | Canonical decision and outcome state | Web and PostgreSQL |
| Remembered approval persistence | Thread-lifetime user-thread-tool evidence | Web and PostgreSQL |
| App provider ledger | Consumption record instead of second decision ledger | Web and PostgreSQL |
| Dynamic MCP | Deterministic rebind or fresh approval | Runtime/MCP image |
| Web and Mobile response protocol | Three-way decision; retire boolean response | Web and Mobile clients |
| Runtime policy evidence | Carry typed remembered authority to each fresh call | Shared runtime and worker image |
| Canaries and telemetry | Preflight exact-tool visibility; preserve rejection, spend, and cancellation truth | Web, worker, and operational canaries |
| Operations | Remove incident reconciliation command | Web repository and runbook |

CLI, Desktop, and TUI receive the versioned shared runtime contract even though
hosted Web approval is the changed product scenario. Individual tool and app
provider implementations do not need broad rewrites.

## Transition and Removal Conditions

Old and new interactions may coexist only through an explicit version. New
requests use the prepared-invocation path. Existing old-version requests finish
on the old path or are expired safely; they are never silently upgraded.

New `workspace_hosted` profile resolutions use `hosted_workspace`. Existing
resolved profile snapshots retain their recorded pack and contract revision
until they finish, drain, or expire. The change does not rewrite pending
approval authority in place. Because `ci_bot` is not changed, its deployed
population does not block the hosted repair.

The compatibility code can be removed when all of these conditions hold:

- Every new hosted approval persists a versioned prepared invocation before
  waiting.
- Web and worker execute only that path for the new version.
- No pending or processing interaction uses the old version.
- A full hosted canary proves browser decision, database persistence,
  credential refresh, worker execution, provider consumption, and terminal
  effect projection.
- Production telemetry shows no legacy Web response or blocked-scope approval
  consumer during the chosen observation window.
- Production telemetry shows no boolean-only approval consumer or approval-card
  `Always Approve` return flow during the chosen observation window.
- Incident reconciliation has completed and its target rows are terminal.

Compatibility branches are part of this change only when their removal
condition is defined when they are added. Cleanup is not a separate indefinite
follow-up.

## Rejected Alternatives

Changing `ci_bot` in place is rejected. It would alter explicit CI, Desktop,
and job consumers whose desired approval semantics are not established by the
hosted incident.

Binding hosted workspaces to the broad developer pack is rejected. It exposes
network, MCP, and confirmation capabilities beyond the hosted preset's needs.

Permitting the external-effect class without requiring every external-effect
descriptor to declare an approval capability is rejected. Class permission
cannot make an unclassified external effect executable.

Teaching Web and Mobile to show Remember Approval for `runtime_strict` is
rejected. The runtime would still ignore remembered evidence, so the UI would
promise behavior the execution layer refuses.

Changing the exact-command canary to use a different executable tool is
rejected. It would hide the `exec_command` composition defect instead of
proving the advertised hosted tool surface.

Expanding `blockedToolScope` would copy more credentials and require another
fixed-versus-rotatable classification whenever run context grows. It is
rejected.

Persisting a complete resume snapshot would make reconstruction more exact but
would create a second scope contract and preserve the wrong lifecycle. It is
acceptable only as a short migration bridge.

Keeping both app and interaction decision state would preserve independent
transition races. It is rejected even if transaction code makes individual
updates safer.

Treating Remember Approval as an Environment or Project policy edit is
rejected. It is broader than the user's decision, affects work outside the
thread, and still does not model thread-scoped memory.

Reusing the current approval for future calls is rejected. The current decision
is bound to one normalized payload. Future calls need fresh invocation
identity, preparation, validation, effect outcome, and audit evidence.

## Verification Boundary

The replacement requires one full hosted acceptance path from browser to
provider effect. It must cover:

- `workspace_hosted` exposes `exec_command` to the model under the dedicated
  hosted pack;
- a contradictory profile fails satisfiability before any model request;
- a policy-hidden requested tool can terminate truthfully without retries when
  no available control can change policy;
- the exact-command canary preflights effective availability before model
  spend;
- Environment and Project Ask First both render exactly three decisions;
- explicit runtime strictness remains per-call and never offers Remember;
- a stricter policy revision after model presentation or approval fails closed
  or requires fresh approval;
- normal approval and denial;
- first Ask First, Remember Approval, and automatic later invocations for the
  life of the thread;
- a new thread that asks again;
- cross-user, cross-thread, cross-tool, and changed-authority isolation;
- Blocked, subject-restricted, tool-minimum Ask, runtime-strict, disabled, and
  lost-access cases that remembered evidence cannot override;
- a different project member attempting approval;
- project-context and MCP credential rotation;
- worker and registry restart;
- expiry before decision and before execution;
- failure before an external effect starts;
- an unknown external effect state;
- one-time provider consumption;
- cancellation after model activity preserves nonzero request, token, cost,
  rejection, and terminal-reason telemetry;
- no legacy response or blocked-scope invocation on the new version.

Focused source-regex tests do not prove this design. The acceptance path must
exercise Web, PostgreSQL, queue, worker, runtime, and provider consumption.

## Decisions

- Bind `workspace_hosted` to a dedicated `hosted_workspace` policy pack; keep
  `ci_bot` unchanged.
- Make the hosted pack a capability ceiling with no implicit runtime-strict
  override. Environment and Project own Automatic, Ask First, and Blocked.
- Require every external-side-effect tool to declare at least one approval
  capability.
- Replace pack-name satisfiability assumptions with descriptor-level checks
  against the compiled policy.
- Compute one effective tool decision and project it everywhere; do not add a
  second persisted policy authority.
- Treat both Environment and Project Ask First as Remember-eligible. Keep
  subject Ask, tool-minimum Ask, runtime strictness, Blocked, and unavailable
  tools ineligible.
- Accept a truthful unavailable-tool terminal result against the effective
  surface when the runtime exposes no policy-changing control.
- Preflight exact-command canaries before paid model work.
- Keep the approval security model. Replace the reconstruction lifecycle.
- Use `PreparedToolCallV1` as the durable suspended command.
- Separate stable invocation authority from renewable execution credentials.
- Make `thread_interactions` the human-decision owner.
- Keep the app record only for provider payload and one-time consumption.
- Delete approval-specific reconstruction code after explicit drain gates.
- Keep generic blocked-run resume and live-run handler pinning.
- Preserve Environment and Project Automatic, Ask First, and Blocked as the
  baseline policy model.
- Represent approval decisions as Decline, Approve Once, or Remember Approval.
- Scope remembered approval to one authenticated user, thread, and stable tool
  identity; never reuse the approved payload.
- Invalidate remembered evidence when the tool descriptor or approval authority
  revision changes, or when a stricter policy blocks automatic resolution.
- Remove the approval-card `Always Approve` policy-edit detour.
- Keep remembered approval for the life of the thread. Do not add a listing,
  Forget action, or user-managed revocation workflow.

## Final Contract Shape

The effective tool decision is computed from descriptor, actor, mode,
Environment, Project, class, capability, subject, runtime strictness, and
remembered evidence. It is the authoritative input to model exposure,
validation, execution, and UI projection. Persist only the selected
disposition and authority revision needed for a prepared invocation and audit;
do not create another mutable policy store. Execution evaluates current
revisioned inputs through the same resolver and rejects a stale decision when
authority has become stricter.

Use `StableToolApprovalIdentityV1` with tool ID, descriptor contract revision,
and approval-authority revision. Use `RememberedToolApprovalV1` with version,
record ID, organization ID, thread ID, actor user ID, stable tool identity,
source interaction ID, and creation time. The thread owns record lifetime.
Compatibility paths may be deleted after zero old consumers are observed for
the maximum configured old-interaction lifetime plus one complete worker
rollout cycle. This rule derives the wall-clock period from deployed settings
without changing product behavior or ownership.

The one unresolved design frontier is cancellation telemetry. The observed run
returned zero telemetry despite recorded model calls. The contract is settled:
cancellation must preserve model usage, validation rejection, and terminal
reason. A no-provider reproduction still needs to isolate whether cancel
handling, result reconciliation, or stream projection first discards those
facts. That ownership question does not change the profile, approval, or
prepared-invocation design above.
