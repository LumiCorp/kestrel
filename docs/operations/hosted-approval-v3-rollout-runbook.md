---
id: hosted-approval-v3-rollout
domain: operations
status: active
owner: kestrel-one
last_verified_at: 2026-08-26
depends_on:
  - ../planning/hosted-approval-simplification/issues/05-contract-legacy-approval-paths.md
  - ../production-delivery-channels.md
  - ../../deploy/fly/kestrel-one-runner/ROLLOUT.md
  - ../../deploy/fly/kestrel-one-turn-worker/ROLLOUT.md
---

# Hosted approval V3 guided rollout

This is the operator procedure for
[Issue 05](../planning/hosted-approval-simplification/issues/05-contract-legacy-approval-paths.md).
It deploys compatible readers first, proves the inactive V3 path, activates V3
producers on exact targets, observes legacy drain, and only then permits a
separate cleanup release.

This runbook does not authorize a deployment. The operator must have an
approved production change window and must retain every checkpoint named
below. Never paste cookies, database URLs, OAuth tokens, execution tickets, or
provider credentials into the evidence record.

## Release shape

Use two qualified commits and never collapse them into one production
promotion:

1. **Compatibility commit:** migrations, dual V2/V3 readers, strict V3
   decisions, proof tooling, telemetry report, and Runtime defaulting to V2.
2. **Activation commit:** the same qualified tree plus
   `KESTREL_HOSTED_APPROVAL_PROTOCOL=v3` in the Workspace Runtime and
   turn-worker images.

The V2 default is the inactive boundary. An invalid configured value fails
startup. Existing V2 interactions remain V2; existing V3 interactions remain
V3. Neither version may be reconstructed or silently converted.

## Target checklist

Complete current provider state before changing anything.

| Target | Current production state | Required action | Required proof | Status |
| --- | --- | --- | --- | --- |
| PostgreSQL | Record migration head | Apply additive migrations through the native `one` build | Migration and build succeeded | Pending |
| Vercel `one` | Record deployment ID and commit | Promote compatibility commit, then activation commit | Exact deployment, health, approval API | Pending |
| Vercel `docs` | Record deployment ID and commit | Native deployment collateral for both promotions | Exact build and production URL | Pending |
| Workspace Runtime | Inventory every Environment image | Publish compatibility pair, then V3 pair | Local image E2E, disposable canary, live canary Environment | Pending |
| Environment Router | Inventory every Environment image | Publish with Workspace Runtime under the same tag | Pair smoke, operation, Workspace and Preview canaries | Pending |
| turn-worker | Inventory every started and stopped Machine | Publish compatibility image, then V3 image; update one Machine at a time | Worker check, durable turn, hosted approval proof | Pending |
| Mobile API | Part of `one`; no separate binary here | Keep V2/V3 and boolean drain readers during rollout | Mobile contract tests and one V3 decision | Pending |
| control-worker | Record health only | No image change | Healthy before Environment operations | Unaffected |
| preview-edge | Record current image | No change | None beyond production health | Unaffected |
| runpod-worker / managed RunPod | Record current state | No change and no spend | None | Unaffected |

Stop if the repository delta proves an “unaffected” target changed.

## Stage 0 — qualify both commits locally

Record:

```text
Operator:
Start time:
Compatibility commit:
Activation commit:
origin/main:
origin/production:
merge base:
changed files:
compatibility tag:
activation tag:
canary Environment:
current runtime pair:
turn-worker Machine IDs, states, checks, and images:
rollback image for every target:
```

Refresh the protected branches and inspect the complete delta. Require a clean
checkout at each candidate commit. Run:

```bash
pnpm validate
pnpm validate:postgres
pnpm validate:process
pnpm validate:audit
pnpm --dir apps/web build
```

Build the three affected production images at each candidate commit. Use a
different local tag for each commit:

```bash
docker buildx build --platform linux/amd64 --load \
  --file apps/workspace-runtime/Dockerfile \
  --tag local/kestrel-workspace-runtime:<candidate-tag> \
  --build-arg KESTREL_BUILD_ID=<candidate-tag> .
bash apps/workspace-runtime/scripts/image-smoke.sh \
  local/kestrel-workspace-runtime:<candidate-tag>

docker buildx build --platform linux/amd64 --load \
  --file apps/environment-router/Dockerfile \
  --tag local/kestrel-environment-router:<candidate-tag> \
  --build-arg KESTREL_BUILD_ID=<candidate-tag> .
bash apps/environment-router/scripts/image-smoke.sh \
  local/kestrel-environment-router:<candidate-tag>

docker buildx build --platform linux/amd64 --load \
  --file deploy/fly/kestrel-one-turn-worker/Dockerfile \
  --tag local/kestrel-one-turn-worker:<candidate-tag> \
  --build-arg KESTREL_BUILD_ID=<candidate-tag> .
bash deploy/fly/kestrel-one-turn-worker/smoke.sh \
  local/kestrel-one-turn-worker:<candidate-tag>
```

The compatibility images must report V2 as their hosted approval producer.
The activation Workspace Runtime and turn-worker images must report V3. Run a
real approved model through the exact local images and retain the participating
image IDs. If the repository cannot route that real-model path through these
local images, stop here and repair that test seam; source tests, image health,
or a later production canary do not replace it.

**Resume evidence:** both commit SHAs, four validation results, Web build,
three image IDs and smokes for each commit, and exact local-image real-model
results.

## Stage 1 — compatibility promotion

Promote only the compatibility commit through the protected `main` to
`production` process.

1. Wait for native `one` and `docs` deployments.
2. Require the `one` migration/build and both production deployments to pass.
3. Confirm Web and Mobile read V2 and V3 while old boolean submissions remain
   accepted.
4. Confirm new hosted interactions are still emitted as V2.
5. Run a denial-only compatibility canary.

Set the named canary variables in the existing operator environment, including
`KESTREL_ONE_CANARY_APPROVAL_PROTOCOL=legacy_v1`, then run:

```bash
pnpm --dir apps/web canary:github:approval
```

The command must report `legacy_v1`, a persisted decline, and
`effectState=not_started`.

**Rollback:** restore Web to a build that still understands the additive
migrations. Never reverse the migrations.

**Resume evidence:** promotion PR and commit, both Vercel deployment IDs,
migration result, production health, and legacy canary JSON.

## Stage 2 — compatible image rollout

Publish only the compatibility images:

```bash
pnpm production:image:publish --role workspace-runtime --tag <compatibility-tag>
pnpm production:image:publish --role environment-router --tag <compatibility-tag>
pnpm production:image:publish --role turn-worker --tag <compatibility-tag>
```

Follow the
[runtime-pair rollout](../../deploy/fly/kestrel-one-runner/ROLLOUT.md) and
[turn-worker rollout](../../deploy/fly/kestrel-one-turn-worker/ROLLOUT.md)
exactly:

1. Update one started turn-worker Machine.
2. Require the `worker` check and one durable ordinary turn.
3. Update remaining started Machines individually while preserving capacity.
4. Update stopped Machines individually without starting them.
5. Run the disposable runtime-pair canary.
6. Update one exact canary Environment and wait for
   `environment.update.ready`.
7. Run the live Workspace and Preview canaries.
8. Activate the compatibility pair.
9. Update every approved Environment through a separate operation.

Do not start the drain clock. V2 production is still expected.

**Rollback:** restore each exact turn-worker Machine to its recorded image.
Restore the complete Router/Workspace pair on the canary Environment, prove
both canaries, reactivate the previous pair, then update other Environments
individually.

**Resume evidence:** published immutable images, every Machine before/after
record, durable turn, canary operation, Workspace/Preview results, activation
record, and per-Environment operations.

## Stage 3 — inactive V3 acceptance

Promote the activation commit through the protected `main` to `production`
path and wait for the `one` and `docs` deployments. Publish one immutable set
of activation images:

```bash
pnpm production:image:publish --role workspace-runtime --tag <activation-tag>
pnpm production:image:publish --role environment-router --tag <activation-tag>
pnpm production:image:publish --role turn-worker --tag <activation-tag>
```

Before general V3 rollout, run those images only on one controlled canary
Environment and one selected started turn-worker Machine. Preserve all
other readers on the compatibility images. Use exact-target provider changes;
do not activate an app-wide Fly secret to perform this canary.

Run the V3 Chromium canary with
`KESTREL_ONE_CANARY_APPROVAL_PROTOCOL=durable_v3`,
`KESTREL_ONE_CANARY_EXPECT=approval`, and one decision at a time:
`decline`, `approve_once`, then `remember_approval`. For approving runs, set
`KESTREL_ONE_CANARY_CONFIRM_GITHUB_MUTATION=CREATE_ONE_CANARY_ISSUE`.

The command clicks the visible card in Chromium, requires all three buttons,
joins the browser request to `thread_interactions`,
`app_operation_approvals`, its external binding, requested and consuming
executions, remembered evidence, and terminal effect, and exits nonzero on any
identity mismatch.

Run these scenarios in order:

1. Decline: no consumption and `not_started`.
2. Approve Once: committed effect.
3. Same thread, next call: another card appears; decline it.
4. Remember Approval: committed effect and exact remembered row.
5. Same thread, next call with
   `KESTREL_ONE_CANARY_EXPECT=remembered_auto`: no card, a new turn completes,
   and the exact issue is read back from GitHub. Supply
   `KESTREL_ONE_CANARY_GITHUB_READ_TOKEN` only when the canary repository is
   not publicly readable.
6. A different designated thread: another card appears; decline it.

Retain focused acceptance results for wrong actor, organization, project,
Environment, resource, tool revision, and authority revision; expiry; worker
and registry restart; one-time provider consumption; credential rotation;
`not_started`; and `unknown`. Do not mutate real production policy merely to
manufacture negative cases.

For every card-bearing run, independently execute:

```bash
pnpm --dir apps/web hosted-approval:proof -- \
  --thread <thread-id> \
  --interaction <interaction-id>
```

**Stop condition:** any identity mismatch, duplicate consumption, approved
state without committed effect, decline with an effect, remembered call that
shows a card, or new thread that skips the card.

**Resume evidence:** browser video or trace, canary JSON, proof JSON, GitHub
effect URL, negative acceptance results, restart proof, credential-rotation
proof, and exact canary target images.

## Stage 4 — activate V3 broadly

Use the exact activation images accepted in Stage 3. Do not rebuild or assign
a second tag between canary acceptance and general rollout.

Repeat the exact turn-worker and runtime-pair rollout from Stage 2: one started
worker, durable plus hosted canaries, remaining started workers, stopped
workers, disposable pair canary, one canary Environment, live canaries,
activation, then every approved Environment individually.

Existing V2 interactions finish as V2 or expire. Existing V3 interactions
finish as V3. Never downgrade either into reconstruction.

**Rollback:** restore compatible V2 images on exact targets while retaining
dual readers. Do not roll back migrations. Do not turn an already-created V3
interaction into V2.

**Resume evidence:** second promotion, exact images, target-by-target rollout,
full hosted acceptance, runtime activation, and rollback identities.

## Stage 5 — observe legacy drain

Record the time when every approved producer is V3 and every compatible reader
is deployed. Run:

```bash
pnpm --dir apps/web hosted-approval:drain-report -- \
  --since <drain-start-ISO-timestamp>
```

Repeat it throughout the observation window. Any compatibility decision or
legacy provider consumption resets the drain start. `databaseDrainReady=true`
is necessary but never authorizes cleanup; the report deliberately always
returns `cleanupAuthorized=false`.

Retain zero old decisions and pending interactions, zero actionable or newly
consumed `legacy_v1` provider approvals, closed old authority expiries,
terminal incident targets, every started and stopped turn-worker image, every
tenant runtime pair, and one complete worker rollout cycle after the last
compatibility use.

The current provider approval cap is five minutes, but the actual retained row
expiry and complete image inventories are authoritative. Do not substitute a
five-minute timer for those facts.

**Resume evidence:** timestamped report series, complete Machine and
Environment inventories, final compatibility-use timestamp, worker-cycle
completion, and terminal incident evidence.

## Stage 6 — cleanup release

Only after Stage 5 evidence is complete, implement the deletion list in Issue
05 as a separate reviewed change. Remove the incident command only after its
target rows are terminal. Run all four gates, both image qualifications, and
the full acceptance suite again.

After cleanup, old writers are not a rollback option. Failures are fixed
forward while preserving canonical interactions, consume-before-provider
atomicity, exact normalization, and effect outcomes.

## Closeout record

```text
Compatibility commit and promotion:
Activation commit and promotion:
Vercel one/docs deployments:
Migration:
Compatibility images and rollout:
Activation images and rollout:
Canary Environment and operations:
Turn-worker Machines before/after:
Decline proof:
Approve Once and asks-again proof:
Remember and automatic-follow-up proof:
New-thread proof:
Isolation/restart/expiry/outcome proofs:
Drain start and final report:
Incident terminal evidence:
Cleanup commit and promotion:
Rollback identities:
Failures and disposition:
```
