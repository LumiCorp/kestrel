---
id: dev-shell-deep-review-2026-05-15
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-06-30
depends_on:
  - ../../AGENTS.md
  - ../../tools/devshell/run.ts
  - ../../src/devshell/DevShellSupervisor.ts
  - ../../src/devshell/LocalDevShellService.ts
  - ../../agents/reference-react/prompts/includes/dev-shell.md
---

# Dev Shell Deep Review

See also: [Plans index](../PLANS.md).

Date: 2026-05-15

## Summary

Kestrel's dev-shell implementation is stronger than a generic agent Bash tool on durable process identity, transcript replay, workspace-root enforcement, environment allowlisting, source-write guard behavior, and Terminal-Bench bridge compatibility. The main gap is agent ergonomics: common interactive loops still require many small tool turns unless the agent writes a durable controller, and much of the "do larger chunks of work" behavior is enforced through prompt guidance rather than compact, first-class tool contracts.

The highest-value next step is not a broad shell rewrite. It is a small contract-hardening slice that makes command-response work cheaper for the model while preserving the existing processId, transcript cursor, source-write guard, and deterministic replay invariants.

## Current State

The public tool surface is split into one-shot and managed-process tools:

- `dev.shell.run` runs one bounded command and returns final output. Its schema accepts `workspaceRoot`, `cwd`, `requiredTools`, `envNames`, `yieldTimeMs`, `timeoutMs`, `maxOutputBytes`, and `envMode`; it explicitly tells the model to use `dev.process.start` for live processes and not to start heredocs or full-screen editors. See `tools/devshell/run.ts`.
- `dev.process.start/read/write/stop` exposes a Kestrel process handle, not an OS PID. `start` returns a `processId` plus initial transcript output; `read` is cursor-based; `write` only accepts stdin; `stop` terminates and returns output from a cursor. See `tools/devshell/processStart.ts`, `tools/devshell/processRead.ts`, and `tools/devshell/processWrite.ts`.
- `LocalDevShellService` either delegates `/shell/run` directly or, when a console observer is present, emulates one-shot execution with `startProcess` plus repeated `readProcess` calls. See `src/devshell/LocalDevShellService.ts`.
- `DevShellSupervisor` owns spawning, transcript files, stdout/stderr merging, idle expiry, source-write guard enforcement, cwd-within-workspace checks, environment shaping, and process lifecycle persistence. See `src/devshell/DevShellSupervisor.ts`.
- `kestrel_devshell.py` provides a controller-friendly Python client with `run`, `start`, `write`, `read`, `stop`, `wait_for`, and `sendline_and_wait`. This is the strongest current affordance for doing bigger chunks of work.
- Reference-react prompt/policy guidance already pushes durable controllers, internal deadlines, semantic checks, and no-progress discipline. It also blocks repeated settled polling and active no-progress reads. See `agents/reference-react/prompts/includes/dev-shell.md` and `agents/reference-react/src/decision/compileIntent.ts`.

## Comparative Matrix

| Dimension | Kestrel today | Codex unified exec | Broader norms |
| --- | --- | --- | --- |
| One-shot shell | `dev.shell.run` with final output and timeout | `exec_command` with yield timing, token output limits, sandbox fields, optional TTY/login shell | OpenAI Shell docs emphasize non-interactive commands, timeout outcomes, partial output, output caps, and audit logging |
| Live process | Explicit `dev.process.*` with durable opaque `processId` | `exec_command` can return a process id; `write_stdin` sends input and yields output | Claude Code has Bash plus permission prompts; OpenHands uses sandbox providers with shell/browser/code execution |
| Output model | Cursor-based transcript files, merged text result, observer chunks | Chunked output with max token truncation | Output caps and preserved non-zero output are standard expectations |
| Permissions | Profile-gated dev shell, env allowlist/inherit, source-write guard | Exec policy, sandbox permissions, additional permissions, prefix rules | Claude combines tool permissions and OS sandboxing; OpenHands recommends Docker sandbox for isolation |
| Agent ergonomics | Good Python helper inside controllers, but top-level stdin write is write-only | `write_stdin` returns process output after a yield window | Modern tools reduce repeated "write then poll" turns where possible |
| Replay/state | Strong: persisted process rows plus transcript cursor | Strong process manager semantics in Codex runtime | Sandbox/runtime state is usually explicit and inspectable |
| Interactive TTY | No TTY/PTY support; stdio is pipes through `shell -lc` | Codex supports a `tty` parameter | OpenAI public Shell docs discourage relying on interactive commands; TTY is useful but should stay deliberate |

## Findings

### 1. High: `dev.process.write` forces micro-turns for command-response loops

Evidence: `dev.process.write` is intentionally write-only at the tool contract level and returns only `ACCEPTED`, `bytesWritten`, and optional `message`. The supervisor implementation writes to stdin, touches the process, and returns without waiting for output. The Python helper compensates with `sendline_and_wait`, but that helper is only available inside a controller script.

Impact: When the model does not create a controller, it must spend separate turns on `write`, then `read`, sometimes repeatedly. That matches the observed Terminal-Bench budget burn pattern: small no-progress or low-progress process probes instead of larger work units.

Opportunity: Add a first-class command-response affordance such as `dev.process.sendline_and_read` or `dev.process.write_and_read` that:

- accepts `processId`, `data`, optional `waitMs`, `maxBytes`, and optional expected literal/regex strings,
- writes stdin and returns the next transcript chunk in the same tool result,
- advances by the same cursor semantics already used by `read`,
- preserves separate `read` for low-level replay and manual polling.

This is deterministic contract hardening, not a heuristic policy change.

### 2. High: controller guidance is mostly prompt-level, not tool-level

Evidence: the dev-shell prompt includes a long controller contract: create durable scripts, use internal deadlines, print result summaries, avoid one-case probing, validate semantic output, repair from exact errors, and use `kestrel_devshell.start` for managed entrypoints. The runtime already has the Python client to support this, but the public tool surface does not expose a compact "controller run" contract.

Impact: Capable agents can follow the instructions, but weaker or budget-constrained runs still fall back to inline shell, repeated probes, or controller repair loops. The tool shape does not make the best behavior the easiest behavior.

Opportunity: Add a small helper pattern before adding new runtime policy:

- a controller template or generated checklist surfaced in the prompt/context,
- a `dev.shell.controller` wrapper only if it adds real contract value over `dev.shell.run`,
- stronger result-schema expectations for controller summaries if the existing free-text summaries remain inconsistent.

Do not add scoring, ranking, or lexical fallback heuristics for controller quality without explicit approval.

### 3. Medium: observed one-shot execution drops source-write guard metadata on return

Evidence: `DevShellSupervisor.runCommand()` returns `sourceWriteGuard` and `unauthorizedSourceWrites` from the collected result. `LocalDevShellService.runCommandWithObservedOutput()` reconstructs the final `DevShellRunResult` but only carries status, output, command/cwd/timestamps, exit code, and failure reason.

Impact: when a tool console observer is active, the user/model can see live chunks, but final source-write guard evidence can be absent from the top-level one-shot result. That weakens auditability exactly on the richer UI path.

Opportunity: preserve `sourceWriteGuard` and `unauthorizedSourceWrites` in `runCommandWithObservedOutput()` in the same shape as `DevShellSupervisor.runCommand()`.

### 4. Medium: persisted process records do not include source-write guard result fields

Evidence: `DevShellProcessRecord` includes optional `sourceWriteGuard`, but `dev_shell_processes` migrations and `PostgresDevShellStore` persist command/status/readiness/transcript/cursor/timestamps/exit/failure fields only. `sourceWriteGuard` is therefore an in-memory/final-result concept, not a durable record field.

Impact: after supervisor restart or later process lookup, source-write guard details are not replayable from the process store. This is at odds with Kestrel's stronger durability story and makes post-hoc audit weaker than live execution.

Opportunity: add a nullable `source_write_guard_json` column and round-trip it through `PostgresDevShellStore`, with compatibility for old rows.

### 5. Medium: output is merged by byte cursor, but UTF-8 chunk boundaries can split characters

Evidence: transcript reading allocates `maxBytes`, reads bytes from an arbitrary cursor, and converts the buffer slice with `toString("utf8")`. `LocalDevShellService.appendBoundedDevShellOutput()` has tests to avoid splitting multibyte characters for aggregate output, but `readTranscriptChunk()` itself can still slice at arbitrary byte boundaries.

Impact: rare, but user-visible output can contain replacement characters or malformed snippets when cursors/maxBytes land inside multibyte sequences. This matters for deterministic replay and exact semantic checks.

Opportunity: make transcript chunk reads UTF-8 boundary aware while preserving byte cursors. The cursor should remain byte-based; only returned text should avoid cutting inside a code point.

### 6. Medium: no TTY support is a deliberate safety simplification but limits parity with Codex

Evidence: Kestrel spawns commands with `stdio: "pipe"` and no PTY/TTY option. Codex unified exec exposes a `tty` option. OpenAI's public shell docs still warn not to rely on interactive commands, so TTY is not required for the main contract.

Impact: some CLIs change behavior when not attached to a terminal. Agents may compensate with flags or wrappers, which can increase command complexity.

Opportunity: defer TTY unless a concrete task proves it is needed. If added, it should be a separate, explicitly approved capability with tests for transcript capture, stop behavior, and source-write guard enforcement.

### 7. Low: command normalization repairs known model mistakes, but it is policy-adjacent

Evidence: `normalizeDevShellExecCommand()` unwraps fences/whole-command quotes and rewrites escaped-newline Python commands/heredocs. This is useful repair logic, but it is also command-shape inference.

Impact: it reduces model friction, but every expansion of this behavior risks becoming ad-hoc shell policy. This repo's AGENTS.md requires surfacing and approving heuristic policy behavior before extending it.

Opportunity: keep the current normalizers, but require any new shell-shape rewrite to be proposed explicitly with examples, failure modes, and tests.

## Improvement Options

### Option A: Contract hardening first

Implement the smallest reliability fixes:

- preserve source-write guard fields in observed one-shot results,
- persist source-write guard JSON in `dev_shell_processes`,
- add UTF-8-safe transcript chunking.

This is low-risk and reinforces Kestrel's existing durability/audit story, but it does not directly solve the "larger chunks of work" complaint.

### Option B: Agent-efficiency API slice

Add one command-response process tool:

- `dev.process.write_and_read` or `dev.process.sendline_and_read`,
- deterministic write plus bounded wait plus cursor-based output in one result,
- optional exact expected output matching only if framed as a return aid, not a policy heuristic,
- Python helper remains the controller-level equivalent.

This directly attacks micro-turn budget burn without weakening safety boundaries.

### Option C: Deeper shell capability parity

Explore TTY, richer sandbox approval fields, and Codex-like permission prompts/prefix rules.

This is the largest change and should not be first. Kestrel already has a distinct source-write guard and deterministic replay model; copying Codex's shell shape would risk blurring the stronger Kestrel contract.

## Recommended Next Slice

Do Option B first, with one small part of Option A if convenient:

1. Add `dev.process.write_and_read` as a deterministic process tool.
2. Implement it in `DevShellServicePort`, `LocalDevShellService`, `DevShellSupervisor`, `TerminalBenchDevShellService`, and the Python client.
3. Keep `write` unchanged for raw stdin and keep `read` unchanged for replay/manual polling.
4. Return the same fields as `dev.process.read`, plus `bytesWritten`.
5. Reject writes to non-live processes exactly as `writeProcess` does.
6. Preserve transcript cursor semantics: caller may pass a cursor; if omitted, use the live process's latest known cursor after the write boundary.
7. Add prompt guidance: prefer `write_and_read` for command-response interactions; prefer durable controllers for multi-step loops.

Validation:

- targeted unit tests for write-then-output in `tests/unit/dev-shell-supervisor.test.ts`,
- service bridge parity tests for Terminal-Bench and local service,
- reference-react policy tests to ensure this tool is not blocked by existing process polling rules,
- then the standard gates: `pnpm run governance:check`, `pnpm run test`, `pnpm run prompt-suite`, and `pnpm run evals:release-check` for runtime/core work.

## Sources

- Local Kestrel files: `tools/devshell/run.ts`, `tools/devshell/processStart.ts`, `tools/devshell/processRead.ts`, `tools/devshell/processWrite.ts`, `tools/devshell/shared.ts`, `src/devshell/LocalDevShellService.ts`, `src/devshell/DevShellSupervisor.ts`, `src/devshell/contracts.ts`, `src/devshell/PostgresDevShellStore.ts`, `src/devshell/TerminalBenchDevShellService.ts`, `src/devshell/kestrel_devshell.py`, `agents/reference-react/prompts/includes/dev-shell.md`, `agents/reference-react/src/decision/compileIntent.ts`, `tests/unit/dev-shell-supervisor.test.ts`, `tests/unit/local-dev-shell-service.test.ts`.
- OpenAI Shell guide: https://developers.openai.com/api/docs/guides/tools-shell
- OpenAI Codex unified exec: https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs
- OpenAI Codex stdin handler: https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/unified_exec/write_stdin.rs
- OpenAI Codex exec policy: https://github.com/openai/codex/blob/main/codex-rs/core/src/exec_policy.rs
- Claude Code permissions: https://code.claude.com/docs/en/permissions
- Claude Code permission modes: https://code.claude.com/docs/en/permission-modes
- OpenHands sandbox overview: https://docs.openhands.dev/openhands/usage/sandboxes/overview
- OpenHands paper: https://arxiv.org/abs/2407.16741
