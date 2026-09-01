# Local Browser Smoke Change Design

## Executive Summary

Kestrel should extend its existing Chromium product-contract lane into a
curated local browser smoke. The lane already runs the real local Kestrel One
application with PostgreSQL, Redis, workers, a runner, local artifact storage,
and a deterministic model provider. The change belongs there.

The smoke should be runnable headless, in headed Chromium, or through
Playwright UI Mode. Each scenario must prove the visible UI, the authoritative
Kestrel record, and whether a provider or tool actually executed. This is the
only reliable way to cover readiness blocks, approval cleanup, context grants,
restart recovery, and duplicate-execution regressions.

Pressure testing splits the target into a fast `@smoke` lane plus
`@decision-matrix` and `@recovery` lanes. Their union is the full local browser
contract. This keeps routine feedback small without dropping requested state
transitions.

## Requested Outcome

The local smoke covers provider and Luna model setup, model readiness, mid-flight
mode changes, hosted approvals, Project authorization continuity, Word export,
workflow execution, and quiet named collaborators.

“Full coverage” is scoped to these behaviors. It means every meaningful state
transition has visible, durable, and external-boundary proof. It does not mean
that this smoke replaces the full Chromium product suite, PostgreSQL tests, or
live hosted canaries.

## Relevant Current Behavior

`apps/web/playwright.product.config.ts` already owns the deterministic browser
environment. It launches `apps/web/scripts/product-validation-stack.mjs` and
`tests/ops/helpers/fake-open-router.ts`. The stack starts the web application,
turn worker, knowledge worker, runner, PostgreSQL-backed application state,
Redis-backed grants, and local artifact storage.

The existing browser contracts cover useful foundations:

- `apps/web/tests/product/organization-models.spec.ts` covers model catalog
  presentation and administrative approval behavior.
- `apps/web/tests/product/durable-conversation.spec.ts` covers streamed turns,
  reload recovery, waiting interactions, and queued-turn coordination.
- `apps/web/tests/product/workflow-canvas.spec.ts` covers workflow generation
  and editor behavior.
- `apps/web/tests/product/thread-shell.spec.ts` covers thread creation,
  duplication, Project assignment, and lifecycle actions.

They do not yet execute the requested cross-feature flows. The workflow tests
never save or run a workflow. The conversation tests do not cover readiness,
mode changes, hosted approval, Project grants, Word export, process restart, or
collaborators.

There are five important test-harness gaps:

1. `apps/web/playwright.product.config.ts` sets both test and assertion timeouts
   to zero. A broken smoke can wait forever instead of producing a bounded
   failure artifact.
2. `tests/ops/helpers/fake-open-router.ts` records requests in process memory,
   but browser tests cannot inspect the request list. It needs named scenario
   controls and classified model-request inspection. It cannot authoritatively
   report hosted tool execution because Kestrel, not the model provider, owns
   that boundary.
3. The product stack is owned by Playwright's `webServer` for the full run.
   `page.reload()` can prove browser recovery, but it cannot prove recovery
   across new server, worker, and runner processes.
4. The fake provider and seed use `z-ai/glm-5.2`. This smoke must use the
   requested exact Luna identity, `openai/gpt-5.6-luna`, everywhere the
   effective product contract selects a model.
5. `apps/web/scripts/product-validation-stack.mjs` performs admin creation and
   gateway/model seeding before starting services. Re-running it for a recovery
   case can mutate persisted state, so one-time bootstrap must be separated from
   restartable service lifecycle.

The model-readiness flow already has the correct server owner.
`apps/web/app/api/models/approved/route.ts` returns models eligible for the
requested runtime role. `apps/web/components/chatbot/multimodal-input.tsx`
loads that catalog for the composer. However, the selector also merges a
selected fallback into the returned list. A stale cookie or selection can
therefore only be trusted after the browser smoke proves that it cannot bypass
server readiness or reach the provider.

Provider traffic must be classified. Catalog and qualification calls are valid
before readiness, transport retries may create several HTTP attempts for one
`RuntimeIO.callId`, and a tool-using agent loop normally needs multiple logical
model calls. Exactly-once assertions belong to the turn, logical call, prepared
invocation, and observable effect—not the raw HTTP count.

Project context grants are scoped by organization, Project, thread, actor, and
context revision. Cross-tab continuity therefore means that the original thread
resumes with its original grant ID and revision. Another thread in the same
Project may correctly have a different grant ID for that same revision.

The current collaborator UI already implements quiet presentation.
`apps/web/lib/turns/collaborators.ts` removes private dialog parts from the
ordinary conversation. `apps/web/components/chatbot/collaborator-inspector.tsx`
keeps the durable history inspectable. There is no quiet-mode configuration
surface, so the smoke must test the invariant instead of pretending to set a
mode. Its visible lifecycle is working, ready, waiting, paused, problem, and
archived; `replied` is a durable event, not a visible state.

The workflow contract also settles an ambiguity in the supplied wording.
`apps/web/lib/workflows/contracts.ts` requires exactly one trigger and one
output. The meaningful smoke graph is therefore two Kestrel work steps plus
the required trigger and output.

## Affected Surface

The change is limited to the browser product-contract seam and its deterministic
fixtures:

- product-contract environment allocation and launcher;
- Playwright smoke configuration, tags, timeouts, traces, and reports;
- fake provider model identity, named scenarios, and classified request
  inspection;
- test fixtures for organization, Project, thread, app connection, model, and
  artifact records;
- new product specs for model readiness, conversation continuity, approvals,
  Project grants, Word export, workflows, restart, and collaborators.

The smoke should not change runtime policy or product behavior merely to make a
test pass. If a scenario exposes a product failure, that failure should be
diagnosed at the component that first makes the behavior wrong.

## External Findings That Shaped the Design

Playwright UI Mode can run or filter individual tests and tags while exposing
the action timeline, DOM snapshots, console, network requests, and attachments.
That makes it the right local browser interface for this curated suite, while
the same specs can still run headless in validation. See the official
[Playwright UI Mode documentation](https://playwright.dev/docs/test-ui-mode).

Playwright can manage one or more local servers through the `webServer`
configuration. The current Kestrel product config already uses this well for a
normal run. A true mid-test restart still requires a Kestrel-owned controller
that can stop and start the web, turn worker, knowledge worker, and runner while
preserving database and artifact roots. See the official
[Playwright web server documentation](https://playwright.dev/docs/test-webserver).

Playwright separates test, assertion, and global timeouts. The smoke should use
finite values for all three and attach the last observed turn, interaction,
workflow, or provider state when a limit expires. See the official
[Playwright timeout documentation](https://playwright.dev/docs/test-timeouts).

## Options and Candidate Seams

### Extend the existing product-contract lane

This is the selected seam. It exercises the real local application boundaries,
reuses the existing validation investment, and keeps model behavior
deterministic.

### Add a manual browser checklist

A checklist cannot prove that a blocked model produced zero agent-turn calls,
that an approval resumed the exact prepared invocation, or that a Project grant
continued across tabs and navigation. It can remain a release companion, but it
should not own this test contract.

### Mock server routes in the browser

This would make the tests faster but would bypass the server behavior under
test. Browser route mocks remain appropriate for visual catalog tests, not for
the new cross-boundary smoke.

### Put everything in one golden-path test

A single serial journey would be easy to watch but hard to trust. One early
failure would invalidate every later assertion, and stale state would become an
uncontrolled dependency. The selected design shares one local stack while
isolating each scenario's organization, Project, thread, request, and provider
state.

## Proposed Delta

### One launcher, three local modes

Add one Kestrel-owned browser-smoke launcher that reuses the validation
environment allocator and product stack. It should support:

- headless smoke for a quick deterministic pass;
- headed Chromium for watching the product interaction;
- Playwright UI Mode for selecting, replaying, and debugging individual cases.

The broader `validate:chromium` gate continues to run all product contracts.
The curated smoke is selected by a stable tag, not by copying the specs into a
second test tree.

The launcher must extract and reuse the validation environment allocator, run
admin/model bootstrap once, and then own restartable service processes. A
service restart stops and starts the web, turn worker, knowledge worker, and
runner while PostgreSQL, Redis, artifact storage, and the fake provider remain
stable. It verifies old PIDs exited and all new health checks passed. This is an
outer test controller, not a restart endpoint exposed by the application.

The test taxonomy is:

- `@smoke`: readiness, mode continuity, approve-once plus Word, Project/tab
  continuity, workflow execution, and quiet collaborator behavior;
- `@decision-matrix`: decline and remembered-approval scope;
- `@recovery`: pending approval and fresh-flow behavior across process restart.

### Named deterministic provider scenarios

Replace prompt-substring-only control with explicit named scenarios. The fake
provider should expose test-only controls to:

- select and reset a scenario;
- hold and release a model response;
- emit a hosted tool call, collaborator dialog sequence, or multi-tool sequence;
- inspect request class, logical call ID, model, attempt, and requested tools.

The fake provider must advertise and respond as `openai/gpt-5.6-luna`. The seed,
gateway model, environment default, composer selection, and recorded request
must agree on that exact identity.

Hosted execution proof comes from Kestrel's durable approval/execution records
and an observable reversible fixture. The selected local action is
`exec_command` with a harmless command that emits a unique terminal token in a
test workspace. The fixture explicitly seeds the Environment/Project policy
that exposes this hosted capability.

### Shared proof contract

Every scenario must assert five things:

1. **Visible state:** the user sees the correct control, status, result, or
   failure reason.
2. **Durable state:** the authoritative turn, interaction, grant, workflow, or
   artifact record reaches the expected state.
3. **Execution state:** classified logical model calls or the authoritative tool
   boundary records the expected identity and observable effect.
4. **No duplication:** the browser and stores contain no repeated message,
   turn, decision, side effect, or artifact.
5. **Terminal cleanup:** pending interactions and temporary execution state are
   gone or remain intentionally resumable.

### Full local browser contract scenario set

#### 1. Add an OpenRouter connection and Luna model (`@smoke`)

In an isolated organization, open Organization → Connections. Add the
deterministic OpenRouter provider and
verify its catalog sync. Open Models, add or select
`openai/gpt-5.6-luna`, and verify the model starts Not approved and is absent
from the chat catalog.

Approve the model. Observe Checking compatibility, then Ready. Verify the exact
provider identity, economics evidence, capability checks, and `agent.loop`
eligibility. Reload Connections and Models to prove the provider and model are
persisted.

#### 2. Block an unready model before execution (`@smoke`)

Attempt the unready Luna identity through the visible selector and through a
stale `chat-model` cookie. The UI must either omit the model or block submission
with a useful reason. No turn may begin with that model, and the fake provider
must record zero classified agent-turn requests.

After qualification, select Luna and send a small request. Verify one turn and
at least one classified agent-turn request using the ready model. Catalog and
qualification traffic does not violate the pre-readiness assertion.

#### 3. Change agent mode during an active request (`@smoke`)

Start a delayed logical model call in Chat mode and capture its turn ID,
effective mode, and `RuntimeIO.callId`. While the turn is Running, change the
composer to Build. Release the provider response.

The original turn must complete once in its original effective mode. The mode
selector must remain Build for the next turn. The test fails if the turn or held
logical call is cancelled, replaced, restarted, or duplicated. Later calls in a
legitimate agent loop are not duplicates.

#### 4. Complete the hosted approval lifecycle (`@smoke`, `@decision-matrix`)

Trigger `exec_command` with a harmless deterministic command that emits a
unique token. Verify the approval card
shows the safe action summary, exact request identity, relevant arguments,
policy explanation, and the eligible choices Decline, Approve Once, and
Remember Approval.

Approve Once. Verify the same prepared invocation moves through requested,
decided, executing, and completed states. Confirm one terminal token, one tool
result, one completed turn, and no pending interaction after completion or
reload using the existing hosted-approval proof tables/helper.

Two focused sibling cases complete the decision coverage:

- Decline produces no side effect and a truthful terminal result.
- Remember Approval executes the current invocation and allows the same tool in
  the same thread without a second prompt, while a different thread still asks.

#### 5. Preserve Project context across tabs (`@smoke`)

Start an auth-sensitive Project-bound request in tab A and capture its grant ID
and context revision. Open a second thread in the same Project in tab B, move to
another application surface, then return to and resume tab A.

Verify tab A reuses its original grant ID. Both threads remain bound to the same
Project and authoritative context revision without a redundant prompt; tab B
may correctly own a different grant ID. This also covers authorization
continuity after navigation, so a duplicate eleventh case is unnecessary.

#### 6. Combine hosted approval and Word export (`@smoke`)

Use one user request that first invokes the Ask First hosted action and then
continues to `kestrel_one.word_document_create`. After approval, verify exactly
one hosted side effect and one Word artifact. Multiple logical model calls are
expected as the agent continues across tool results.

Download the `.docx`. Verify its media type, stored size, SHA-256 digest,
required package entries, and a unique token in `word/document.xml`. Verify the
browser shows one completed turn and one download link after reload.

#### 7. Resume a pending approval after process restart (`@recovery`)

Hold a hosted approval in the pending state. Stop and restart the web, turn
worker, knowledge worker, and runner while retaining the same PostgreSQL
databases, Redis data, fake-provider state, and artifact root. Do not rerun admin
creation, migrations, or model seeding. After old PIDs are gone and new health
checks pass, reopen the thread and approve.

The original prepared invocation must execute exactly once. A page reload does
not satisfy this test.

#### 8. Run a fresh approval and Word export after restart (`@recovery`)

Complete the combined flow once, restart the product stack, and create a new
thread for the same request. Verify a new approval request ID and new artifact
ID. No interaction, remembered approval, message, tool result, or download from
the first thread may leak into the second.

#### 9. Create, compile, and run a two-step workflow (`@smoke`)

Open Workflows and create a graph with a manual trigger, two Kestrel work steps,
and an output. Give step one a deterministic fact-producing instruction. Give
step two an instruction that must consume step one's output.

Save the workflow and verify the server accepts a new immutable version. Run
it. Verify both child turns complete in order, the run graph reaches Completed,
and step one's unique token is present in step two's durable input. The final
output appears on the run page and after reload. A generic repeated model
response does not prove chaining.

#### 10. Keep named collaborator work quiet and durable (`@smoke`)

Ask Kestrel to open a collaborator named Researcher, send a bounded question,
receive the reply, report the result, and close the collaborator.

Private collaborator messages must not appear as ordinary main-transcript
bubbles or collaborator-specific notifications. The Thread-level Collaborators
control and inspector move through working, ready, and archived states; the
durable record separately proves a `replied` event. Kestrel provides one normal
user-facing summary. The archived collaborator and private history remain
inspectable after reload.

## Pressure Test Results

The first draft failed six important adversarial checks:

- It treated raw provider requests as logical execution, which breaks on
  qualification, retry, and multi-tool turns.
- It assigned hosted execution observation to the fake provider, which only
  controls model responses.
- It assumed one Project grant should be shared across threads, contrary to the
  thread-scoped grant contract.
- It reused a startup script as a restart boundary even though that script
  performs stateful bootstrap and seeding.
- It asserted collaborator `replied` and `closed` UI states that do not exist.
- It called eleven equally expensive scenarios a smoke, undermining the quick
  local feedback goal.

The revised design also requires data isolation by identity, not merely
Playwright's current single-worker setting. The remaining known product-risk
probe is the selected-model fallback: an unready stale model may still render
in the selector. If the test proves a user can submit it or gets no useful
blocked reason, the composer/new-turn readiness guard is the first owning
product seam; server-side selection remains defense in depth.

## Decisions

- Reuse the product-contract lane instead of adding a parallel browser stack.
- Use Luna as the exact deterministic model identity for the smoke.
- Keep each scenario independent while sharing one local stack.
- Require visible, durable, and external-boundary proof for every case.
- Treat process restart as a new product-stack process set with persisted state.
- Treat collaborator quietness as a presentation invariant, not a setting.
- Define the workflow as two work steps plus trigger and output.
- Use finite test, assertion, startup, and whole-suite timeouts.
- Preserve traces, screenshots, console output, network logs, and the last
  authoritative state on failure.
- Separate one-time bootstrap from restartable services.
- Classify provider traffic and count logical calls and durable effects.
- Prove tool execution from Kestrel state plus observable terminal output.
- Treat Project grants as thread-scoped continuations over a common revision.

## Remaining Design Questions

No question blocks this design. If “2-node workflow” was intended to mean two
total graph nodes, that one scenario should be revised to trigger → output. The
current contract supports it, but it would not prove Kestrel work-step execution
or output chaining.
