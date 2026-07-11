# Kestrel Runtime Glossary

## Terms

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

**Project**
A durable workspace or repository container that owns operator-visible planning and runtime context.

**Board**
A project-owned planning surface that organizes cards by work state.

**Lane**
A board column representing a card work state.

**Card**
A project-scoped work item seeded from a user prompt or task.

**Card ID**
A stable project-visible identifier for a card, scoped to its project.

**Card Prompt**
The user-authored work request on a card that can seed a thread.

**Implementation Thread**
An assigned thread that works a card toward testable output.

**Testing Thread**
An assigned thread that validates card output and returns a testing verdict.

**Testing Verdict**
A structured testing-thread result of pass or fail.

**WIP Limit**
A lane-level constraint on how many cards can be in active work at once.

**Autopilot**
A project mode that lets Kestrel automatically start work from eligible cards.

**Card Claim**
A durable Autopilot record that assigns active work on a card to a thread.

**Card Evidence**
Structured history attached to a card from assigned thread outcomes.

**Card Creation Tool**
An agent tool that creates cards during a thread.

**Card Movement Tool**
An agent tool that moves cards between lanes.

**Card Update Tool**
An agent tool that edits card content before active work starts.

**Context Checkpoint**
An operator or context-recovery signal for runtime attention, compaction, handoff, split, or fan-in review.

**Working Plan**
The durable, user-visible summary of the agent's current chunk, intended commands, progress, and next action.

**Narration Memory**
Model-authored progress narration retained as working memory for collaboration and continuity.

**Provenance Hash**
A hash-only identity for model-call audit data. It identifies the provider payload or Kestrel prompt components without retaining rendered prompt text.

## Relationships

- A **Project** owns exactly one **Board**.
- A **Board** is persisted in runner/runtime project state.
- A **Board** uses versioned updates for shared Web, Desktop, tool, and Autopilot changes.
- A **Board** contains zero or more **Cards**.
- A **Board** uses **Lanes** for idea, planned, wip, testing, and done work states.
- **Lanes** are fixed in the first version.
- A **Card** has a stable **Card ID** visible to operators and tools.
- A **Card** can link to one or more **Threads** over time.
- A **Thread** belongs to exactly one **Card**.
- A **Thread** can exist without a **Card**.
- A **Project** can contain any number of unassigned **Threads**.
- A **Card** needs a title and **Card Prompt** before it is eligible for **Autopilot** pickup.
- A **Card** can have many linked **Threads** over time, but only one active **Thread** at a time.
- A linked **Thread** remains active for a **Card** until terminal output, cancellation, or explicit detachment.
- **Autopilot** is enabled or disabled at the **Project** level.
- **Autopilot** starts normal **Threads** from eligible **Cards**.
- **Autopilot** evaluates on relevant board or thread changes and can be manually run by an operator.
- **Autopilot** only claims **Cards** from a fresh **Board** version.
- When **Autopilot** moves a **Card** from planned to wip, it creates and assigns a **Thread** to that **Card**.
- **Autopilot** records a **Card Claim** before starting an assigned **Thread**.
- If **Autopilot** cannot start the claimed **Thread**, it clears the **Card Claim** and returns the **Card** to its source **Lane** with evidence.
- Operators can manually move **Cards** between **Lanes**.
- Manual **Card** movement can override **Autopilot** state.
- Operators can manually split **Cards**.
- **Autopilot** does not split **Cards** in the first version.
- Agents can create **Cards** during a **Thread** through the **Card Creation Tool**.
- The **Card Creation Tool** only creates **Cards** in the idea **Lane**.
- The **Card Creation Tool** does not automatically link the creating **Thread** to the new **Card**.
- Agents can move **Cards** between **Lanes** through the **Card Movement Tool**.
- Agents can update idea and planned **Cards** through the **Card Update Tool**.
- The **Card Movement Tool** moves **Cards** one workflow step at a time.
- The **Card Movement Tool** can promote **Cards** from idea to planned and demote **Cards** from planned to idea.
- The **Card Movement Tool** cannot move **Cards** into the wip **Lane**.
- The **Card Movement Tool** cannot move **Cards** into the done **Lane**.
- The **Card Movement Tool** cannot move **Cards** from testing to planned.
- Each **Autopilot** pickup claims exactly one **Card**.
- Only **Cards** in the planned **Lane** are eligible for **Autopilot** pickup.
- **Autopilot** chooses eligible **Cards** by explicit board order.
- Board order is the only first-version priority mechanism for **Cards**.
- **Autopilot** respects the **WIP Limit** before moving **Cards** into the wip **Lane**.
- The **WIP Limit** counts **Cards** in the wip **Lane**, not running **Threads**.
- A waiting or blocked **Thread** keeps its linked **Card** in the wip **Lane** until terminal result or operator movement.
- By default, completed **Autopilot** work moves a **Card** from the wip **Lane** to the testing **Lane**, not directly to done.
- Normal terminal success from an implementation **Thread** moves a **Card** from the wip **Lane** to the testing **Lane**.
- Terminal failure from an implementation **Thread** moves a **Card** back to the planned **Lane** with evidence.
- **Autopilot** can start a testing **Thread** for a **Card** in the testing **Lane**.
- A **Testing Thread** validates work but does not repair it.
- **Autopilot** prioritizes testing **Cards** before planned **Cards** when both are eligible.
- A testing **Thread** produces a **Testing Verdict** for its **Card**.
- A testing failure moves a **Card** back to the planned **Lane** with evidence for planning the fix.
- A successful testing phase lets **Autopilot** move a **Card** to the done **Lane**.
- **Autopilot** does not pause **Cards** automatically because of repeated failures in the first version.
- **Card Evidence** is appended without rewriting the original **Card Prompt**.
- **Card Evidence** is append-only.
- **Cards** do not have comments in the first version.
- **Cards** do not have direct attachments in the first version.
- Operators can delete idea and planned **Cards** that do not have an active **Thread**.
- Agents cannot delete **Cards**.
