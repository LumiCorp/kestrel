---
id: preview-process-retention-ownership
domain: architecture
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-13
depends_on:
  - ../../CONTEXT.md
  - ../../src/devshell/contracts.ts
  - ../../tools/kestrelOne/workspacePreviews.ts
---

# Preview and Process Retention Ownership

## Decision

The developer-shell supervisor owns process lifetime. It persists explicit retention leases and stops a retained process when its final lease is released or expires. The first retention lease replaces the original command wall timer; process reads do not extend retention. Manual stop, normal exit, failure, and unrecoverable supervisor restart clear all process leases.

The Kestrel One preview service separately owns public URL routing. A valid Preview Lease may outlive a temporary application outage so the same URL can become reachable after the application restarts. Application Liveness is a current port observation and does not mutate either lease by itself.

Preview publication first acquires `workspace-preview-publish:<uuid>` on the exact developer-shell `sessionId` supplied by the runtime tool. This Preview Publication Lease expires after a fixed 10 minutes and replaces the process's original command wall timer before any liveness or public URL request begins. A runner crash can therefore leave publication retention alive for no more than 10 minutes.

After the preview service returns a valid preview ID and authoritative expiry, the supervisor atomically replaces that exact provisional lease with `workspace-preview:<previewId>`. The operation preserves unrelated retention authorities and persists the replacement once. Publication returns its URL only after promotion succeeds. Renewal updates the final lease; close releases it. No preview foreign key or preview-specific column is added to the developer-shell store.

Publication failure, cancellation, invalid preview data, or promotion failure follows one cleanup path. A newly created public URL is closed best-effort, then whichever publication retention is authoritative is released synchronously: the provisional lease before promotion, or the final preview lease after promotion. Cleanup failures are attached as evidence without replacing the primary failure. Releasing the final authority stops the process.

Finalization confirms an existing lease for every requested `keepRunningSessionId`. When none exists, it creates a standalone lease with a fixed 30-minute expiry. Finalization fails if the process is no longer active or retention cannot be established.

## Consequences

- URL-routing state, process retention, and application liveness are independently truthful surfaces.
- Preview publication cannot begin liveness or public URL work until provisional process retention is established, and cannot succeed until that retention is atomically promoted.
- A failed publication closes any newly created URL best-effort and releases its provisional retention authority.
- Multiple authorities may retain one process, and the process remains live until the final lease ends.
- Supervisor recovery continues to mark live records `LOST`; leases cannot imply recovery of an unavailable operating-system process.
- Runtime behavior does not depend on keyword, URL, path, score, or timing heuristics.
