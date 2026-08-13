# Kestrel Runtime Glossary

## Runtime terms

**Session**
A durable runtime identity that owns versioned runtime state across one or more runs.

**Thread**
The operator-visible work container for a session. Threads carry waits, supervision, runtime assembly, and operator focus.

**Turn**
A user-visible request/response unit. A turn begins with an initial user submission and remains the same turn across approvals, replies, and resumes until terminal output.

**Turn Segment**
One submitted execution event inside a turn, such as the initial submission, a user reply, an approval reply, or a resume.

**Run**
One execution attempt for a submitted event. A turn can contain multiple runs when it waits and later resumes.

**Step**
A registered graph transition inside a run, such as route, extract, deliberate, execute, observe, wait, or finalize.

**Command**
A typed agent intent emitted from a step snapshot for the command processor to execute or translate into state, waits, effects, observations, and next-step routing.

**Effect**
A durable side-effect request handled by runtime effect execution rather than direct model-authored mutation.

**Workspace Checkpoint**
A file-restore snapshot for workspace state.

**Context Checkpoint**
An operator or context-recovery signal for runtime attention, compaction, handoff, split, or fan-in review.

**Working Plan**
The durable, user-visible summary of the agent's current chunk, intended commands, progress, and next action.

**Narration Memory**
Model-authored progress narration retained as working memory for collaboration and continuity.

## Mission Control terms

**Mission Control Project**
The authoritative project document for planned work, attempts, run links, evidence, review, and acceptance. It is distinct from active runtime control and Git workspace mutation.

**Work Item**
A project-scoped unit of work with a stable identity, instructions, completion contract, phase, version, and order.

**Attempt**
A versioned execution attempt associated with one Work Item. Attempts link runtime activity to candidate and outcome evidence without making runtime state the project authority.

**Evidence**
Candidate-bound proof admitted for a Work Item, including changes, validation results, conditional checks, and linked runs.

**Review**
The authorized evaluation of an admitted candidate and its evidence against the Work Item completion contract.

**Acceptance**
An explicit authorized decision that the reviewed candidate satisfies the completion contract. A terminal run or phase label does not imply acceptance.

**Autopilot**
A project-level mode that starts eligible Work Items while respecting Project revision, phase, ordering, and WIP policy.

## Memory, provenance, and resource terms

**Memory Read Binding**
A trusted, versioned authorization that binds one memory retrieval to an exact tenant, user, agent, task, policy revision, namespace, scope, and document-access set. A model can provide a bounded query but cannot mint or widen this binding.

**Provenance Hash**
A hash-only identity for model-call audit data. It identifies the provider payload or Kestrel prompt components without retaining rendered prompt text.

**Model Registration**
A versioned, fingerprinted binding between one exact provider identity, one pinned model, its declared capabilities, and its secret-free runtime configuration. Registrations are trusted static inputs; they do not discover, rank, or select models.

**Budget Allocation**
A durable, revisioned resource envelope bound to one exact tenant, run, agent, subagent, or model/tool/sandbox/evaluator/embedding lineage scope. Child allocations reserve from their parent, and usage settles against a prior reservation without creating new credit.

**Process Retention Lease**
A developer-shell-owned, persisted claim that keeps one live process running until an authoritative expiry. Acquiring the first lease replaces the command wall timer; releasing or expiring the final lease stops the process. Reads never renew a lease.

**Preview Lease**
A control-plane-owned public URL-routing lease for one Workspace preview. Its stable preview ID is also the identity of the corresponding developer-shell Process Retention Lease, but the authorities remain separate.

**Preview Publication Lease**
A developer-shell-owned provisional Process Retention Lease acquired before preview liveness and publication work. It has a fixed 10-minute expiry and is atomically promoted to the final preview-backed retention lease only after the preview service returns a valid ID and authoritative expiry. Failure releases it; a runner crash can retain the process for no longer than the provisional expiry.

**Application Liveness**
A current observation of whether an application is listening on its preview port. It is transient evidence, not URL-routing state and not process-retention authority.

**Workspace Internal State**
Kestrel-owned runtime data rooted at `/.kestrel/` or the legacy `/.local/share/kestrel/` namespace. Managed-worktree preparation excludes these paths from Kestrel-generated repository baselines and worktrees without changing an application's `.gitignore`; exact legacy Kestrel baselines are repaired additively while user-authored repository history is preserved.

## Current relationships

- A **Mission Control Project** contains zero or more **Work Items** and advances through revision-checked typed actions.
- A **Work Item** may have multiple **Attempts**, but each Attempt belongs to one Work Item.
- An **Attempt** may link one or more runtime runs and their immutable outcome evidence.
- Runtime operator control owns what an active or waiting run is doing; Mission Control owns what project work exists and whether its candidate is reviewed or accepted.
- Git workspace mutation remains behind its Git-specific command contract and is not a Mission Control document write.
- **Evidence** is bound to the candidate and completion contract it proves. It is not inferred from a status label.
- **Review** follows evidence admission, and **Acceptance** requires an explicit authorized decision.
- **Autopilot** acts through the same versioned Mission Control authority as an operator; it does not bypass Project revision, WIP, review, or acceptance rules.
- Recovery resumes the exact pending runtime request. It does not directly rewrite the Mission Control Project.
- A **Preview Lease** can remain valid while **Application Liveness** is temporarily unavailable, allowing the same public URL to recover after an application restart.
- A **Preview Publication Lease** protects the backing process before Application Liveness or public URL work starts, then becomes the final preview-backed Process Retention Lease through one atomic promotion.
- A preview-backed **Process Retention Lease** adopts the Preview Lease expiry. A finalized non-preview process receives a standalone 30-minute retention lease.
- **Workspace Internal State** is operational data rather than application source and does not enter Kestrel-generated managed app worktrees.

## Legacy migration vocabulary

**Board**, **Lane**, **Card**, **Task**, **Card Claim**, **Card Prompt**, **Card Evidence**, **Testing Thread**, and the old card movement/update tools describe pre-0.8 project-state migrations and historical fixtures only. Current product copy, APIs, and new implementation work use **Mission Control Project**, **Work Item**, **Attempt**, **Evidence**, **Review**, and **Acceptance**. Do not add new Board/Card action types or project-snapshot write paths.
