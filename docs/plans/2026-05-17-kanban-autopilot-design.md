---
id: kanban-autopilot-design-2026-05-17
domain: web-desktop-runtime
status: draft
owner: kestrel-runtime
last_verified_at: 2026-07-01
depends_on:
  - ../../CONTEXT.md
  - ../../ARCHITECTURE.md
  - ../../apps/desktop/src/main.ts
  - ../../src/web/adapter.ts
  - ../../cli/runner/main.ts
---

# Kanban Autopilot Design

See also: [Plans index](../PLANS.md).

## Current Decisions

Each Project has one runtime-owned Board with fixed Lanes: idea, planned, wip, testing, and done. Cards are project-scoped work items with project-local Card IDs, title, Card Prompt, lane, board order, optional active claim, linked thread history, and append-only Card Evidence.

Autopilot activity is recorded as Card Evidence. The first version does not add a separate Autopilot activity log model.

Web and Desktop should expose the board immediately through shared components. The board is a Project-level view, not a thread-local panel. Assigned thread views can show minimal Card context and link back to the board.

The board should show a derived Autopilot status indicator with enabled state, WIP usage, currently claimed Cards, and the latest Autopilot event. This indicator is derived from Board and Card Evidence state, not stored as a separate state machine.

The first UI can include simple search by Card ID, title, and body plus lane filtering. It should not include saved filters or a complex query language.

Autopilot is a Project-level setting. It evaluates when enabled, on relevant board or thread changes, and through a manual operator tick. It prioritizes testing Cards before planned Cards, then uses explicit board order. The first version has no priority field, ranking score, retry cap, comments, card attachments, configurable lanes, or Autopilot-driven card splitting.

Enabling Project Autopilot is consent for Autopilot to start eligible implementation and testing Threads.

Autopilot-created and Co-pilot-created implementation and testing Threads run in `build` interaction mode with the `full_auto` act submode. For this feature, `full_auto` is allowed to bypass runtime approval prompts for those assigned card Threads, but only inside the Project's configured tool and resource scope.

Enabling Project Autopilot requires an explicit confirmation because it grants standing permission for eligible card Threads to run in project-scoped `full_auto`.

Co-pilot starts do not need a separate standing-permission confirmation. The per-card start prompt must clearly state that the created Thread will run in project-scoped `full_auto`.

The first version includes a per-Project WIP limit, defaulting to 1. Operators can raise the limit per Project. The limit applies only to Cards in the wip Lane.

Disabling Autopilot prevents new claims but does not cancel active Threads. Operators stop active Threads through normal runtime controls.

## Autopilot Flow

Autopilot can claim one eligible Card at a time. It records a durable Card Claim before starting an assigned Thread. If thread start fails, Autopilot clears the claim and returns the Card to its source Lane with evidence.

Only planned Cards are eligible for implementation pickup. When Autopilot claims a planned Card, it moves the Card to wip, creates an Implementation Thread, and assigns that Thread to the Card. WIP limits count Cards in the wip Lane, not running Threads. Waiting or blocked Threads keep their Cards in wip until terminal result or operator movement.

Normal terminal success from an Implementation Thread moves the Card to testing. Terminal failure moves the Card back to planned with evidence.

If an active Autopilot-created Thread is manually stopped, the Card moves back to planned with evidence.

If an operator manually moves a Card from wip or testing to planned or idea, any running Threads assigned to that Card are stopped and the stop is recorded as Card Evidence.

If an operator manually moves a Card to done, any running Threads assigned to that Card are stopped and the stop is recorded as Card Evidence.

Testing Cards can be picked up by Autopilot without counting against the WIP limit. A Testing Thread validates work but does not repair it. It must return a structured Testing Verdict of pass or fail. Pass moves the Card to done. Fail moves the Card back to planned with evidence for the next fix plan.

## Agent Tools

Agents can create Cards through a Card Creation Tool. Card creation always creates in the idea Lane and does not automatically link the creating Thread to the new Card.

Agents can edit idea and planned Cards through a Card Update Tool.

Agents can move Cards through a Card Movement Tool, but only between idea and planned. The tool can promote idea to planned and demote planned to idea. It cannot move Cards into wip, into done, or from testing to planned. Those transitions are reserved for Autopilot verdicts or operator action.

Operators can manually move Cards between Lanes, split Cards, and delete idea or planned Cards that do not have an active Thread. Manual movement can override Autopilot state.

When an operator manually moves a Card from planned to wip, the UI should offer to start work on the Card. If the operator accepts, the runtime creates and assigns an Implementation Thread using the same claim and prompt contract as Autopilot, then opens that chat Thread for the operator. If the operator declines, the Card can remain in wip without an active assigned Thread.

When an operator manually moves a Card from wip to testing, the UI should offer to start validation on the Card. If the operator accepts, the runtime creates and assigns a Testing Thread, immediately submits the testing prompt, and opens that chat Thread for the operator. If the operator declines, the Card can remain in testing without an active assigned Thread. Testing Cards do not count against the WIP limit.

Co-pilot starts do not require Project Autopilot to be enabled. Autopilot enabled or disabled only controls automatic claims.

## Runtime Ownership

The Board is persisted in runner/runtime project state and uses versioned updates for shared Web, Desktop, tool, and Autopilot changes. Autopilot only claims Cards from a fresh Board version.

For the first version, Autopilot runs whenever the runner service or runner process is alive. If Web/Desktop are connected to a long-lived remote runner service, Autopilot can continue after UI clients close. If Desktop is using its managed local runner process, Autopilot stops when Desktop quits because Desktop stops that runner process.

## Future Background Service

Option B is a future unattended mode where Autopilot continues after Web and Desktop close. That requires a long-lived background runner service or daemon with explicit installation, startup, shutdown, health, logging, and upgrade behavior.

Future background-service work should answer:

- How the daemon is installed and managed on each platform.
- Which Projects are eligible for unattended Autopilot.
- How each Project opts into unattended Autopilot separately from daemon installation.
- How users see daemon health, active Cards, failures, and logs.
- How credentials, approvals, and tool permissions work without an open UI.
- How shutdown, app upgrade, runner upgrade, and database migration are coordinated.
- How Autopilot avoids starting work when required operator approvals cannot be satisfied.

This future service should reuse the same runtime-owned Board and Autopilot contracts. It should not fork the Board model or introduce a Desktop-only scheduler.
