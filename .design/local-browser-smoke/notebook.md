# Local Browser Smoke Design Notebook

## Current Position

Extend the existing Chromium product-contract lane instead of creating a second
browser stack. Add a curated smoke surface that uses the same local web app,
PostgreSQL, Redis, workers, local storage, and deterministic fake provider, but
can run headless, headed, or in Playwright UI Mode.

The smoke must prove the stated product behaviors at three levels: visible UI,
durable Kestrel state, and the external execution boundary. A visible success
message alone is not enough.

Pressure testing narrowed this into two speeds. `@smoke` is the fast,
high-value browser contract. `@decision-matrix` and `@recovery` contain slower
approval variants and real-process restart cases. Their union is the full local
browser contract; calling every case a smoke would make the lane too slow and
fragile to use routinely.

## Requested Change

Create a local browser smoke for:

- provider and Luna model setup;
- model qualification and readiness enforcement;
- mid-flight agent-mode changes;
- hosted approval decisions and execution;
- Project context authorization across tabs and navigation;
- hosted approval followed by Word export;
- workflow creation, compilation, execution, and output;
- quiet named-collaborator presentation with durable completion state.

## Starting Sources

- `apps/web/playwright.product.config.ts`
- `apps/web/scripts/product-validation-stack.mjs`
- `apps/web/tests/product/*.spec.ts`
- `tests/ops/helpers/fake-open-router.ts`
- `apps/web/components/settings/ai-providers-client.tsx`
- `apps/web/app/api/models/approved/route.ts`
- `apps/web/components/chatbot/chat.tsx`
- `apps/web/components/chatbot/multimodal-input.tsx`
- `apps/web/components/chatbot/interaction-panel.tsx`
- `apps/web/lib/projects/context-grants.ts`
- `apps/web/lib/workflows/contracts.ts`
- `apps/web/lib/workflows/runtime.ts`
- `apps/web/components/chatbot/collaborator-inspector.tsx`
- `.design/hosted-approval-simplification/notebook.md`
- `.design/kestrel-workflows/notebook.md`
- `.design/named-sub-agents/notebook.md`

## Relevant Current Behavior

The Chromium product-contract lane already launches a real local Kestrel One
stack with one worker, one runner, a fake provider, PostgreSQL, Redis, and local
artifact storage. Existing product tests cover page layout, model administration,
workflow editor rendering, durable turns, reload recovery, and queued-turn
coordination.

The current workflow browser tests do not save or run a workflow. The current
conversation browser tests do not cover model readiness, mode switching, hosted
approval, process restart, Project context continuity, Word export, or named
collaborators.

The product config sets test and assertion timeouts to zero. That can turn a
smoke failure into an indefinite wait. Initial finite limits should be generous
and report the last authoritative state; tighten them only after observing real
durations.

The provider fixture is hard-coded to `z-ai/glm-5.2`. The requested smoke uses
the Luna model, so the deterministic provider identity and seeded model must be
changed together.

The model API returns only models ready for the requested runtime role. The
composer selector also merges its selected fallback into that returned list.
The smoke must therefore prove that a stale or manually selected unready model
cannot produce an agent-turn provider request. Qualification and catalog calls
are legitimate provider traffic and must be classified separately.

The fake provider observes model traffic and emits requested tool calls; it
does not execute hosted tools. Tool execution must be proven from Kestrel's
authoritative approval/execution records and a reversible observable effect.
The preferred approval action is `exec_command` with a harmless command whose
durable terminal output is asserted. The fixture must seed the
Environment/Project capability policy that exposes the tool.

`RuntimeIO.callId` identifies one logical model call. Transport retries can
produce several HTTP attempts for that call, and a tool-using turn can require
several logical calls. Duplicate protection must compare turn IDs, logical call
IDs, prepared invocation IDs, and effects; raw HTTP count is not exactly-once
proof.

Project context grants are scoped to a thread and actor, not shared globally by
every tab in a Project. Continuity means tab A resumes with tab A's original
grant ID and authoritative context revision. Tab B may own another grant ID for
the same revision.

The current product stack script performs one-time admin creation and model
seeding before starting services. Re-running it is not a clean restart and can
rewrite the state under test. Bootstrap and service lifecycle must be split
before recovery cases are trustworthy.

Collaborator quietness is not a user-selectable mode. It is a presentation
invariant: private collaborator parts are removed from the ordinary transcript
and grouped in the Collaborators inspector. The visible lifecycle is
`working -> ready -> archived`; `replied` is an event, not a visible state.

Workflow validation requires exactly one trigger and one output. “Two-node
workflow” is defined here as two Kestrel work steps plus those two required
structural nodes.

## Affected Surface

- Product-contract launcher, configuration, reporters, timeouts, and artifacts.
- Deterministic provider scenarios and classified model-request inspection.
- Browser fixtures for organization, Project, thread, app connection, and model
  state.
- Provider/model administration and composer model selection.
- Durable turns, interaction mode, hosted interactions, and prepared tool calls.
- Project context revisions, grants, and grant renewal.
- Stored Word artifacts and browser downloads.
- Workflow definitions, versions, child turns, and run output.
- Collaborator dialog events, quiet transcript projection, and inspector state.

## External Research

- Playwright UI Mode can run and filter individual tests or tags while exposing
  the action timeline, DOM, console, network, and attachments. This fits the
  requested local browser experience.
- Playwright supports one or more managed local web servers, but the current
  config owns the stack for the whole run. A real mid-suite process restart
  therefore needs a restart-capable product-stack controller, not `page.reload()`.
- Playwright has separate test, assertion, and global timeouts. The smoke should
  use finite limits and attach the last observed state on timeout.

## Candidate Seams and Options

### Extend the existing product-contract lane

Selected. It already owns the correct application, data, worker, runner, and
provider boundaries. It keeps the smoke deterministic and makes the same tests
available to local development and `validate:chromium`.

### Add a separate manual-only checklist

Rejected as the primary seam. A checklist is useful for exploratory release
testing, but it cannot prove no provider execution, exact approval identity,
durable grant continuity, or restart behavior.

### Drive a normal developer stack with browser mocks

Rejected. Browser route mocks would bypass the server boundaries that these
scenarios are intended to test.

### Build one long serial golden-path test

Rejected. It makes later failures depend on earlier setup and hides which
contract regressed. The curated smoke should share one stack but isolate each
scenario's records and deterministic provider state.

## Proposed Delta

Add a reusable local smoke launcher around the product-contract environment.
Expose three modes: headless, headed Chromium, and Playwright UI Mode. Tag the
curated scenarios so the same specs continue to run inside the broader Chromium
validation lane.

Extract one-time bootstrap from restartable service control. The launcher owns
environment allocation and bootstrap once, then can stop and start the web,
turn worker, knowledge worker, and runner while PostgreSQL, Redis, artifact
storage, and the fake provider remain stable. Recovery waits for old PIDs to
exit and new health checks to pass. This controller remains outside application
HTTP routes.

Extend the deterministic provider from prompt substring branches into named
scenarios with control and inspection endpoints. Each scenario records request
class, logical call ID, model, attempt, and advertised/requested tools. It can
hold or emit model responses, but Kestrel records—not the provider—prove hosted
tool execution.

Use one shared browser fixture contract. Each test creates unique organization,
Project, thread, workspace, and request identities. The administrative setup
test uses an isolated organization so it cannot disable the canonical seeded
Luna model needed by other tests. Tests reset only their provider scenario and
namespace only their own records; workers equal to one is not data isolation.

Every smoke test asserts:

1. the expected UI state;
2. the authoritative turn, interaction, workflow, or grant state;
3. the expected logical model-call identities or observable tool execution;
4. absence of duplicate messages, executions, approvals, or artifacts;
5. bounded cleanup or terminal state.

### Scenario contracts

1. **Add provider and Luna model (`@smoke`).** In an isolated organization, add
   an OpenRouter provider from Connections, sync or add
   `openai/gpt-5.6-luna`, and verify it starts unapproved and unavailable to
   chat. Approve it, observe compatibility checking, and verify Ready status,
   exact provider identity, economics evidence, and `agent.loop` eligibility.
2. **Enforce model readiness before execution (`@smoke`).** Attempt to select
   the unready Luna identity through the visible selector and a stale model
   cookie. Verify the model is absent or blocked, the send action gives a useful
   reason, no turn begins with it, and zero classified agent-turn requests reach
   the provider. Qualification/catalog traffic is allowed. After qualification,
   verify an agent-turn request uses the ready Luna identity.
3. **Change mode during an active request (`@smoke`).** Start a delayed logical
   model call, capture the turn and `RuntimeIO.callId`, change Chat to Build,
   then release the provider. Verify the original turn completes once, its
   original effective mode stays unchanged, Build persists for the next turn,
   and neither the turn nor held logical call is cancelled, replaced, or
   duplicated. Later legitimate agent-loop calls are allowed.
4. **Complete hosted approval (`@smoke`, with `@decision-matrix` siblings).**
   Trigger `exec_command` with a harmless command that emits a unique token in a
   test workspace. Verify the exact presentation and choices, then Approve Once
   and prove decision, execution, durable terminal token, result, completion,
   and cleanup from Kestrel records. Put Decline and Remember Approval in
   `@decision-matrix`, including no effect after decline and remembered scope
   exactly matching the product contract.
5. **Preserve Project context across tabs and navigation (`@smoke`).** Start an
   auth-sensitive Project request in tab A and capture its grant and context
   revision. Open another Project thread in tab B, navigate away, then return to
   and resume tab A. Verify tab A reuses its original grant ID, both threads use
   the authoritative Project context revision, and no redundant prompt appears.
   Tab B may correctly have a different grant ID.
6. **Compose approval and Word export (`@smoke`).** In one user request, approve
   the hosted action and continue to `kestrel_one.word_document_create`. Verify
   ordered prepared tool calls, one hosted effect, one completed user turn, one
   downloadable `.docx`, stored metadata/hash, required ZIP entries, and a
   unique token in `word/document.xml`. Multiple logical model calls are
   expected for this agent loop.
7. **Recover pending approval across restart (`@recovery`).** Stop and restart
   the web, turn worker, knowledge worker, and runner while approval is pending.
   Do not rerun bootstrap or replace PostgreSQL, Redis, fake-provider state, or
   artifact storage. After new services are healthy, approve and verify the
   original prepared invocation and effect occur exactly once.
8. **Run a fresh flow after restart (`@recovery`).** After a completed
   approval-plus-Word flow, restart services and create a new thread. Verify new
   approval and artifact IDs without leaked interactions, remembered grants,
   messages, or downloads.
9. **Create and run a workflow (`@smoke`).** Build two Kestrel work steps between
   the required trigger and output, save an immutable version, and run it.
   Verify both child turns complete, the graph reaches Completed, and step one's
   unique token is present in step two's durable input before it appears in the
   final output after reload.
10. **Keep collaborator work quiet and durable (`@smoke`).** Open a named
    Researcher, send work, receive a reply, summarize, and close it. Verify
    private messages never appear as main transcript bubbles or
    collaborator-specific notifications. The inspector moves through working,
    ready, and archived; durable evidence separately proves `replied`. The
    parent gives one normal summary, and the archived collaborator remains
    inspectable after reload.

## Domain Model

- **Browser smoke:** the small deterministic `@smoke` subset, not every browser
  test and not a live-provider canary.
- **Full local browser contract:** `@smoke`, `@decision-matrix`, and `@recovery`
  together.
- **Full coverage:** every state transition in the requested scenarios has UI,
  durable-state, and external-boundary proof. It does not mean all Kestrel
  features or all failure modes.
- **Restart:** new web, turn-worker, knowledge-worker, and runner processes using
  the same PostgreSQL, Redis, fake-provider state, and artifact root, without
  rerunning bootstrap. A page reload is not a restart.
- **Quiet collaborator:** private collaborator messages stay out of the main
  transcript while durable status and history remain available in the
  Collaborators inspector. It is not a settings toggle.
- **Two-step workflow:** two Kestrel work nodes plus one trigger and one output.

## Decisions

- Reuse the product-contract lane. Confidence: high.
- Use the Luna identity throughout this smoke and remove GLM from its effective
  provider configuration. Confidence: high.
- Keep scenarios atomic and data-isolated while sharing one local stack.
  Confidence: high.
- Assert browser, durable state, and execution boundary for every scenario.
  Confidence: high.
- Make process restart a first-class launcher operation. Confidence: high.
- Treat collaborator quietness as an invariant rather than a setting.
  Confidence: high.
- Interpret the workflow request as two work steps plus structural nodes.
  Confidence: medium; reopen if the intended workflow truly contains only a
  trigger and output.
- Use finite per-test, assertion, and whole-suite timeouts. Confidence: high.
- Count logical call IDs and durable effects rather than raw provider attempts.
  Confidence: high.
- Keep tool-execution proof in Kestrel's records and observable fixture output,
  not in the fake provider. Confidence: high.
- Treat Project context continuity as per-thread grant reuse against the same
  revision, not one grant shared across tabs. Confidence: high.

## Pressure Test Findings

- The current stack script cannot be reused as the restart command because it
  recreates the dev admin and reseeds the gateway/model before starting services.
- The product environment allocator is private to the validation runner, so the
  launcher needs a shared allocation/bootstrap seam before headed and UI modes
  can be first-class commands.
- The fake provider cannot authoritatively observe hosted tool execution.
- Raw request counts conflate qualification, retries, and agent-loop
  continuations; logical call IDs plus durable effects are the stable proof.
- Project grants are thread-scoped, so a cross-tab shared-grant assertion would
  encode the wrong product contract.
- `replied` is a collaborator event; the visible lifecycle uses working, ready,
  waiting, paused, problem, and archived.
- Eleven equal-weight smoke cases were too broad. Core, decision-matrix, and
  recovery tags preserve target coverage without destroying feedback speed.

## Research and Prototypes

No prototype was required. The existing product lane already proves that the
stack can be driven by Playwright. The unresolved work is contract coverage and
restart orchestration, not framework feasibility.

## Active Change Frontier

- No product decision blocks a coherent test design.
- The only terminology question is whether “2-node workflow” meant two work
  steps or two total nodes. The design uses two work steps because the current
  contract requires structural trigger and output nodes.

## Decision Map

- Status: not needed
- Path: none
- Destination: none
- Return condition: none

## Best Next Move

First extract a reusable environment/bootstrap controller and prove it can start
once, restart only services, and preserve a sentinel database record. Then add
classified Luna provider scenarios and the readiness vertical slice. Add the
remaining atomic contracts without changing runtime product logic unless a
smoke exposes a separately diagnosed product failure.
