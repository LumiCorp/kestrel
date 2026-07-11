# Terminal-Bench Kestrel Adapter

Terminal-Bench uses one Kestrel adapter:

- `benchmarks.terminal_bench.agents:KestrelTerminalBenchAgent`

The adapter installs the current repo into the task container from a local
tarball, builds a canonical `job_input_v1`, and runs it through the public
`kestrel job run` command. Terminal-Bench bridge code supplies the container
dev-shell endpoint and protected-path enforcement for that single path.

## Prerequisites

- Docker running for Terminal-Bench.
- `tb` installed.
- `OPENROUTER_API_KEY` exported. Kestrel benchmark lanes use OpenRouter only.

Live Terminal-Bench runs need normal Docker host access. Inside Codex or another
filesystem sandbox, Docker Buildx may fail before the benchmark starts when it
tries to write host metadata under `~/.docker/buildx`. The orchestrator preflight
checks the Buildx activity directory when it already exists; if that warning or a
Buildx `operation not permitted` error appears, rerun the same live probe with
host approval/unsandboxed execution. Do not classify the failure as a Kestrel
runtime defect until a Kestrel adapter artifact exists.

Bootstrap the local benchmark tooling:

```bash
pnpm run bench:terminal -- bootstrap
```

Optional configuration:

```bash
export OPENROUTER_MODEL=deepseek/deepseek-v3.2
export KESTREL_TBENCH_REPO_ROOT="$PWD"
```

Deprecated benchmark aliases fail fast when present:
`KESTREL_TBENCH_MODEL_PROVIDER`, `KCHAT_MODEL_PROVIDER`,
`KESTREL_TBENCH_MODEL`, `KCHAT_MODEL`, and `KESTREL_SWE_MODEL_NAME`.

## Preflight

Use the repo orchestrator for normal runs:

```bash
pnpm run bench:terminal
```

That defaults to the canonical Kestrel adapter against the `hello-world` task.
Equivalent explicit command:

```bash
pnpm run bench:terminal -- run --task-id hello-world
```

For a different single task:

```bash
pnpm run bench:terminal -- run --task-id <task-id>
```

The `pnpm run tb <task-id>` wrapper loads the repo `.env` and routes to the same
canonical command.

Raw Terminal-Bench equivalent:

```bash
tb run \
  --dataset terminal-bench-core==0.1.1 \
  --agent-import-path benchmarks.terminal_bench.agents:KestrelTerminalBenchAgent \
  --task-id hello-world
```

New run artifacts use `runs/kestrel-terminal-bench-<timestamp>/`. Each task
result writes a normalized `kestrel-terminal-bench-<task>.json` artifact into
the Terminal-Bench logging directory when available. Result payloads include
OpenRouter provenance, Kestrel session/thread/run ids when available, job/event
log paths, bridge log paths, and the canonical job-input SHA-256 hash.

## Improvement Loop

Run the benchmark-backed repair loop:

```bash
pnpm run bench:terminal -- improve
```

Defaults:

- adapter: `kestrel`
- task: `hello-world`
- max iterations: `10`
- repair executor: `codex`

Useful variants:

```bash
pnpm run bench:terminal -- improve --adapter kestrel --task-id hello-world
pnpm run bench:terminal -- improve --full --adapter kestrel --max-iterations 10
pnpm run bench:terminal -- improve --dry-run
```

The loop requires a clean git worktree before it starts. Each iteration runs the
selected Terminal-Bench target, writes a failure packet under
`runs/terminal-bench-improve/`, invokes `codex exec --full-auto --cd <repo> -`,
runs targeted verification, reruns the same benchmark target, and commits only
after verification passes.

Clean up queue-recorded Terminal-Bench Docker resources:

```bash
pnpm run bench:terminal -- cleanup
```

Cleanup only targets Kestrel Terminal-Bench compose projects recorded by the
queue. It does not run global Docker prune commands and does not remove images
by default.

## Local Unit Checks

```bash
python3 -m unittest \
  benchmarks.terminal_bench.test_cli_task_runner \
  benchmarks.terminal_bench.test_agents \
  benchmarks.terminal_bench.test_results \
  benchmarks.terminal_bench.test_container_devshell_bridge \
  benchmarks.terminal_bench.test_tmux_devshell_bridge

node --import tsx --test tests/unit/terminal-bench-orchestrator.test.ts
```
