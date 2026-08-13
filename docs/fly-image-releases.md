---
id: fly-image-releases
domain: operations
status: active
owner: kestrel-one
last_verified_at: 2026-08-05
depends_on:
  - ../.github/workflows/fly-image-release.yml
  - ../deploy/fly/image-catalog.json
  - ../apps/web/lib/releases/runtime.ts
---

# Fly image releases

Kestrel publishes the Workspace Runtime, Environment Router, Preview Edge,
turn worker, and RunPod worker as one coordinated release bundle. A main-branch
change rebuilds only the images whose declared catalog inputs changed. The
Monday 14:00 UTC schedule rebuilds all five images. Every candidate contains
immutable Fly registry digests; unchanged roles are carried forward from the
stable bundle. Incremental impact and migration detection are calculated from
the stable bundle revision so consecutive unapproved candidates cannot drop an
earlier main-branch change.

## Required configuration

Configure the GitHub `Production` environment with:

- secret `FLY_API_TOKEN`, authorized to build and push all catalog apps;
- variable `KESTREL_RELEASE_PUBLISH_URL`, set to the deployed Kestrel One
  `/api/runtime/releases/candidates` URL.

The `publish-candidate` job must remain attached to that environment so GitHub
Actions makes the release secret and URL available to the workflow.

The dedicated Kestrel One control worker processes promotions and hosted
Environment lifecycle work. It requires `FLY_API_TOKEN` and
`KESTREL_FLY_ORGANIZATION_SLUG` so it can update the three platform Fly Apps.
The turn worker processes durable user turns only and is never a release queue
owner. Controller-owned queue names include the controller contract revision;
an older turn worker therefore cannot claim lifecycle work produced after the
ownership cutover.
The existing `KESTREL_WORKSPACE_RUNTIME_IMAGE` and
`KESTREL_ENVIRONMENT_ROUTER_IMAGE` values remain bootstrap fallbacks until the
first release becomes stable. Postgres is authoritative after that point.

The candidate endpoint accepts only a GitHub Actions OIDC token for the exact
main-branch release workflow and commit SHA. It also requires a fresh controller
heartbeat at the manifest's declared contract revision. The workflow waits for
`/api/health` to report the exact production commit, then deploys or verifies
the controller before publishing the candidate. The controller step skips the
image build only when the running controller heartbeat is fresh and every
controller Machine already carries the current controller input fingerprint.
A candidate is accepted and promoted only while its bundle revision still equals
the serving Kestrel One revision. Newer main revisions cancel obsolete image
builds. No long-lived publisher secret is shared with Kestrel One.

Every manifest records the gateway configuration version emitted by Kestrel
One and the versions accepted by the Environment Router. Change this contract
in two releases: first expand and stabilize router acceptance while the producer
continues emitting the old version; only then change the producer. Rollback is
available only when the stable router explicitly accepts the live producer
version.

## Controller release gate

Bootstrap or deliberately repair the production controller from a clean,
committed revision with:

```bash
pnpm --dir apps/web release:control-worker
```

The command pulls the canonical `lumi-kestrel/one` production configuration,
selects only the explicit controller allowlist, passes secrets to Fly through
standard input, and refuses the cutover while a legacy release or Environment
lifecycle queue has nonterminal work. It deploys the exact local commit and
verifies the readiness file and database heartbeat. Do not run this command in
pull-request CI.

The main release workflow uses a narrower controller path. It computes a
fingerprint from the controller Dockerfile, Fly config, controller scripts,
the bundled worker and readiness artifacts, lockfile, package manifests, schema,
and database migrations. When the fingerprint or controller contract is stale,
it builds and pushes an image containing only the bundled artifacts, resolves
and smokes the immutable Fly registry digest, updates the stopped standby by a
unique tag without starting it, verifies Fly resolved the expected digest,
updates the single running Machine, and verifies the fresh contract heartbeat.
If the fingerprint and heartbeat are already current, it skips the build and
Machine update.

## Promotion

1. Open Kestrel Admin, choose **Releases**, and select a dedicated Fly canary
   Environment.
2. Review the candidate's rebuilt and carried-forward components.
3. If the candidate contains a Web database migration, apply it through the
   normal Kestrel One deployment path, verify `pnpm --dir apps/web
   db:migrate:deploy` completed against the production database, and verify the
   control plane is healthy. Then mark the migration runbook complete. This
   acknowledgment records the administrator and time; it does not run a
   migration.
4. Approve the release.

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
