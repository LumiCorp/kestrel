# Kestrel Workflows Design Notebook

## Current Position

Kestrel Workflows should be a named, Project-scoped orchestration layer above the existing durable runtime. A workflow definition should own its trigger, stable graph, data passed between steps, and final output. The current scheduler should become one trigger adapter. The existing Kestrel runtime should continue to own model execution, tool effects, approvals, waits, policy, budgets, replay evidence, and terminal run results.

The provisional best direction is a coarse authored graph whose work steps launch ordinary Kestrel runs. An expanded step can show the model and tool calls that occurred inside that run. This gives the workflow a stable trigger-to-output shape without forcing the current single-cursor agent runtime to become a parallel DAG scheduler.

One product choice is still open. The user may instead intend every model call and tool call to be an authored, independently retryable graph node. That choice would require a different public contract and a deeper runtime change.

## Starting Sources

- Participant request on August 26, 2026: use the existing Kestrel runtime as a DAG-like workflow engine, represent triggers, tool calls, model calls, and output, and name and run workflows like scheduled prompts.
- [Scheduled runs product guide](../../apps/docs/content/kestrel-one/scheduled-runs.mdx).
- [Schedule persistence](../../apps/web/lib/schedules/store.ts).
- [Schedule materialization](../../apps/web/lib/schedules/runtime.ts).
- [Durable turn queue](../../apps/web/lib/turns/queue.ts).
- [Durable turn store](../../apps/web/lib/turns/store.ts).
- [Runtime execution contracts](../../src/kestrel/contracts/execution.ts).
- [Runtime model and tool I/O](../../src/engine/RuntimeIO.ts).
- [Runtime step commit](../../src/engine/StepCommitPipeline.ts).
- [Runtime replay](../../src/replay/RunReplayService.ts).
- Prior scheduled-prompt implementation and model-selection design evidence in local session memory. Current source takes precedence where behavior has changed.

## Outcomes and Constraints

### Desired outcomes

- A user can name a workflow and run it now, test it, or start it from a schedule.
- A user can understand the path from trigger to final output.
- A run shows which workflow version executed and the state of every authored step.
- The system reuses Kestrel's current model, tool, approval, authorization, budget, wait, recovery, and evidence boundaries.
- A retry never silently duplicates a tool effect or changes the definition used by an active run.
- Each run produces one explicit, machine-readable workflow result and a human-reviewable record.

### Important constraints

- The current runtime is a durable single-cursor state machine. It is not a general dependency scheduler.
- One scheduled occurrence currently snapshots its title, prompt, model, trigger, Thread ID, and message ID before it enters the ordinary durable Thread-turn pipeline.
- Schedule materialization and runtime completion are different states. The existing `materialized` schedule status means the Thread turn exists, not that its work finished.
- Schedule and turn dispatch already depend on stable identities, row locks, idempotency keys, queue recovery, and fail-closed Project and creator access checks.
- A schedule does not widen Project, Environment, App, model, network, credential, or approval authority.
- The current runtime can persist waits and exact resumes. A workflow must not infer success from a worker process or queue job alone.
- Tool calls must continue through preparation, policy, approval binding, boundary decisions, effect persistence, and replay evidence.
- Node retry must create a new attempt identity. Reusing a completed or failed tool-effect identity would violate current effect semantics.
- The current Thread queue serializes turns. It cannot express branch readiness, joins, or workflow output bindings.

### Non-goals

- Do not replace Kestrel's runtime, tool gateway, model gateway, approval system, or replay system.
- Do not treat an assistant's prose answer as the workflow's machine-readable state.
- Do not turn the first design into a general-purpose ETL or arbitrary-code platform.
- Do not create a backlog, implementation plan, or production code during design.
- Do not assume cycles, dynamic graph rewriting, or unbounded fan-out merely because the feature is described as DAG-like.

## Working Design Views

### Experience

The smallest value loop is:

1. The user creates a named workflow in a Project.
2. The user defines a trigger and a small graph from input to output.
3. The user tests the saved version with realistic input.
4. Kestrel shows step readiness, execution, waits, failures, and produced values.
5. The user inspects the final output and expands a Kestrel step to see its model and tool activity.
6. The user enables the workflow's schedule or starts it manually later.

The current Schedules surface already establishes useful expectations: a recognizable title, Run test, pause or enable, Project ownership, a selected model, operational status, and a link to a reviewable Thread. Workflows should preserve that compact operating loop while moving schedule details into one trigger type.

### Domain responsibilities and boundaries

- **Workflow:** a named Project-scoped definition of how a trigger becomes an output. A workflow is not a schedule.
- **Workflow version:** an immutable definition snapshot. Every execution points to exactly one version.
- **Trigger:** an event that requests an execution. Initial candidates are manual, test, and cron schedule.
- **Workflow execution:** one attempt to run one workflow version with one input value and one authority snapshot.
- **Step:** an authored unit with declared inputs, outputs, and readiness dependencies.
- **Step attempt:** one durable attempt to execute a step. A retry is a new attempt, not a mutation of old evidence.
- **Kestrel run:** the existing runtime execution used by an agentic work step.
- **Call evidence:** the model and tool calls observed inside a Kestrel run. Whether calls can also be authored steps remains unresolved.
- **Workflow output:** the explicit value or artifact reference returned by the output step when the execution completes.

Provisional invariants:

- A workflow execution never changes definition versions after it starts.
- A step becomes ready only after its declared predecessors reach an allowed terminal state and its required inputs exist.
- A completed step attempt is never re-executed under the same attempt identity.
- A workflow execution is complete only when its declared output is durably available.
- Model and tool activity cannot exceed the authority attached to the Project, creator, Environment, and workflow version.
- The orchestration ledger and runtime ledger remain distinct but linked. Neither infers the other's state from text.

### Information and state

The working state model is:

```text
workflow
  -> immutable workflow version
       -> trigger definitions
       -> step definitions and dependency edges
       -> input and output contracts

trigger occurrence
  -> workflow execution
       -> step execution
            -> step attempt
                 -> Kestrel run / durable turn / tool effect links
                 -> input snapshot
                 -> output value or artifact reference
                 -> wait, failure, or terminal evidence
       -> final workflow output
```

Data should move between steps as typed JSON values or artifact references. Each step should receive an explicit input projection and publish an explicit output. This follows the established workflow rule that states consume input and produce output, while keeping Kestrel artifacts available for large values. AWS Step Functions exposes a more elaborate version of this pattern through state input, task parameters, result selection, and state output ([AWS input and output processing](https://docs.aws.amazon.com/step-functions/latest/dg/concepts-input-output-filtering.html)). Kestrel should start with a smaller mapping language unless a concrete workflow requires more.

### External systems and integrations

- The schedule worker supplies cron trigger occurrences and outage coalescing.
- The durable Thread-turn pipeline supplies ordinary Kestrel run creation, queueing, execution, waits, and human review.
- The Project Environment supplies model, App, tool, credential, network, and approval authority.
- The artifact store carries large step results without putting them into assistant text or every event.
- Runtime replay supplies child-run evidence. The workflow view must correlate that evidence with workflow version, step, and attempt identities.

### System responsibilities

The proposed boundary has three layers:

1. **Workflow control plane.** Own definitions, versions, validation, trigger registration, execution state, dependency readiness, step attempts, data bindings, retry policy, cancellation propagation, and final output.
2. **Workflow step adapter.** Translate a ready authored step into an ordinary Kestrel run or a policy-safe direct operation. Correlate the result back to the step attempt.
3. **Existing Kestrel runtime.** Own model calls, compiled agent decisions, tool preparation and effects, approvals, waits and resumes, budgets, events, artifacts, replay, and terminal run results.

The workflow graph should not reuse runtime regions as its durable scheduler. Regions provide bounded runtime coordination, but they do not own versioned node definitions, dependency edges, conditional joins, per-node attempts, or output bindings.

### Important qualities

- **Durability:** definition, run, step, attempt, wait, and output state survive worker loss.
- **Determinism:** the same workflow version and durable events produce the same readiness and terminal-state projection.
- **Idempotency:** trigger receipt, step dispatch, tool effects, and retries have separate stable identities.
- **Inspectability:** authored graph state and nested runtime evidence remain distinguishable.
- **Policy continuity:** workflow composition cannot bypass the current Environment and execution boundaries.
- **Version clarity:** editing a workflow affects only later executions.
- **Compact operation:** common workflows remain as easy to name, test, enable, pause, and inspect as current schedules.

## Solution Directions

### Runtime-native typed DAG

The user authors every Model, Tool, Gate, Join, and Output node. The existing engine gains dependency scheduling and node eligibility.

This direction offers the strongest preflight, cost control, and node-level retry. It also creates a second control model inside a runtime built around one current step and one active run. It is weakened if most useful work is adaptive or if raw provider and tool calls should not become a public authoring contract.

### Intent-defined workflow with an observed graph

The user saves a title, trigger, prompt, capability limits, and expected output. Kestrel runs one ordinary agent turn. The product projects the actual model and tool events into a graph during or after execution.

This direction is closest to scheduled prompts and preserves the runtime unchanged. The graph is evidence, not a stable execution definition, so it cannot support dependable node-level branches, retries, or input contracts. It is weakened if users need to inspect and approve the structure before execution.

### Coarse authored graph over ordinary Kestrel runs

The user authors a stable graph of Kestrel work steps, deterministic tool steps where needed, gates, joins, and one output. Each Kestrel work step launches an ordinary durable run. Expanding it reveals the actual model and tool calls inside that run.

This is the provisional recommendation. It preserves the current runtime as the unit of reliable agentic work while adding real graph semantics above it. Its main cost is a two-level mental model and an explicit contract for passing context and artifacts between child runs. It is weakened by a hard requirement that every individual model or tool call be authored and independently retryable.

## Decisions

- Keep workflow orchestration separate from the current runtime state machine. Rationale: the runtime has a single execution cursor and one active run per session, while workflow branching needs independent durable readiness and attempt state. Confidence: high. Reopen only if current runtime evidence reveals a hidden general dependency scheduler.
- Keep schedule as a trigger, not the owner of workflow execution. Rationale: the current schedule layer already stops at durable turn materialization. Confidence: high.
- Reuse ordinary Kestrel execution for agentic work. Rationale: this preserves current policy, effect, wait, budget, and replay boundaries. Confidence: high.
- Snapshot an immutable workflow version for every execution. Rationale: the current schedule system already proves the need to protect claimed runs from later edits. Confidence: high.
- Use explicit step outputs rather than assistant prose as workflow state. Rationale: runtime final output and artifact-backed payloads already separate machine state from presentation. Confidence: high.
- Treat the coarse authored graph as provisional until the participant settles graph authorship. Confidence: medium.
- Keep the ordinary notebook frontier. A decision map is not needed yet because the current questions fit one compact dependency order.

## Research and Prototypes

- Current Kestrel source shows that a runtime transition can atomically carry state, effects, events, artifacts, claims, waits, and region operations. This is a strong step-completion primitive, but execution still advances through one current step.
- Current Kestrel source shows model calls and tool effects already have durable identities, policy evidence, retries, approvals, usage, and replay data. A workflow should correlate these facts instead of recreating them.
- Current Kestrel source shows schedule runs already use version-like snapshots, occurrence and request idempotency, fail-closed authority checks, and queue recovery.
- AWS Step Functions separates task states from flow states and gives each state input and output ([AWS workflow states](https://docs.aws.amazon.com/step-functions/latest/dg/workflow-states.html)). This supports separating Kestrel work from graph control and data flow.
- LangGraph checkpoints graph state at step boundaries and requires idempotent side effects when a node can re-execute ([LangGraph interrupts](https://langchain-ai.github.io/langgraph/concepts/breakpoints/), [LangGraph graph API](https://langchain-ai.github.io/langgraph/how-tos/configuration/)). This reinforces Kestrel's need for durable step-attempt identities and explicit retry semantics.
- No prototype is justified yet. The unresolved question is product intent, not technical feasibility.

## Active Design Frontier

1. Is the authored graph coarse, with model and tool calls shown as nested runtime evidence, or must every call be an authored node?
2. Does one workflow execution appear as one parent Thread with nested step activity, or as a workflow run page linked to child Threads?
3. What is the smallest control-node set after the authorship model is settled: output only, or also condition, parallel, join, wait, and approval?
4. Which trigger types belong in the first coherent experience beyond manual, test, and cron schedule?

## Decision Map

- Status: not needed
- Path: none
- Destination: settle the workflow authoring and execution model
- Return condition: trace the defining experience through one coherent solution and publish the solution design

## Best Next Move

Ask the participant to settle whether the workflow graph is authored at the level of Kestrel work steps or at the level of individual model and tool calls. This needs product judgment. The answer will determine the public node contract, run hierarchy, retry model, and editor experience.
