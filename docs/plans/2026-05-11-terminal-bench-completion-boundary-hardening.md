---
id: terminal-bench-completion-boundary-hardening-2026-05-11
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-06-30
depends_on:
  - ../../benchmarks/terminal_bench/cli_task_runner.py
  - ../../benchmarks/terminal_bench/container_devshell_bridge.py
  - ../../agents/reference-react/src/artifactSubmissionFinalization.ts
  - ../../agents/reference-react/src/evidenceLedger.ts
---

# Terminal-Bench Completion Boundary Hardening

See also: [Plans index](../PLANS.md).

## Observed Tasks

- `build-initramfs-qemu`: run `runs/kestrel-cli-20260511175931/results.json` produced useful blocker evidence, then tried `goal_satisfied` and was rejected by failed artifact verification. Next observed failure mode: blocked/environment finalization was not being closed as a blocked outcome.
- `cartpole-rl-training`: run `runs/kestrel-cli-20260511180449/results.json` passed Terminal-Bench verification, while the harness still recorded `agent_timeout`. Next observed failure mode: Kestrel and the Terminal-Bench wrapper did not share the same external deadline.
- `chess-best-move`: run `runs/kestrel-cli-20260511181524/results.json` timed out with `/app/move.txt` missing after the completion packet identified a concrete repair target. Next observed failure mode: the packet was present as text but not prominent enough as raw observer/deliberator material.

## Probe Results After This Slice

- `build-initramfs-qemu`: run `runs/kestrel-cli-20260511191305/results.json` remained unresolved with `failure_mode: agent_timeout`; the test failed because post-agent output did not contain the expected custom kernel login text. This is not a generic bridge crash, but it is still the next observed long-task/blocker closeout failure mode.
- `cartpole-rl-training`: run `runs/kestrel-cli-20260511192434/results.json` resolved successfully with all parser checks passing. This confirms the artifact-success path can now complete without being reclassified as an agent timeout in this representative case.
- `chess-best-move`: run `runs/kestrel-cli-20260511193035/results.json` remained unresolved with `failure_mode: agent_timeout`; `/app/move.txt` did not pass `test_move_correct`. The trace showed marked completion packet output reaching the runtime path, but the task still timed out before a correct final artifact.

## Hotspot Matrix

- Finalization/readiness: artifact success finalization belongs to submission readiness; blocker finalization belongs to structured observer blocker judgment. `goal_satisfied` remains strict and cannot pass failed or missing artifact verification.
- Observer transition: observer is now a closeout boundary for passed required-artifact verification and concrete blocked judgments. Inconclusive or repairable observations still route to deliberation.
- Terminal-Bench adapter/deadline: the adapter passes the external Terminal-Bench timeout into Kestrel as `KESTREL_TBENCH_AGENT_TIMEOUT_SEC` and `KESTREL_EXTERNAL_DEADLINE_MS`; the CLI runner uses that deadline with a reserve.
- Completion packet context: only explicitly marked `COMPLETION_ATTEMPT_PACKET_*` raw output is extracted. The runtime does not infer correctness from arbitrary stdout.
- Compile hard-contract policy: compile still enforces valid tools, process safety, phase/tool compatibility, and artifact finalization readiness. It does not judge controller quality or parse benchmark-specific output.

## Implementation Slices

- Blocked completion finalization: synthesize `policy_blocked` finalization from structured observer blocker judgments.
- Deadline alignment: surface external harness deadline and use it to choose the smaller runtime timeout.
- Completion packet extraction: render marked packet fields near the top of observer and deliberator inputs.
- Observer exit simplification: direct finalized artifact and blocker outcomes to execution without another deliberator model call.
- Regression coverage: prove packet rendering, blocked finalization, artifact auto-finalization, and deadline propagation with focused tests.
