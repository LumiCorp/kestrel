# ADR 0002: Independent production delivery channels

- Status: accepted
- Date: 2026-08-14
- Supersedes: ADR 0001 for hosted production delivery

## Context

Kestrel previously represented unrelated provider deployments as one database
release candidate and used a controller, targets, leases, heartbeats, and exact
cross-provider revision waits to coordinate them. That state did not express a
product requirement. It coupled failures and made the release workflow, rather
than each provider and the Environment lifecycle, the owner of readiness.

Only the Workspace Runtime and Environment Router have a real atomic product
relationship: new tenant Environments must snapshot one compatible immutable
pair. Existing tenant Environments already have a durable lifecycle operation
that owns backup, update, verification, retry, recovery, and rollback.

## Decision

`production` is the reviewed production decision. Database migration, native
Vercel deployment, affected Fly roles, and the managed RunPod worker deploy in
independent lanes from that branch. The catalog's explicit input paths are the
fail-closed trigger contract.

Workspace Runtime and Environment Router publish immutable role-specific
digests as an Environment Runtime Version. One generation-checked production
Environment Runtime Channel pointer selects the current and previous version.
The pointer advances automatically only after exact image smoke, a durable
canary Environment update, and the existing live Workspace and preview proofs.
It never mutates the remaining fleet.

Runtime publication and promotion use a narrow GitHub OIDC API. Workers use
role-allowlisted configuration and provider-native private Fly health checks.
Existing Environments update explicitly through the product UI or idempotent
operator CLI using their existing lifecycle operation.

## Consequences

- One provider failure cannot block or roll back another provider channel.
- Source revision equality is diagnostic, not production authority.
- New Environment provisioning fails closed without a current runtime version.
- Runtime pointer races fail with a generation conflict and require rebuilding
  the proposed pair from the new current version.
- Legacy release tables remain during one rollback window, then a separate
  contract migration removes them and pre-reset rollback support.
