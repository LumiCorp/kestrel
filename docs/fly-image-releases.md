---
id: fly-image-releases
domain: operations
status: active
owner: kestrel-one
last_verified_at: 2026-08-13
depends_on:
  - ../.github/workflows/fly-image-release.yml
  - ../deploy/fly/image-catalog.json
  - ../apps/web/lib/releases/runtime.ts
---

# Fly image releases

## Unified release attempts

Candidate publication is one serialized, non-cancelling release attempt. The
attempt owns the exact Git revision, GitHub run identity, controller artifact,
five managed images, migration head, and all smoke evidence. Publication uses
aggregate failure reporting and never mutates production.

Every new candidate uses manifest v3. Older candidates are not promotable and
must be safely invalidated and republished. `force_all=true` builds every
artifact with an attempt-unique tag and does not reuse revision tags.

After publication, dispatch `Prepare release candidate` with the candidate
UUID. That authenticated workflow deploys the controller digest stored in the
candidate; it never rebuilds it. Preparation succeeds only after the exact
controller identity is visible in its heartbeat and the production migration
ledger matches the candidate head and history-lock hash.

Approval remains blocked until preparation, migration verification and
operator migration signoff are complete. Promotion rechecks those conditions
and requires role-specific readiness for Preview Edge, the turn worker and the
RunPod worker before a target or release can complete.

Kestrel publishes the Workspace Runtime, Environment Router, Preview Edge,
turn worker, and RunPod worker as one coordinated release bundle. Every
candidate proves all five images plus the release controller. A normal run may
reuse an exact-revision image that already exists; the Monday 14:00 UTC schedule
and `force_all=true` rebuild every artifact under attempt-unique tags. Every candidate contains
immutable OCI digests. Workspace Runtime and Environment Router are signed and
published publicly at `ghcr.io/lumicorp/kestrel-workspace-runtime` and
`ghcr.io/lumicorp/kestrel-environment-router`; platform services remain in
their exact private Fly repositories. Migration detection is calculated from
the stable bundle revision so consecutive unapproved candidates cannot hide an
earlier main-branch migration.

## Required configuration

Configure the GitHub `Production` environment with:

- secret `FLY_API_TOKEN`, authorized to build and push all catalog apps;
- secret `POSTGRES_URL_NON_POOLING`, containing the authoritative direct Kestrel
  One production database URL;
- variable `KESTREL_RELEASE_DATABASE_TARGET_SHA256`, containing the approved
  non-secret host, port, and database fingerprint for that URL;
- variable `KESTREL_RELEASE_PUBLISH_URL`, set to the deployed Kestrel One
  `/api/runtime/releases/candidates` URL;
- variable `KESTREL_RELEASE_PREPARE_URL`, set to the deployed Kestrel One
  `/api/runtime/releases/candidates/prepare` URL.

The workflow's GitHub token needs `packages: write`. Both tenant-runtime GHCR
packages must be public. Before accepting a candidate, the publisher resolves
each pushed tag to a digest, runs its image smoke test, signs the digest with
keyless Cosign, verifies the exact workflow identity, and proves an anonymous
digest pull.

The `publish-candidate` job must remain attached to that environment so GitHub
Actions makes the release secret and URL available to the workflow.

The dedicated Kestrel One control worker processes promotions and hosted
Environment lifecycle work. It requires `FLY_API_TOKEN` and
`KESTREL_FLY_ORGANIZATION_SLUG` so it can update the three platform Fly Apps.
The turn worker processes durable user turns only and is never a release queue
owner. Controller-owned queue names include the controller contract revision;
an older turn worker therefore cannot claim lifecycle work produced after the
ownership cutover.
Platform credentials are never a fallback for tenant provisioning. Each tenant
Environment operation resolves only that Kestrel organization's encrypted Fly
connection and creates resources only in the exact user-entered Fly organization.

The existing `KESTREL_WORKSPACE_RUNTIME_IMAGE` and
`KESTREL_ENVIRONMENT_ROUTER_IMAGE` values remain bootstrap fallbacks until the
first release becomes stable. Postgres is authoritative after that point.

The candidate endpoint accepts only a GitHub Actions OIDC token for the exact
main-branch release workflow and commit SHA. Its preflight rejects an
incompatible serving revision before any artifact build. The authoritative
attempt lease serializes publication and is renewed throughout long builds. A
successful publication response is accepted only when it contains a UUID
release ID and the literal status `candidate`; malformed 2xx responses fail the
workflow.

The `publish-candidate` job uses the setup action at its pinned commit and Fly
CLI `0.4.82`. Its fail-fast order is fixed: validate the revision, verify or
apply the bounded additive release-control schema bootstrap, authenticate the
Fly and GHCR registries, wait for `/api/health` to serve the exact commit,
complete the authenticated publication preflight, acquire the attempt, then
build and smoke the controller and all five managed images before one manifest
is published. The bootstrap accepts only the direct production URL and its
approved target fingerprint. It applies only `0069_unified_release_attempt`
from exact predecessor `0068_byo_fly_onboarding`, records before/after ledger
evidence, and otherwise fails without mutation. Once `0069` exists, the gate is
verification-only and never applies later application migrations. Every
artifact build is allowed to settle so a failed run reports all observed
failures. Controller deployment is a separate, explicit
preparation operation; candidate publication never changes controller Machines.
Preparation injects the candidate's exact immutable Environment Router and
Workspace Runtime digests into the controller Machine, so stale bootstrap values
cannot prevent startup or weaken artifact identity.
A candidate is accepted and promoted only while its bundle revision still
equals the serving Kestrel One revision. Workflow runs queue instead of
cancelling one another, and the server-side attempt lease remains authoritative.
No long-lived publisher secret is shared with Kestrel One.

The release-control bootstrap exists only to make candidate publication's own
persistence contract available. Candidate application migrations remain owned
by the preparation and operator migration runbook: publishing a candidate does
not apply them, acknowledge them, or weaken their compatibility checks. The
authenticated publication preflight and every attempt mutation verify the
complete `0069` schema and return `409 RELEASE_MIGRATION_BLOCKED` before ORM
access when the bootstrap is absent or drifted.

Every manifest records the gateway configuration version emitted by Kestrel
One and the versions accepted by the Environment Router. Change this contract
in two releases: first expand and stabilize router acceptance while the producer
continues emitting the old version; only then change the producer. Rollback is
available only when the stable router explicitly accepts the live producer
version.

## Controller release gate

The standard release path is the pinned `Prepare release candidate` workflow.
It reads the immutable controller image and fingerprint from the stored v3
manifest, updates the stopped standby and then the primary, and accepts
preparation only after the exact machine identity appears in the canonical
controller heartbeat. It also verifies the production Drizzle ledger against
the candidate's migration head and history-lock hash.

The following command remains an explicit bootstrap or repair tool only; it is
not candidate preparation and must not be used to substitute a rebuilt image
for the digest recorded in a candidate:

```bash
pnpm --dir apps/web release:control-worker
```

The command pulls the canonical `lumi-kestrel/one` production configuration,
selects only the explicit controller allowlist, passes secrets to Fly through
standard input, and refuses the cutover while a legacy release or Environment
lifecycle queue has nonterminal work. It deploys the exact local commit and
verifies the readiness file and database heartbeat. Do not run this command in
pull-request CI.

Candidate publication uses a non-deploying controller build path. It
computes a fingerprint from the controller Dockerfile, Fly config, controller
scripts, the bundled worker and readiness artifacts, lockfile, package
manifests, schema, and database migrations. It builds and pushes an image
containing only the bundled artifacts, resolves and smokes the immutable Fly
registry digest, and records that evidence in the workflow log. It does not
inspect or update the controller Machine topology.

Every managed image smoke runs an executable image contract. In particular,
the turn-worker smoke invokes the image's real default `CMD`, requires the exact
missing-database startup failure, and verifies the immutable image's Git
revision label. A source-file check or `tsx --version` is not sufficient release
evidence.

Before rollout, an operator can rerun the complete local contract journey with
`pnpm release:verify-pipeline`. Given a captured v3 manifest, run
`pnpm release:smoke-manifest MANIFEST.json` to execute all six real Docker
smokes against the exact immutable candidate digests after authenticating the
local Docker client to Fly and GHCR. The latter command
settles every smoke and reports all observed role failures together.

The explicit controller deployment path updates the stopped standby first and
then the single running Machine. Fly may transcode an OCI manifest to its
deployment manifest, so post-update verification binds the authoritative
Machine state to the exact source revision, controller input fingerprint, and
startup command instead of requiring the source manifest digest to survive that
provider-owned representation change.

## Promotion

1. Open Kestrel Admin, choose **Releases**, and select a dedicated Fly canary
   Environment.
2. Review the candidate's six exact immutable artifacts and smoke evidence.
3. Dispatch `Prepare release candidate` for that candidate UUID from the exact
   candidate revision. Do not approve until preparation records the exact
   controller heartbeat and migration-ledger proof.
4. If the candidate contains a Web database migration, review the verified
   ledger evidence and mark the migration runbook complete. This acknowledgment
   records the administrator and time; it does not run a migration.
5. Approve the release.

When Environment images change, promotion updates the canary first, then
Preview Edge, the RunPod worker, all other active Fly Environments sequentially,
and finally the turn worker. Global-only bundles retain Preview Edge, RunPod,
then turn-worker order. New
executions are blocked for the Environment currently draining. A drain that
still has active executions after 30 minutes pauses the release.

The canary must be ready or degraded when selected and when promotion starts.
Requested or provisioning Environments wait for provisioning before rollout.
Non-canary Environments that become failed, deleting, deleted, or archived are
recorded as skipped so an unavailable Environment cannot deadlock promotion or
rollback.

Stopped Workspaces receive a direct volume snapshot and immutable image update
without being launched. They remain `configured_unverified` until their next
start verifies health on the new digest. Desktop Environments are excluded.

## Failure and recovery

Retryable provider failures do not immediately pause promotion. Network errors,
HTTP 408, 429, and 5xx responses enter a persisted 15-minute retry window. The
controller reads authoritative provider state before every retry; if the target
already satisfies the requested postcondition, it completes the target without
replaying the mutation. Admin shows the attempt, next retry time, last provider
response, and authoritative state while the release remains deploying.

Promotion pauses immediately for non-retryable failures, contradictory provider
state, or failed health checks, and pauses when the retry budget is exhausted.
Only then is **Retry failed target** available. There is no automatic rollback.
Choose **Roll back to stable** only when the active release is paused; rollback
creates a new coordinated release for targets the failed release may already
have mutated and follows the same canary-first rollout. Rollback is blocked when
the stable router has unknown or incompatible gateway evidence.

When a legacy stable bundle lacks compatibility metadata, deploy the repair with
`KESTREL_RELEASE_COMPATIBILITY_BOOTSTRAP=allow-legacy-stable`. This literal is a
one-time bridge: Kestrel rejects it after a metadata-bearing stable bundle
exists. While the legacy rollback remains paused, publish the exact repair
candidate and choose **Recover forward**. Forward recovery supersedes the paused
release atomically and starts with the saved canary. Remove the bridge and
redeploy the same revision immediately after the recovered release becomes
stable.
