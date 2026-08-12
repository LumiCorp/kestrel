# Who Should Own Each `RunnerRuntime` Member?

## Answer

`RunnerRuntime` is a composite facade over four owners: the agent Runtime,
the execution environment, Kestrel product services, and Kestrel
security/integration services. Only four existing members map directly to the
common Runtime lifecycle, and even two of those currently include side effects
owned elsewhere:

- `runTurn` becomes `startTurn` plus normalized events.
- `cancelActiveRun` becomes `cancelRun`; follow-up queue changes move to a
  product event consumer.
- `recoverOrphanedActiveRun` becomes `reconcile`.
- `close` becomes `dispose`; environment and product resources must be disposed
  by their respective owners.

`describeSession` contributes a fifth capability only after its product read
model fields are removed. No operator, task graph, workspace, project, Mission
Control, retained reasoning, or tool-gateway administration member belongs on
the common adapter.

Confidence is high for the ownership split because the interface, host routing,
and current `KestrelChatRuntime` implementations are all available locally.
The exact service boundaries inside the product and environment domains remain
an implementation design decision.

## Findings

### Observed

The current interface has 62 members. It begins with run lifecycle operations,
then exposes operator read models, task graph mutation, workspace lifecycle,
terminal control, review and validation workflows, project control, tool
gateway administration, and shutdown through one object
([source](../../cli/runner/RunnerHost.ts#L185)).

The factory reinforces that composition by constructing a runtime per profile
and passing seven positional event callbacks into it
([source](../../cli/runner/RunnerHost.ts#L500)). The default factory always
constructs `KestrelChatRuntime`, so the interface is currently an internal
Kestrel facade rather than a multi-Runtime adapter contract
([source](../../cli/runner/RunnerHost.ts#L519)).

#### Runtime lifecycle and session surface

| Existing member | Correct owner | Common adapter? | Required reshaping |
|---|---|---:|---|
| `runTurn` | Runtime Adapter | Yes | Rename to `startTurn`; accept a binding/session reference and emit normalized events rather than returning a Kestrel-shaped product result. |
| `cancelActiveRun` | Runtime Adapter + Product subscriber | Yes | Adapter cancels the native run. Kestrel product services react to `run.cancelled`; they do not execute inside the adapter. |
| `recoverOrphanedActiveRun` | Runtime Adapter | Yes | Rename to `reconcile`; return explicit native session/run state rather than only an optional run ID. |
| `describeSession` | Split: Runtime Adapter + Product read model | Partial | Keep only native session state in an adapter inspection/reconciliation result. Move thread, inbox, blocker, checkpoint, steering, and assembly fields to product services. |
| `getSessionState` | Kestrel Product Services | No | It combines session presentation with the product task graph. Runtime-native state comes from `reconcile`; product state comes from read models. |
| `close` | Split by owner | Yes, as `dispose` | Adapter releases adapter/native-session resources. Product, database, Mission Control, and environment resources close independently. |

The current `describeSession` response contains operator inbox, blocker,
checkpoint, steering, assembly, and focused-thread fields, demonstrating that
it is already a composite read model rather than native Runtime state
([source](../../cli/runner/RunnerHost.ts#L196)). The current cancellation method
also pauses Kestrel's product follow-up queue after cancelling the engine run
([source](../../cli/runtime/KestrelChatRuntime.ts#L2970)). Current `close`
closes a Mission Control execution runtime and a shared pool, so it cannot be
carried over unchanged as adapter disposal
([source](../../cli/runtime/KestrelChatRuntime.ts#L3008)).

#### Operator, conversation, and task surfaces

| Existing member | Correct owner | Common adapter? | Notes |
|---|---|---:|---|
| `listOperatorInbox` | Kestrel Product Services | No | Product read model derived from thread, interaction, and run events. |
| `listOperatorRuns` | Kestrel Product Services | No | Product run index, not native Runtime lifecycle. |
| `getOperatorThreadView` | Kestrel Product Services | No | Conversation/operator projection. |
| `listCompletedConversationMessages` | Kestrel Product Services | No | Conversation read model and delivery cursor. |
| `getOperatorRunView` | Kestrel Product Services | No | Product run projection. |
| `performOperatorAction` | Kestrel Product Orchestrator | No | Split command interpretation/read-model updates from generic `respondToInteraction`, `startTurn`, or `cancelRun` calls. |
| `performAcceptedOperatorAction` | Kestrel Product Orchestrator | No | Same split; accepted-versus-completed handoff is a product transport concern. |
| `getTaskGraph` | Kestrel Product Services | No | Product-owned task/delegation state. |
| `updateTaskGraph` | Kestrel Product Services | No | Product-owned mutation. |

`performOperatorAction` currently handles approval, rejection, reply, steering,
retry, follow-up queues, child threads, fan-in checkpoints, context
checkpoints, and assembly changes in one method
([source](../../cli/runtime/KestrelChatRuntime.ts#L2086)). Only approval/input
delivery and run control cross the neutral Runtime boundary; the other actions
remain Kestrel product behavior.

#### Workspace lifecycle and execution environment

| Existing member | Correct owner | Common adapter? |
|---|---|---:|
| `captureWorkspaceCheckpoint` | Execution Environment | No |
| `listWorkspaceCheckpoints` | Execution Environment | No |
| `inspectWorkspaceCheckpoint` | Execution Environment | No |
| `diffWorkspaceCheckpoints` | Execution Environment | No |
| `restoreWorkspaceCheckpoint` | Execution Environment | No |
| `cleanupWorkspaceCheckpoints` | Execution Environment | No |
| `restoreLatestWorkspacePromotion` | Execution Environment | No |
| `listWorkspacePromotions` | Execution Environment | No |
| `previewWorkspacePromotion` | Execution Environment | No |
| `applyWorkspacePromotion` | Execution Environment | No |
| `inspectManagedWorktree` | Execution Environment | No |
| `cleanupManagedWorktree` | Execution Environment | No |
| `restoreManagedWorktree` | Execution Environment | No |
| `retryManagedWorktreeSetup` | Execution Environment | No |
| `startUserTerminal` | Execution Environment | No |
| `listUserTerminals` | Execution Environment | No |
| `readUserTerminal` | Execution Environment | No |
| `writeUserTerminal` | Execution Environment | No |
| `resizeUserTerminal` | Execution Environment | No |
| `stopUserTerminal` | Execution Environment | No |
| `inspectWorkspaceChanges` | Execution Environment | No |
| `mutateWorkspaceChanges` | Execution Environment | No |
| `inspectWorkspaceValidation` | Execution Environment | No |
| `runWorkspaceValidation` | Execution Environment | No |
| `cancelWorkspaceValidation` | Execution Environment | No |
| `inspectWorkspaceGit` | Execution Environment | No |
| `performWorkspaceGitAction` | Execution Environment | No |

These methods occupy the largest contiguous section of `RunnerRuntime`
([source](../../cli/runner/RunnerHost.ts#L323)). Their inputs and results are
workspace resources, processes, checkpoints, promotions, validation, and Git
state. A Runtime consumes an environment binding; it does not implement these
control-plane APIs.

#### Feedback and review workflows

| Existing member | Correct owner | Common adapter? | Required reshaping |
|---|---|---:|---|
| `addWorkspaceFeedback` | Kestrel Product Services | No | Product annotation bound to an environment-owned candidate fingerprint. |
| `listWorkspaceFeedback` | Kestrel Product Services | No | Product read model. |
| `removeWorkspaceFeedback` | Kestrel Product Services | No | Product mutation. |
| `submitWorkspaceFeedback` | Kestrel Product Orchestrator | No | Product service prepares feedback, then calls adapter `startTurn`; completion updates the product record. |
| `runWorkspaceReview` | Kestrel Product Orchestrator | No | Coordinates environment snapshotting, a Runtime turn or delegation, and a product review record. |
| `listWorkspaceReviews` | Kestrel Product Services | No | Product read model. |
| `updateWorkspaceReviewFinding` | Kestrel Product Services | No | Product mutation. |
| `submitWorkspaceReviewFindings` | Kestrel Product Orchestrator | No | Converts selected findings into a new Runtime turn. |
| `submitWorkspaceValidationFailures` | Kestrel Product Orchestrator | No | Converts environment validation failures into a new Runtime turn. |

These are composite workflows, not evidence that feedback or review belongs to
the Runtime. For example, `submitWorkspaceFeedback` validates an
environment-owned candidate fingerprint, loads product feedback, constructs a
prompt, calls `runTurn`, and marks the feedback submitted
([source](../../cli/runtime/KestrelChatRuntime.ts#L1446)). That sequence should
be owned by a product orchestrator using separate environment and Runtime
ports.

#### Project and Mission Control surfaces

| Existing member | Correct owner | Common adapter? |
|---|---|---:|
| `getProjectSnapshot` | Kestrel Product Services | No |
| `getMissionControlProject` | Kestrel Product Services | No |
| `executeMissionControlAction` | Kestrel Product Services | No |
| `performProjectAction` | Kestrel Product Services | No |
| `getProjectReviewDetail` | Kestrel Product Services | No |
| `performProjectReviewAction` | Kestrel Product Services | No |

These methods are explicitly product state and commands in the tail of the
interface ([source](../../cli/runner/RunnerHost.ts#L465)). Claude Code and Codex
must not implement or simulate them.

#### Reasoning retention and tool integration

| Existing member | Correct owner | Common adapter? | Notes |
|---|---|---:|---|
| `getRetainedProviderReasoning` | Kestrel Security/Evidence Service | No | Adapter may emit permitted reasoning events; Kestrel owns retention and access control. |
| `deleteRetainedProviderReasoning` | Kestrel Security/Evidence Service | No | Retention-policy mutation. |
| `getProviderReasoningVaultStatus` | Kestrel Security/Evidence Service | No | Reports encrypted-vault readiness, not Runtime readiness. |
| `getToolRuntimeStatus` | Kestrel Tool Integration Service | No | Reports the Kestrel tool gateway and its providers. Runtime-native tool-event support belongs in the adapter descriptor. |
| `refreshToolRuntime` | Kestrel Tool Integration Service | No | Refreshes Kestrel's tool gateway. It is not a generic Runtime lifecycle operation. |

The reasoning methods directly administer the configured encrypted provider
reasoning vault ([source](../../src/kestrel/Kestrel.ts#L217)). The tool methods
delegate to Kestrel's tool gateway and return provider health
([source](../../src/kestrel/Kestrel.ts#L239),
[contract](../../src/kestrel/contracts/model-io.ts#L16)). These services can
inform a Runtime capability snapshot without becoming adapter methods.

### Inferred

The neutral adapter should have only three command families:

1. **Session lifecycle:** `createSession`, `attachSession`, `reconcile`,
   `closeSession`.
2. **Run lifecycle:** `startTurn`, `cancelRun`, and minimal run/session
   inspection needed for reconciliation.
3. **Interaction delivery:** `respondToInteraction` for native approval and
   user-input requests.

Everything else reaches the adapter through inputs or observes it through a
normalized event sink. The execution environment should be passed as a binding
or narrow set of Runtime-consumable ports; it should not become a second large
bag of optional adapter methods.

The current `RunnerRuntimeFactory` should therefore be replaced by explicit
construction of three dependencies:

```ts
interface RunnerHostServices {
  runtimes: RuntimeAdapterRegistry;
  environments: ExecutionEnvironmentService;
  product: KestrelProductServices;
}
```

The Kestrel implementation can retain a private `KestrelRuntimeExtension`, but
ordinary turn execution must type-check and run using only `RuntimeAdapter`.

## Contradictions and Unknowns

- The existing interface exposes no explicit `respondToInteraction` member.
  Approval, reply, and retry are hidden inside `performOperatorAction` and
  `performAcceptedOperatorAction`. The extraction must establish whether every
  supported interaction can be represented by the existing versioned
  interaction request contract.
- `runWorkspaceReview` supports both current-thread and detached-thread modes.
  Its owning product orchestrator may need a generic way to select a Runtime
  participant without knowing adapter implementations.
- Kestrel's own adapter may need native inspection beyond the common contract.
  That should remain a separately discovered, versioned Kestrel extension.
- Tool availability may depend on both the native Runtime and the execution
  environment. Capability negotiation must identify which owner asserted each
  capability instead of collapsing both into one flat list.

## Implications

1. Do not finalize `RuntimeAdapter` by mechanically copying lifecycle-looking
   methods out of `RunnerRuntime`; `cancelActiveRun`, `describeSession`, and
   `close` already contain mixed ownership.
2. Introduce product and environment ports beside the adapter before switching
   `RunnerHost`, so routing can move without dropping Kestrel behavior.
3. Make normalized events the integration point for product projections.
   Product services should subscribe to events rather than being called by
   Claude Code, Codex, or the Kestrel adapter.
4. Build the first contract tests around create/attach, start, interaction,
   cancel, reconcile, terminal events, and dispose. Workspace and Mission
   Control tests belong to their own service contracts.
5. Preserve the current facade during migration as a compatibility composition
   root; retire members only after their host routes have moved to the correct
   owner.

## Sources

- [`RunnerRuntime` and `RunnerRuntimeFactory`](../../cli/runner/RunnerHost.ts#L185)
- [`KestrelChatRuntime` operator control](../../cli/runtime/KestrelChatRuntime.ts#L2086)
- [`KestrelChatRuntime` workspace feedback submission](../../cli/runtime/KestrelChatRuntime.ts#L1446)
- [`KestrelChatRuntime` cancellation and shutdown](../../cli/runtime/KestrelChatRuntime.ts#L2970)
- [`Kestrel` reasoning vault and tool gateway methods](../../src/kestrel/Kestrel.ts#L217)
- [`ToolRuntimeStatus`](../../src/kestrel/contracts/model-io.ts#L16)
