---
id: cli-contract-matrix
domain: cli
status: active
owner: kestrel-cli
last_verified_at: 2026-07-31
depends_on:
  - ./kchat.md
  - ./kchat-protocol.md
  - ../generated/cli-contract-matrix.json
---

# CLI Contract Matrix

This page is generated from `cli/contractMatrix.ts` and must stay aligned with parser behavior and protocol contracts.

## Executables

| Binary | Entrypoint | Aliases |
| --- | --- | --- |
| `kestrel` | `bin/kestrel.js` | `ks` |
| `kcron` | `bin/kcron.js` | - |

## Command Mode

| Command | Usage | Flags |
| --- | --- | --- |
| `model` | `kestrel model <show|search|set-provider|set> ...` | - |
| `status` | `kestrel status` | - |
| `workspace` | `kestrel workspace <status|list>` | - |
| `web` | `kestrel web ...` | - |
| `job` | `kestrel job run --json-in <file> --json-out <file> [--profile <id>]` | `--json-in`, `--json-out`, `--profile` |
| `operator` | `kestrel operator <resume-wait|approve|retry-delegation|doctor-export> ...` | `--thread-id`, `--request-id`, `--allow-tool-class`, `--allow-capability`, `--delegation-id`, `--run-id`, `--out`, `--reason` |
| `runtime` | `kestrel runtime <replay|doctor> <query> [--json]; kestrel runtime bundle <query> --out <file>` | `--run-id`, `--session-id`, `--thread-id`, `--delegation-id`, `--out`, `--limit`, `--json` |
| `setup` | `kestrel setup [--profile <id>] [--approval-pack dev|ci_bot|production] [--full]` | `--profile`, `--approval-pack`, `--full` |
| `uninstall` | `kestrel uninstall; kestrel uninstall plan --scope current|software|complete; kestrel uninstall apply --plan <file> --confirm <plan-id>` | `--scope`, `--disconnect-kestrel-one`, `--export-worktrees`, `--discard-worktrees`, `--json`, `--out`, `--plan`, `--confirm`, `--delete-data`, `--discard-confirm` |

## Slash Commands

- `/help`
- `/profiles`
- `/model`
- `/theme`
- `/mode`
- `/start`
- `/new`
- `/sessions`
- `/workspace`
- `/tasks`
- `/switch`
- `/resume`
- `/status`
- `/mcp`
- `/code`
- `/compact`
- `/snapshot`
- `/restore`
- `/approve`
- `/deny`
- `/reject`
- `/reply`
- `/retry`
- `/steer`
- `/queue`
- `/stop`
- `/focus`
- `/checkpoint`
- `/assembly`
- `/child`
- `/fanin`
- `/operator`
- `/quit`

## Runner Protocol Commands

- `profile.list`
- `profile.get`
- `job.run`
- `run.start`
- `run.cancel`
- `session.describe`
- `session.state`
- `operator.inbox`
- `operator.thread`
- `operator.runs`
- `operator.run`
- `operator.run.reasoning`
- `operator.control`
- `task.graph.get`
- `task.graph.update`
- `workspace.checkpoint.capture`
- `workspace.checkpoint.list`
- `workspace.checkpoint.inspect`
- `workspace.checkpoint.diff`
- `workspace.checkpoint.restore`
- `workspace.checkpoint.cleanup`
- `workspace.promotion.list`
- `workspace.promotion.preview`
- `workspace.promotion.apply`
- `workspace.promotion.undo_latest`
- `workspace.managed.inspect`
- `workspace.managed.cleanup`
- `workspace.managed.restore`
- `workspace.managed.setup.retry`
- `user.terminal.start`
- `user.terminal.list`
- `user.terminal.read`
- `user.terminal.write`
- `user.terminal.resize`
- `user.terminal.stop`
- `workspace.changes.inspect`
- `workspace.changes.mutate`
- `workspace.feedback.add`
- `workspace.feedback.list`
- `workspace.feedback.remove`
- `workspace.feedback.submit`
- `workspace.review.run`
- `workspace.review.list`
- `workspace.review.update`
- `workspace.review.submit`
- `workspace.validation.inspect`
- `workspace.validation.run`
- `workspace.validation.cancel`
- `workspace.validation.submit`
- `mission_control.project.get`
- `mission_control.action.execute`
- `project.snapshot.get`
- `project.action`
- `project.review.get`
- `project.review.action`
- `runner.ping`
- `mcp.status`
- `mcp.refresh`

## Runner Protocol Events

- `profile.listed`
- `profile.loaded`
- `job.started`
- `job.progress`
- `job.completed`
- `job.failed`
- `run.started`
- `run.cancelled`
- `run.tool.started`
- `run.tool.completed`
- `run.tool.failed`
- `run.log`
- `run.console`
- `run.progress`
- `run.model.reasoning.started`
- `run.model.reasoning.delta`
- `run.model.reasoning.completed`
- `run.model.reasoning.failed`
- `run.model.reasoning.unavailable`
- `run.agent_progress`
- `run.completed`
- `run.failed`
- `runner.error`
- `runner.pong`
- `session.described`
- `session.state`
- `operator.inbox`
- `operator.thread`
- `operator.runs`
- `operator.run`
- `operator.run.reasoning`
- `operator.controlled`
- `task.updated`
- `task.graph`
- `workspace.checkpoint`
- `user.terminal`
- `workspace.changes`
- `workspace.feedback`
- `workspace.review`
- `workspace.validation`
- `mission_control.project`
- `project.snapshot`
- `project.review`
- `mcp.status`
- `mcp.refreshed`

## Streaming Commands

- `run.start`
- `job.run`

## Contract Notes

- Legacy ambiguous command/flag aliases are intentionally excluded from the frozen matrix.
- Streaming protocol commands must use /commands/stream on runner-service.
- job.run is the protocol-native non-interactive surface for strict JSON IO.
- Local Core owns persistence selection for every local command and run.

## Source Of Truth

- [cli/contractMatrix.ts](../../cli/contractMatrix.ts)
- [docs/generated/cli-contract-matrix.json](../generated/cli-contract-matrix.json)
