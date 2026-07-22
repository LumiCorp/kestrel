# Reference Agent Slice (Single Loop -> Exec)

This folder is the central slice for the reference agent.

## Folder hierarchy

- `agents/reference-react/README.md`
  - primary docs and architecture notes
- `agents/reference-react/example.ts`
  - runnable local example
- `agents/reference-react/src/`
  - modular implementation (register + steps + normalizers)

## Loop

1. `agent.loop`
2. `agent.exec.dispatch`
3. `agent.exec.wait_effect` / `agent.exec.wait_approval` / `agent.exec.wait_user` when needed
4. `agent.exec.collect`
5. `agent.exec.finalize`

`agent.loop` is responsible for:
- choosing exactly one structured action: `tool`, `tool_batch`, `ask_user`, `finalize`, or `cannot_satisfy`
- using the visible tool specs, latest result, wait replies, and validation feedback to continue the same loop
- finalizing direct answers without a separate chat path

`agent.exec.dispatch` is responsible for:
- dispatching tool/effect actions
- executing all `tool_batch` items in one cycle
- collecting effect results
- routing validation, policy, approval-denial, and tool-failure feedback back to `agent.loop`
- calling `FinalizeAnswer` before terminal completion

## Prompt behavior notes

Prompt policy keeps one model loop while biasing model decisions toward convergence:
- `agent.loop` can finalize immediately for casual conversational turns.
- `agent.loop` should finalize capability questions and simple arithmetic without tool churn.
- `agent.loop` should avoid unnecessary/repeated tool calls when evidence already exists.
- `agent.loop` receives normalized runtime feedback after tool success, denial, schema error, policy error, or tool failure.

## Manual smoke checklist (env-gated)

1. Start TUI: `pnpm run tui`
2. Create session: `/new smoke`
3. Send greeting: `hiya`
4. Expect:
   - run completes without long tool churn
   - assistant message is produced via `FinalizeAnswer`
5. Send factual question: `what's the weather in boston?`
6. Expect:
   - targeted tool usage only when needed
   - the loop finalizes once sufficient evidence is present

## Tool contract used by this reference agent

- `internet.search`
- `free.weather.current`
- `free.time.current`
- `free.geocode.lookup`
- `free.exchange.rate`
- `effect_result_lookup`
- `FinalizeAnswer`
