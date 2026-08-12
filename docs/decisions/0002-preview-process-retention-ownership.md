---
id: preview-process-retention-ownership
domain: architecture
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-12
depends_on:
  - ../../CONTEXT.md
  - ../../src/devshell/contracts.ts
  - ../../tools/kestrelOne/workspacePreviews.ts
---

# Preview and Process Retention Ownership

## Decision

The developer-shell supervisor owns process lifetime. It persists explicit retention leases and stops a retained process when its final lease is released or expires. The first retention lease replaces the original command wall timer; process reads do not extend retention. Manual stop, normal exit, failure, and unrecoverable supervisor restart clear all process leases.

The Kestrel One preview service separately owns public URL routing. A valid Preview Lease may outlive a temporary application outage so the same URL can become reachable after the application restarts. Application Liveness is a current port observation and does not mutate either lease by itself.

Preview-backed retention uses `workspace-preview:<previewId>` as the shared lease identity. Publication binds that lease to the exact developer-shell `sessionId` supplied by the runtime tool and adopts the preview service's authoritative expiry. Renewal updates the same lease; close releases it. No preview foreign key or preview-specific column is added to the developer-shell store.

Finalization confirms an existing lease for every requested `keepRunningSessionId`. When none exists, it creates a standalone lease with a fixed 30-minute expiry. Finalization fails if the process is no longer active or retention cannot be established.

## Consequences

- URL-routing state, process retention, and application liveness are independently truthful surfaces.
- Preview publication cannot succeed if its backing process retention cannot be established; the newly created preview is closed best-effort on that failure.
- Multiple authorities may retain one process, and the process remains live until the final lease ends.
- Supervisor recovery continues to mark live records `LOST`; leases cannot imply recovery of an unavailable operating-system process.
- Runtime behavior does not depend on keyword, URL, path, score, or timing heuristics.
