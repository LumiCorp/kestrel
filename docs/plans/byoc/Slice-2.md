---
id: kubernetes-byoc-slice-2
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-17
depends_on:
  - ../../research/2026-08-17-completing-kubernetes-byoc.md
  - Slice-1.md
---

# Slice 2: Persistence, Migrations, And Provider Resolution

## Outcome And User-Visible Result

Kestrel can durably represent multiple Kubernetes cluster connections, provider-neutral Environment resources, and connector commands without pretending Kubernetes resources are Fly apps or Machines. Existing Fly Environments are backfilled and continue operating through the neutral model with an additive rollback path.

This slice is deliberately not user-visible beyond unchanged Fly behavior and internal diagnostics. Kubernetes connections cannot yet enroll or mutate a cluster.

## Starting State And Owned Boundaries

Source: [Completing Kubernetes BYOC Accurately](../../research/2026-08-17-completing-kubernetes-byoc.md).

Slice 1 supplies the versioned provider contract, resource roles, normalized errors, Kubernetes profile configuration, and connector command/result envelopes.

Current persistence in `apps/web/drizzle/schema.ts` allows only `fly` and `desktop`, requires a Fly-style region, stores gateway identity in `flyAppName`, `flyNetworkName`, and `flyGatewayMachineId`, and stores workspace identity in `flyMachineId` and `flyVolumeId`. Fly authority is stored in `aiProviderConnections`, which also serves a separate AI-provider domain. `environmentOperations` already owns durable operation identity, attempts, stages, checkpoints, and provider request evidence.

This slice owns additive schema, backfill, compatibility reads/writes, provider resolution, and Postgres recovery proof. It does not own connector network routes, Kubernetes resource mutation, execution routing, or administration UI.

## Locked Architectural Decisions

- Organizations may register multiple Kubernetes connections and may mark one default for new Environments.
- A Kubernetes Environment references exactly one connection for its lifetime.
- Desktop Environments have no hosted infrastructure connection.
- Fly is backfilled into the neutral connection and resource model; `aiProviderConnections` remains readable during the rollback window.
- Kubernetes placement is its connection; `region` becomes optional instead of receiving a synthetic value.
- Kubernetes Environment creation requires a positive `workspaceLimit`; Fly and Desktop remain compatible with existing rows.
- Provider resources are normalized rows, not a growing set of provider columns or an unvalidated JSON blob on Environment records.
- Legacy Fly columns and ticket versions are not dropped in this arc.

## Public Contracts, Schemas, And Wire Formats

Add `environmentProviderConnections` with:

- `id`, `organizationId`, `provider`, `displayName`, and optional default flag;
- lifecycle status `pending`, `enrolling`, `qualifying`, `ready`, `degraded`, `revoked`;
- support status `unverified`, `qualified`, or `certified`;
- versioned non-secret `configuration` and `qualificationEvidence` JSON validated at every read;
- `connectorId`, `lastSeenAt`, `lastQualifiedAt`, `failureCode`, and `failureMessage`;
- encrypted Fly credential material only for migrated Fly authority; and
- timestamps and actor IDs for configuration, attestation, qualification, and revocation.

Uniqueness permits many provider connections per organization but only one active default per provider. Revoked connections remain addressable for audit and cleanup.

Add `environmentProviderResources` with organization, Environment, optional workspace, provider connection, resource role, external ID, provider UID, desired revision, observed generation, state, validated provider metadata, deleted timestamp, and lifecycle timestamps. Enforce one active resource for singleton roles and allow many snapshots. External ID uniqueness is scoped by connection, role, and active state.

Add generic Kubernetes connector persistence:

- `infrastructureConnectorEnrollmentRequests`
- `infrastructureConnectorConnections`
- `infrastructureConnectorRequestNonces`
- `infrastructureConnectorCommands`
- `infrastructureConnectorCommandEvents`

The connection row stores signing and encryption public keys, current and previous credential hashes, credential rotation/grace times, supported contract versions, connector version, replica presence, and revocation state. It never stores a Kubernetes bearer token or kubeconfig.

Commands store the Slice 1 envelope, operation ID, status `queued`, `claimed`, `running`, `completed`, `failed`, or `cancelled`, claim token hash, claim expiry, attempt, contiguous event cursor, normalized result/error, and timestamps. Enforce one command per provider operation plus idempotency key. Events are unique by command and sequence.

Alter Environment persistence additively:

- add `kubernetes` to the provider check;
- add nullable `providerConnectionId` referencing the neutral connection;
- add nullable validated provider placement;
- add nullable positive `workspaceLimit`;
- allow `region` to be null for Kubernetes;
- require connection and workspace limit for Kubernetes;
- require no hosted connection for Desktop; and
- retain existing Fly identity columns and checks during the compatibility window.

Extend `environmentOperations` evidence with a durable connector command reference if `providerRequestId` cannot safely carry a foreign key. Store command and desired revision inside the existing operation checkpoint as well, so replay can reattach even if the worker restarts between enqueue and result persistence.

Expose repository methods for connection configuration, resource upsert/read/tombstone, command enqueue/claim/lease/event/complete, and provider resolution. Callers never issue ad hoc table queries for these invariants.

## Ordered Implementation Phases

1. Add tables and nullable columns without changing existing reads.
2. Add strict runtime parsers for every versioned JSON field and reject corrupt rows at repository boundaries.
3. Backfill one Fly environment-provider connection per organization with active Fly Environments, preserving the existing encrypted authority and organization slug.
4. Backfill Fly Environment scope, gateway, workspace compute, and workspace storage resource rows from legacy columns. Record the backfill source and do not manufacture missing resources.
5. Add dual-write behavior for all Fly provision, update, replacement, backup, and deletion paths in the same transaction that updates legacy identity.
6. Change reads to prefer neutral resource rows and fall back to legacy Fly columns. Emit diagnostic evidence when fallback is used.
7. Add the provider registry: Desktop routing is resolved explicitly; hosted Environments require a connection; Fly creates the Slice 1 adapter; Kubernetes resolves to a connector proxy placeholder that rejects mutations until Slice 3.
8. Remove direct `new FlyMachinesEnvironmentProvider` construction from lifecycle entry points and route through the registry.
9. Add database constraints only after backfill validation proves every eligible row satisfies them.

## Data Flow And Lifecycle Behavior

Environment creation resolves an explicit or default provider connection inside the same transaction that creates the Environment. Kubernetes creation remains disabled, but its repository validation is complete.

A Fly provision operation writes the existing app/Machine/volume fields and corresponding provider-resource rows atomically. A retry reads the neutral reference first; a pre-migration row falls back to its Fly column and repairs the missing resource row during the next successful mutation.

A future Kubernetes operation resolves its connection, creates a connector command with the operation idempotency key, and stores the command ID in the operation checkpoint. Duplicate enqueue returns the existing command. Command claims use row locking and lease expiry so two connector replicas cannot own the same command simultaneously.

Command events append only at the next contiguous sequence. Replayed events with identical sequence and payload are idempotent; mismatched duplicates are rejected. Completion is compare-and-set against the current claim token and active status.

## Security And Trust Boundaries

- Connection configuration contains no plaintext secrets.
- Connector bearer credentials are stored only as hashes; encryption private keys remain in the customer cluster.
- Fly credentials use the existing trusted encryption surface and are never returned by repository APIs.
- All connection, resource, and command queries bind organization ID as well as object ID.
- Nonces are unique per connector and expire after the shared connector replay window.
- Command payloads accept encrypted secret envelopes only; decrypted material never enters Postgres.
- Provider metadata has size limits and exact parsers to prevent unbounded or secret-rich evidence.

## Failure, Retry, Recovery, And Rollback Behavior

Migration deployment is additive: tables and columns first, application dual-write second, read preference third, constraints last. A mixed fleet can continue using legacy Fly fields while newer instances populate neutral rows.

Backfill runs transactionally in bounded batches, is repeatable, and records counts for eligible, migrated, already migrated, and incomplete rows. It stops on identity conflicts rather than choosing a winner.

If neutral and legacy Fly identities disagree, mark the Environment degraded and require reconciliation; never silently overwrite either side. If neutral data is missing, legacy fallback remains available. If legacy fields are missing after neutral data exists, do not repopulate them for Kubernetes.

Rollback returns reads to legacy Fly fields and stops neutral dual writes. New tables and nullable columns remain. No rollback deletes connections, resources, commands, or evidence.

Expired connector claims return to claimable state without creating a second command. A completed or cancelled command can never be reclaimed. Revocation cancels queued/active commands but preserves events and results.

## Detailed Test Matrix

- Fresh schema accepts Fly, Desktop, and structurally valid Kubernetes rows.
- Provider checks reject Kubernetes without connection or workspace limit and Desktop with a hosted connection.
- Multiple Kubernetes connections per organization and exactly one active default.
- Backfill of complete Fly Environment and workspace resources.
- Repeat backfill produces no duplicates.
- Partial legacy Fly rows remain explicit and are not fabricated.
- Neutral/legacy disagreement degrades instead of overwriting.
- Fly dual writes are atomic across provision, replacement, restore, and deletion.
- Neutral read, legacy fallback, and read-repair behavior.
- Provider registry returns the correct adapter and rejects mismatched connection/provider pairs.
- Command enqueue idempotency, concurrent claim, lease renewal, expiry, reclaim, cancellation, and completion.
- Contiguous event acceptance, identical replay, gap rejection, and conflicting duplicate rejection.
- Organization isolation for connections, resources, commands, events, and nonces.
- Invalid versioned JSON fails at repository boundary.
- Forward migration, old-application compatibility, new-application compatibility, and rollback to old reads.

## Validation Commands And Proof Artifacts

- Run focused schema, store, Fly connection, provider registry, provisioner, backup, and connector repository tests.
- Run the Postgres validation leaf because this slice changes durable lifecycle state and concurrency.
- Run migration boundary and replay tests against both empty and representative pre-migration fixtures.
- Run `pnpm run check:public-boundary`.
- Run `pnpm validate` before the slice PR is ready.
- Save backfill counts, constraint validation output, and mixed-version compatibility results as migration evidence.

## Exit Criteria

- Every active Fly Environment has a neutral connection and all discoverable provider-resource rows.
- Fly lifecycle mutations write legacy and neutral identities atomically.
- All shared lifecycle entry points resolve providers through the registry.
- Kubernetes Environment, connection, resource, and connector-command state can be persisted without Fly fields.
- Command claim, lease, replay, and completion invariants pass concurrency tests.
- Rolling forward and rolling application code back do not lose Fly operability or evidence.

## Explicit Exclusions And Handoff

This slice does not expose connection enrollment, run a connector, mutate Kubernetes, change execution tickets, or enable Kubernetes creation. Slice 3 implements connector packaging, authentication, presence, transport, and two-phase cluster qualification on these tables and contracts.
