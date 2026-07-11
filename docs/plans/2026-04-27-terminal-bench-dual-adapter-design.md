---
id: terminal-bench-dual-adapter-design-2026-04-27
domain: evaluation
status: obsolete
owner: kestrel-runtime
last_verified_at: 2026-06-11
depends_on:
  - ../../README.md
  - ../../docs/cli/kchat-protocol.md
---

# Terminal-Bench Dual Adapter Design

See also: [Plans index](../PLANS.md).

> Obsolete as of 2026-07-03. Terminal-Bench now follows the SWE Verified
> benchmark shape: one canonical `job_input_v1` builder executed through
> `kestrel job run` by `benchmarks.terminal_bench.agents:KestrelTerminalBenchAgent`.
> The direct runtime lane described below is historical context only.

## Summary

Kestrel needs two Terminal-Bench paths so benchmark results separate runtime
capability from installed CLI usability.

- `KestrelRuntimeAgent` measures the Kestrel runtime and reference agent through
  the runner `job.run` protocol.
- `KestrelCliInstalledAgent` measures the installable CLI path by running the
  public `kestrel job run` command inside the Terminal-Bench task container.

Both adapters target `terminal-bench-core==0.1.1`. A `hello-world` run is the
preflight gate before full dataset execution.

## Runtime Adapter

The runtime adapter implements Terminal-Bench `BaseAgent`. It owns the active
`TmuxSession`, starts a local HTTP bridge, and points Kestrel at that bridge with
`KESTREL_TBENCH_DEV_SHELL_BRIDGE_URL`.

The bridge preserves Kestrel's existing `dev.shell.*` tool contract:

- `dev.shell.start` returns a synthetic durable shell session for the active
  Terminal-Bench task container.
- `dev.shell.exec` submits commands to the benchmark tmux session and appends a
  deterministic completion marker.
- `dev.shell.read` and `dev.shell.status` report terminal output and command
  completion.
- `dev.shell.stop` interrupts the active tmux command.

No new routing heuristics or tool-selection policy are introduced.

## CLI Adapter

The CLI adapter implements Terminal-Bench `AbstractInstalledAgent`. Before the
Terminal-Bench install hook runs, it copies a local tarball of the current repo
into the task container. The install script extracts the repo, installs Node and
pnpm dependencies, and leaves the public CLI available at
`/opt/kestrel/bin/kestrel.js`.

The run command invokes a small container-side task runner. That runner starts a
container-local bridge for `dev.shell.*`, writes a `job_input_v1` file, and runs:

```bash
node /opt/kestrel/bin/kestrel.js job run --json-in <file> --json-out <file> --store sqlite
```

This keeps the CLI lane on the public non-interactive command surface while
still giving the reference agent a shell contract that works in the benchmark
container.

## Results

Both adapters write one JSON artifact per task with:

- adapter, dataset, task id, status, duration, and failure kind
- Kestrel session/thread/run ids when available
- short notes with the terminal error or command output tail

Failure kinds are evidence-backed and limited to:

- `none`
- `tb_verifier_failed`
- `kestrel_run_failed`
- `bridge_failed`
- `cli_install_failed`
- `cli_command_failed`
- `timeout`
