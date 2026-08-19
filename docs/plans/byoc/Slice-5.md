---
id: kubernetes-byoc-slice-5
domain: runtime
status: active
owner: kestrel-runtime
last_verified_at: 2026-08-17
depends_on:
  - ../../research/2026-08-17-completing-kubernetes-byoc.md
  - Slice-4.md
---

# Slice 5: Provider-Neutral Execution And Preview Routing

## Outcome And User-Visible Result

Hosted execution, renewal, app/model relay, preview publication, Preview Edge, and workspace idle notification use logical Environment gateway/workspace authority. Fly and Kubernetes topology appears only in provider-owned backend builders and explicit legacy readers. Desktop retains its opaque connection/workspace target.

This slice also completes the Kubernetes Workspace Runtime bootstrap required by the Slice 4 Deployment. Acceptance is hermetic, process, and Postgres evidence; Kubernetes creation remains disabled and all KIND or managed-cluster canaries remain Slice 7 work.

## Starting State And Owned Boundaries

Source: [Completing Kubernetes BYOC Accurately](../../research/2026-08-17-completing-kubernetes-byoc.md).

Slices 1-4 provide immutable Environment/provider bindings, active gateway/scope/compute resource rows, replacement resource rows, durable lifecycle commands, a qualified Router URL, and stable Kubernetes Services. The repository already produces gateway-config v3 and reads v2/v3; therefore the neutral configuration is v4 rather than the earlier provisional v2 name.

This slice owns `packages/environment-auth`, `apps/environment-router`, `apps/workspace-runtime`, `apps/preview-edge`, Web execution/renewal/gateway/preview authority, migration `0079_provider_neutral_routing.sql`, and the shared restore-cutover acknowledgement primitive. It does not own Kubernetes creation UI, provider-registry adoption for all lifecycle actions, certification, live networking proof, or connector publication.

## Locked Architectural Decisions

- Execution tickets identify a logical active gateway resource, never a provider, URL, hostname, Machine, Service, or compute resource.
- Private backend topology appears only in authenticated gateway-config v4, built from active provider-resource rows on the Environment's immutable connection.
- The Router resolves all hosted traffic through one atomically activated configuration snapshot and keeps the last valid snapshot after refresh failure.
- `KESTREL_HOSTED_ROUTING_CONTRACT_MODE=legacy|logical-v1` is one global hosted issuance gate. It never branches by provider.
- Readers accept legacy and logical contracts before the gate changes. Legacy renewal preserves the original version.
- Replacement promotion changes provider-resource authority and legacy Fly columns in one locked transaction. Old resources survive until exact route-generation acknowledgement and a signed route probe succeed.
- No provider fallback, URL inference, DNS guessing, redirect following, or capability flag is allowed.

## Public Contracts, Schemas, And Wire Formats

Execution-ticket v3 retains the signed base scope and adds:

```ts
target:
  | { kind: "gateway"; gatewayId: string }
  | { kind: "desktop"; connectionId: string; workspaceRef: string };
```

`gatewayId` is the active `environment_provider_resources.id` with role `gateway`. Readers accept v1/v2/v3. V1/v2 Fly helpers remain legacy-only; v3 gateway and Desktop helpers cannot expose provider topology.

Gateway-config v4 is:

```ts
type GatewayPrivateBackend = {
  kind: "private_dns";
  hostname: string;
  port: number;
  computeResourceId: string;
  desiredRevision: string;
};

type EnvironmentGatewayConfigV4 = {
  version: 4;
  environmentId: string;
  gatewayId: string;
  revision: string;
  routeGeneration: string;
  workspaces: Array<{
    id: string;
    serviceTokenHash: string;
    backend: GatewayPrivateBackend;
  }>;
  previews: Array<{
    id: string;
    workspaceId: string;
    hostname: string;
    port: number;
    expiresAt: string;
    relayTicket: string;
  }>;
  modelGrants: EnvironmentGatewayModelGrant[];
  appGrants: EnvironmentGatewayAppGrant[];
};
```

`revision` hashes the complete canonical configuration. `routeGeneration` hashes the gateway ID and sorted workspace/backend routes only, excluding rotating grants, preview tickets, and nonces. Readers accept v2/v3/v4; v2/v3 normalize only through the isolated legacy Fly resolver.

Additional additive contracts are Preview Edge route-ticket v2 with `gatewayId`, preview relay-ticket v3 with `{kind:"workspace"}`, Preview Edge resolved-route v3 with `{kind:"gateway",url,authorization}`, and workspace idle-notification v2 without `machineId`. Every legacy reader remains during rollout.

Migration `0079_provider_neutral_routing.sql` changes active external-resource uniqueness to `(provider_connection_id, environment_id, resource_role, external_id)`, permits `hosted|desktop|fly` preview targets, defaults new leases to `hosted`, and backfills `fly` leases to `hosted`. Legacy `fly` remains accepted for rollback. No gateway-config table or routing capability flag is added.

## Ordered Implementation Phases

1. Add strict exact-key readers, signers, and helpers for execution v3, config v4, preview route v2, relay v3, resolved route v3, and idle v2 while preserving older readers.
2. Add and register migration `0079_provider_neutral_routing.sql`; update Drizzle schema and migration-history proof.
3. Correct Kubernetes Workspace Runtime Secrets and environment variables: organization, Environment, workspace, workspace service token, ticket key, control-plane URL, individual source fields, and internal gateway URL. Require Fly identity only for legacy tickets.
4. Make Router config activation validate all route/preview maps before one snapshot swap. Expose accepted versions, active revision, route generation, gateway ID, and last failure.
5. Resolve execution, subscriptions, workspace APIs, app/model relay, previews, and idle through the same v4 workspace backend. Missing routes return `ENVIRONMENT_WORKSPACE_ROUTE_UNAVAILABLE`; scope mismatches return 403.
6. Add one Web hosted-authority resolver for issuance, recovery/cancellation, renewal, config, previews, and cutover. Require ready logical rows on the immutable connection.
7. Add provider-owned Fly Machine DNS and Kubernetes Service DNS builders and exact provider-qualified Router URL validation.
8. Return `hosted` from shared execution routing and apply renewal/transport observation to every hosted route. Keep Desktop/local distinct.
9. Add the global rollout mode with `legacy` default and `logical-v1` coordinated issuance. Kubernetes enablement must reject legacy mode.
10. Persist replacement Fly compute/storage rows, promote them transactionally with legacy columns, refresh the Router, require the exact generation acknowledgement, probe a logical route, and retire old resources only after both proofs.
11. Deploy readers before changing the global issuance gate; retain all old readers throughout rollback and pilot windows.

## Data Flow And Lifecycle Behavior

For logical hosted execution, Web resolves the ready Environment/workspace, immutable connection, active gateway/scope/compute rows, exact Router origin, and current route generation. It signs a v3 ticket containing only the gateway resource ID and sends traffic to the qualified Router. The Router verifies signed scope and capability, requires its active v4 gateway/Environment IDs to match, resolves the workspace entry, and proxies to that entry's authenticated private backend.

Fly backend construction emits `<machine>.vm.<app>.internal:43104`. Kubernetes emits `<compute-service>.<environment-namespace>.svc.cluster.local:43104`. Both require active gateway, scope, and compute rows from the Environment connection. `computeResourceId` is the row ID and `desiredRevision` is the row revision.

The Kubernetes runtime receives `KESTREL_ORGANIZATION_ID`, `KESTREL_ENVIRONMENT_ID`, `KESTREL_WORKSPACE_ID`, `KESTREL_WORKSPACE_SERVICE_TOKEN`, ticket key, control-plane URL, individual source fields, and `KESTREL_ENVIRONMENT_GATEWAY_URL=http://gateway.<namespace>.svc.cluster.local:43116`. Logical execution and preview validation requires no Fly environment variable.

Preview Edge accepts only a server-resolved HTTPS Router origin, disables redirects, and sends the signed logical route to the Environment Router. The Router resolves the same v4 workspace backend used by execution; preview relay never constructs Fly DNS in the logical path.

Restore cutover provisions replacement provider rows under the durable operation `replacementId`. In one advisory-locked database transaction it promotes those rows and compare-and-swaps legacy Fly workspace columns. It computes the expected route generation, requests refresh with a logical control-plane tool credential, requires acknowledgement of that exact generation, issues a logical workspace ticket, and probes the bound route. Replay recomputes the same generation and repeats refresh/probe safely.

## Security And Trust Boundaries

- All signed versions use exact outer and nested keys, fixed audiences, bounded TTLs, integer times, signatures, and version-specific targets.
- Shared backend validation rejects schemes, paths, userinfo, IP literals, malformed/non-ASCII DNS, invalid ports, duplicate workspace IDs, and duplicate compute IDs.
- Provider builders prove hostnames from selected active resource rows; the Router never derives or guesses them.
- Fly Router origins are exactly `https://<recorded-app>.fly.dev`. Kubernetes origins are exactly the Environment hash under the qualified connection base domain.
- Preview Edge never accepts a client-supplied target, follows no redirect, and accepts no credentials, ports, paths, or IP origins.
- Gateway refresh authorization accepts logical gateway execution authority and the capability-bound control-plane tool credential; legacy `expectedAppName` exists only for v1/v2.
- App/model grants continue to authenticate workspace service-token hashes from the active configuration.

## Failure, Retry, Recovery, And Rollback Behavior

Unsupported or malformed contracts fail closed without changing active Router state. A fetch, parse, relation, preview reconciliation, or listener failure retains the previous valid snapshot and reports sanitized health evidence.

A missing v4 workspace is unavailable, never a fallback to Fly. Wrong gateway or Environment is forbidden. Renewal rereads active authority; legacy renewal preserves version, while v3 renewal requires the current gateway resource ID.

Before promotion failure cleanup deletes and tombstones only replacement resources. The promotion transaction rolls back if the legacy compare-and-swap loses. After promotion, refresh or probe failure marks the workspace degraded and retains old resources; it never guesses a route or deletes the last known backend. Physical retirement failure records cleanup-pending residuals.

Rollback sets issuance to `legacy` while all dual readers remain deployed. Existing v3/v4 tickets/configs drain naturally; additive schema and resource records remain. Kubernetes creation remains disabled, so rollback never requires a cluster mutation.

## Detailed Test Matrix

- Execution v1/v2/v3, config v2/v3/v4, preview v1/v2/v3 variants, and idle v1/v2: exact keys, signatures, TTLs, malformed targets, provider-field rejection, and legacy renewal.
- Deterministic route generation, complete-config revision, sorted routes, duplicate workspace/compute identities, bad DNS/ports, atomic activation, listener failure, refresh failure, and last-known-good retention.
- Exact Fly and Kubernetes builders, including wrong connection, cross-organization, deleted, replacement, stale, malformed, and customer-supplied identity rejection.
- Router execution, subscriptions, workspace APIs, app/model relay, preview HTTP/WebSocket, and idle notification for logical and legacy paths.
- Missing route, wrong gateway/Environment/workspace, expired ticket, stale resource, refresh rejection, and authorization renewal failure.
- Workspace Runtime logical execution and preview relay without Fly variables plus unchanged legacy Fly Machine enforcement.
- Kubernetes manifest exact Secrets/environment, internal gateway URL, individual source fields, immutable image, and absence of Fly or retired combined-source variables.
- Preview Edge hosted/Desktop/legacy responses and HTTP, redirects, IP literals, credentials, ports, paths, malformed DNS, expired leases, and cross-Environment attempts.
- Postgres migration/backfill, same Kubernetes external names in distinct Environments, authority resolution, renewal, replacement promotion, compare-and-swap loss, acknowledgement loss, replay, worker restart, tombstones, and retained-resource recovery.
- Process traffic using real Router and Workspace Runtime processes with signed logical contracts, refresh acknowledgement, HTTP execution, preview HTTP/WebSocket relay, and negative cross-workspace requests.
- Fly parity and public-boundary checks proving topology remains only in legacy readers and provider builders.

## Validation Commands And Proof Artifacts

Run:

```sh
pnpm --filter @lumi/kestrel-environment-auth test
pnpm --filter @lumi/kestrel-environment-auth typecheck
pnpm --filter @kestrel/environment-router test
pnpm --filter @kestrel/environment-router test:integration
pnpm --filter @kestrel/environment-router typecheck
pnpm --filter @kestrel/workspace-runtime test
pnpm --filter @kestrel/workspace-runtime test:integration
pnpm --filter @kestrel/workspace-runtime typecheck
pnpm --filter @kestrel/preview-edge test
pnpm --filter @kestrel/preview-edge typecheck
pnpm --filter @kestrel/kestrel-one test:unit
pnpm validate:postgres
pnpm validate:process
pnpm run check:public-boundary
pnpm run check:docs
git diff --check
pnpm validate
```

Proof artifacts are classified as hermetic, process, or Postgres. They include mixed-version results, accepted/active versions, expected and acknowledged route generations, signed logical traffic, negative cross-workspace traffic, promotion/retirement references, and last-known-good refresh behavior. No local fake result is labeled isolated-provider evidence.

## Exit Criteria

- New Fly, Desktop, and Kubernetes routing contracts expose no hosted provider topology.
- Kubernetes Workspace Runtime boots and authenticates without Fly variables.
- Every hosted request selects its backend only from authenticated active gateway configuration.
- Preview Edge connects only to the exact control-plane-qualified Router origin.
- Replacement routing changes through one acknowledged generation and old resources survive until signed probe success.
- Legacy readers and the global rollback gate remain available.
- Local hermetic, process, Postgres, docs, and public-boundary validation passes.
- Kubernetes creation remains disabled until Slice 6 and live cluster proof remains Slice 7.

## Explicit Exclusions And Handoff

This slice does not enable Kubernetes Environment creation, complete provider-registry adoption for backups/reconciliation/deletion, expose administration UI, publish connector artifacts, run KIND/cloud canaries, or retire legacy contracts. Slice 6 must require `KESTREL_HOSTED_ROUTING_CONTRACT_MODE=logical-v1` before Kubernetes enablement and consumes the completed provider-neutral routing and acknowledged replacement primitive.
