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
heartbeat at the manifest's declared contract revision. The workflow deploys
and checks the controller, then waits for `/api/health` to report the exact
production commit before publishing the candidate. No long-lived publisher
secret is shared with Kestrel One.

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

Promotion updates Preview Edge and the RunPod worker, then the canary, then all
other active Fly Environments sequentially, and finally the turn worker. New
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
creates a new coordinated release using the prior stable digests and follows the
same canary-first rollout.
