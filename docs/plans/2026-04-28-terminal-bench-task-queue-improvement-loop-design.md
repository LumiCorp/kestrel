---
id: plan-terminal-bench-task-queue-improvement-loop-2026-04-28
domain: benchmarking
status: approved
owner: kestrel-runtime
last_verified_at: 2026-06-11
depends_on:
  - ../../scripts/terminal-bench.ts
  - ../../benchmarks/terminal_bench/README.md
  - ./2026-04-27-terminal-bench-dual-adapter-design.md
---

# Terminal-Bench Task Queue Improvement Loop Design

See also: [Plans index](../PLANS.md).

## Purpose

Improve Kestrel against `terminal-bench-core==0.1.1` without waiting for a
full 80-task run after the first useful failure signal appears.

The current improvement loop runs the selected Terminal-Bench target as one
`tb run`. For `--full`, that means the loop can continue through many tasks
after unresolved task evidence already exists. The new loop keeps the full
benchmark target, but executes it as a deterministic queue of single-task
Terminal-Bench runs.

## Operator Surface

Existing commands stay valid:

```bash
pnpm run bench:terminal -- improve
pnpm run bench:terminal -- improve --adapter kestrel --task-id hello-world
pnpm run bench:terminal -- improve --full --adapter kestrel
```

For `improve --full`, the orchestrator expands the dataset to a task queue and
runs each task with `--task-id <task-id>`. The default `improve` command remains
canonical Kestrel `hello-world`.

Add a scoped cleanup command:

```bash
pnpm run bench:terminal -- cleanup
```

The cleanup command removes only Kestrel Terminal-Bench resources matching the
orchestrator's run naming convention. It must not run global Docker pruning.

## Queue Model

Create one queue file per improvement session:

```text
runs/terminal-bench-improve/<timestamp>/queue.json
```

Queue shape:

```json
{
  "dataset": "terminal-bench-core==0.1.1",
  "adapter": "kestrel",
  "created_at": "2026-04-28T00:00:00.000Z",
  "tasks": [
    {
      "task_id": "play-zork",
      "status": "pending",
      "attempts": 0,
      "last_run_id": null,
      "last_failure_kind": null
    }
  ]
}
```

Task statuses are `pending`, `running`, `passed`, `failed`, and `skipped`.

Task order should come from Terminal-Bench metadata when a stable local source
is available. If metadata discovery is not reliable, check in a static
`terminal-bench-core==0.1.1` task list so the full queue is deterministic.

## Iteration Flow

Each improvement iteration walks pending queue items until the first unresolved
task or run error.

For each task:

1. Pre-clean stale Docker resources for the exact task/run naming pattern.
2. Run one Terminal-Bench task through the selected adapter.
3. Read that task run's `results.json`.
4. If resolved, mark the queue item `passed` and continue.
5. If unresolved or failed, mark the queue item `failed` and stop the queue.
6. Write the failure packet from that single-task run.
7. Run targeted Docker cleanup for that task.
8. Invoke Codex with the evidence packet.
9. Run targeted tests, then rerun the same task.
10. Commit only after the same task rerun passes.
11. Mark the queue item `passed` after the verified commit and continue.

No full benchmark rerun occurs inside a repair step. The queue itself is the
full benchmark.

## Docker Discipline

Docker lifecycle management is part of the benchmark contract.

For each single-task run, the orchestrator knows:

- the `runId`
- the task ID and task slug
- the Terminal-Bench compose file path
- the compose project name, expected as:

```text
<task-slug>-1-of-1-<run-id>
```

Before and after each task, run scoped cleanup for that project:

```bash
docker compose -p <project> -f <task-docker-compose.yaml> down --volumes
```

Default cleanup should keep images for speed. Add an explicit
`--docker-remove-images` option if image removal is needed:

```bash
docker compose -p <project> -f <task-docker-compose.yaml> down --rmi all --volumes
```

Never call `docker system prune`, broad `docker buildx prune`, or unscoped image
cleanup from the orchestrator.

Record cleanup output in the iteration artifacts. If cleanup fails, inspect
whether matching containers or volumes remain. Classify the iteration as
`docker_cleanup_failed` only when stale resources could pollute the next task.

## Run Notes

Maintain a living human-readable journal:

```text
benchmarks/terminal_bench/term-bench-run-notes.md
```

The orchestrator should append concise entries for major events:

- queue started
- task passed
- task unresolved
- Docker cleanup succeeded or failed
- Codex repair started, failed, or completed
- verification passed or failed
- commit created
- queue completed

Entries must link to concrete evidence paths and avoid root-cause claims unless
the evidence directly supports them.

Example entry:

```md
## 2026-04-28 - Kestrel full queue attempt

Command:
`pnpm run bench:terminal -- improve --full --adapter kestrel`

Outcome:
Stopped after `play-zork` was unresolved.

What passed:
- Docker bootstrap succeeded.
- Kestrel CLI installed inside the task container.

What failed:
- `play-zork` unresolved.
- Evidence: `runs/<run-id>/results.json`

Decision:
Repair this task before continuing the queue.

Next:
- Build a failure packet.
- Investigate task logs.
- Verify with `--task-id play-zork`.
```

## Failure Classification

Classify failures from artifacts only:

- `tb_verifier_failed`: `results.json` exists and reports unresolved task
- `tb_run_failed`: `tb run` exits nonzero without valid result evidence
- `docker_cleanup_failed`: scoped cleanup fails and stale resources remain
- `codex_failed`: repair executor exits nonzero or errors
- `verification_failed`: targeted tests or same-task rerun fail
- `timeout`: the task exceeds the configured timeout

Do not infer root cause from keywords, task names, or scores.

## Artifacts

Each improvement session writes:

```text
runs/terminal-bench-improve/<timestamp>/
  queue.json
  summary.json
  iteration-01/
    benchmark-command.txt
    benchmark-summary.json
    docker-cleanup.txt
    failure-packet.md
    codex-final.md
    verification.txt
    commit.json
```

For passed tasks, the queue state plus Terminal-Bench run directory is enough.
For failed tasks, the iteration directory captures the repair evidence.

## Testing

Add focused tests for:

- `improve --full` builds a task queue instead of one full `tb run`
- queue state transitions from `pending` to `passed` and `failed`
- stop-on-first-unresolved behavior
- queue resume from an existing `queue.json`
- scoped Docker cleanup command construction
- no global Docker prune/system cleanup commands
- run-note appending for queue start, pass, unresolved, cleanup, verification,
  and commit events
- commit only after targeted tests and same-task rerun pass

Manual smoke:

```bash
pnpm run bench:terminal -- improve --full --adapter kestrel --max-iterations 1
pnpm run bench:terminal -- cleanup
```

Then inspect:

```bash
benchmarks/terminal_bench/term-bench-run-notes.md
runs/terminal-bench-improve/<timestamp>/queue.json
runs/terminal-bench-improve/<timestamp>/iteration-01/
```
