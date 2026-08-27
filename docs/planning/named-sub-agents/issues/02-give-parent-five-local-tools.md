# Give the parent all five local dialog tools

## Useful outcome

The parent can open, send to, read, list, and permanently close local named
collaborators. It receives plain instructions for when collaboration helps,
when to use no dialog tool, and when reading is better than sending another
message.

## What changes

Extend `DialogServicePort` and its shared result contracts for the local
lifecycle from issue 01. Add `dialog.read` and `dialog.list`. Update open, send,
and close to return the same local summary.

Read must return the collaborator's name, child Thread ID, open or closed
status, idle, working, waiting, or interrupted activity, latest actionable
error, saved text messages, `nextCursor`, `hasEarlier`, and `hasMore`. Without a
cursor it returns the newest bounded messages in time order. With a cursor it
returns only later messages. It never sends, wakes the child, starts work, or
creates a parent turn.

List must return the parent Thread's saved collaborators with ID, name, status,
activity, newest cursor, and last update time. It supports open, closed, or all
and stable pagination through optional `nextCursor` and `hasMore`. It never
starts collaborator work.

Use strict input schemas and reject unknown fields. Read limit accepts 1
through 100 and defaults to 20. List limit accepts 1 through 100 and defaults to
50. List status defaults to all. Cursors are nonempty, opaque, and scoped to the
parent Thread and query.

Copy the exact parent instruction block, five tool descriptions, field help,
and parent-facing errors from the Product Brief. Remove the bird-species
instruction. The managed parent must expose exactly `dialog.open`,
`dialog.send`, `dialog.read`, `dialog.list`, and `dialog.close`; legacy
`agent.spawn`, `delegate.*`, and duplicate `agent.*` tools remain hidden.

Append the collaboration block during root-turn assembly in `ThreadRuntime`
only when the effective tool list contains all five tools and the active turn
is not a collaborator child. Preserve existing application instructions. Do
not add it to `SHARED_DELIBERATOR_PROMPT`.

The model must choose tool use from the plain instructions. Do not add keyword
matching, scores, ranking, a hidden classifier, repeated polling, or a blocking
wait tool.

## Requirements and delivery context

The canonical requirements and exact production copy are in the [Local Named Collaborators Product Brief](../../named-sub-agents-product-brief.md).

The current contracts are in `tools/contracts.ts`. Existing modules are
`tools/runtime/dialogOpen.ts`, `dialogSend.ts`, and `dialogClose.ts`. Registry,
input-contract, and managed-profile ownership are in
`UnifiedToolRegistry`, `builtInToolInputContracts`, and
`src/profile/kestrelOnePolicy.ts`. Root prompt assembly belongs to
`src/orchestration/ThreadRuntime.ts`.

Keep the result local and text-only. Do not add `agentId`, provider selection,
A2A fields, remote task states, structured remote parts, or collaborator
artifact pagination.

## Done when

- The managed parent receives exactly five local dialog tools with the Product
  Brief's exact descriptions, field help, limits, strict schemas, and errors.
- Read returns recent, incremental, empty, and multi-page saved messages with
  the required cursor behavior and never starts work.
- List returns stable open, closed, and all pages and recovers an ID after
  earlier context is gone.
- Root parents with all five tools receive the exact plain-language block;
  child turns and incomplete profiles do not.
- Tool-choice evaluations cover parallel work, review, follow-up send, read,
  list, waiting, direct answers, user-blocked work, stop requests, and closed
  history without repeated polling.
- Contract tests reject bird-name wording, reopen, name reuse, unknown fields,
  mismatched cursors, legacy delegation tools, and all A2A inputs or fields.
- Managed profile, registry, package, local canary, and image smoke contracts
  require the exact five-tool set.
- Focused tool, prompt, profile, registry, query, and evaluation tests pass.
- `pnpm validate` passes.

## Depends on

- [Make local collaborator close terminal](01-make-local-close-terminal.md)
