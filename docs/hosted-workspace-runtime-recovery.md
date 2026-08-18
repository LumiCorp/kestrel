---
id: hosted-workspace-runtime-recovery
domain: reliability
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-17
depends_on:
  - ../RELIABILITY.md
  - ../src/security/ExecutionBoundaryPolicy.ts
  - ../tools/filesystem/readText.ts
---

# Hosted Workspace Runtime Recovery

Use this manual runbook when a hosted Workspace runner is degraded or when a
runtime image containing canonical tool-descriptor changes is ready to deploy.
Deployment and Workspace restart are manual operations. This procedure does
not authorize automated Fly or RunPod deployment.

## Safety boundary

- Drain active runs before deploying the split `fs.read_text` and
  `fs.read_text_page` descriptors. Historical run evidence remains readable,
  but an active model turn must not observe two different canonical tool
  surfaces.
- Never delete run events, the PGlite store, or its WAL as part of recovery.
- Do not run automatic WAL checkpoint, pruning, event batching, or database
  maintenance.
- If a clean close and reopen does not reclaim WAL, stop and open a separate
  PGlite lifecycle investigation.

## Manual recovery procedure

1. Confirm there is no active run and no policy-bound review awaiting
   resumption. If either exists, drain it before continuing.
2. Record the incident evidence before mutation:
   - Workspace and environment IDs.
   - Machine ID and persistent volume ID.
   - Runner RSS.
   - PGlite store size and WAL size.
   - Run-event counts for the affected run and thread.
   - Current Workspace and `/health` state.
3. Deploy the reviewed runtime image manually. Perform a graceful
   Workspace-runtime restart so PGlite receives its normal close lifecycle.
4. Confirm that the same persistent volume is mounted and that historical
   threads remain readable.
5. Run both canaries:
   - A typed-read canary that reconstructs a file larger than 16 KB by calling
     `fs.read_text` once and following each returned
     `nextPage.tool = fs.read_text_page` action exactly.
   - A stream-heavy runtime canary that emits reasoning and tool-console
     chunks while `/health` remains responsive.
6. Verify the post-recovery evidence:
   - Workspace health does not flap between ready and degraded.
   - The typed-read canary used no shell fallback.
   - Durable execution-boundary event cardinality is independent of stream
     chunk count.
   - No `execution_boundary.decision` event has boundary `model_stream` or
     `tool_stream`.
   - The machine still reports the same persistent volume and historical
     threads are readable.

## Execution-boundary evidence model

Execution-boundary policy change `execution-boundary-integrity-v2` supersedes
the v1 revision. `model_stream` and `tool_stream` are `live_enforced`: every
presented chunk is deterministically redacted with cross-chunk state, while
per-chunk decisions are intentionally not retained. Model requests, model
actions, tool requests, tool results, assistant output, and the remaining
boundaries continue to use `durable_decision` evidence before downstream use.

## Escalation

Treat unreclaimed WAL after the clean close/reopen, a changed volume ID,
missing historical threads, a health flap, shell fallback during the typed-read
canary, or any persisted live-stream boundary decision as a failed recovery.
Preserve the recorded evidence and investigate the owning lifecycle separately.
