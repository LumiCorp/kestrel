# ADR 0001: Stable Runtime Bundle authority

- Status: superseded by ADR 0002
- Date: 2026-08-13

## Context

Tenant Fly resources belong to each user's Fly organization. Tenant runtime
images therefore need a public distribution path, while Kestrel still needs one
auditable decision about which immutable Router and Workspace Runtime digests
new work consumes. Copying those digests into Web and worker environment
variables created multiple authorities and allowed a worker restart to revive
stale private images after the database release had already advanced.

## Decision

This decision's requirement for one immutable Router/Workspace pair remains,
but ADR 0002 replaces the signed coordinated release manifest with an
Environment Runtime Version and atomic Environment Runtime Channel pointer.

The signed stable release manifest in Postgres is the sole steady-state image
authority. Ordinary provisioning, recovery, and reconciliation require its
exact public GHCR Router and Workspace Runtime components. Candidate release
operations continue to carry their immutable candidate images as operation
input. Deployed processes do not carry tenant-runtime image variables.

The first and any later release may promote without a canary only while the Fly
Environment fleet is empty. First Environment creation is excluded while that
release is approved or deploying, closing the race between fleet bootstrap and
stable bundle replacement without extending the lockout after a pause.

Turn-worker configuration is governed independently by a role contract. It is
staged before approval, acknowledged when its contract fingerprint changes, and
activated by the coordinated Machine update. The target completes only after a
fresh heartbeat matches the expected source revision and fingerprint.

## Rejected alternatives

- Synchronizing image environment variables across Web and both workers was
  rejected because synchronized copies remain independent authorities and can
  drift during rollback, restart, or partial deployment.
- A platform Fly registry fallback was rejected because user-owned Fly
  organizations cannot consume another organization's private registry and
  tenant provisioning must not depend on Kestrel Fly authority.
- Requiring a paid disposable canary resource before the first tenant was
  rejected. A fleetless database promotion establishes the bundle without
  manufacturing tenant infrastructure.
