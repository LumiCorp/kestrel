---
id: hosted-approval-v4-rollout
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

# Hosted approval V4 guided rollout

This is the operator procedure for
[Issue 05](../planning/hosted-approval-simplification/issues/05-contract-legacy-approval-paths.md).
It qualifies preset-4 compatibility images that still emit V2, proves them
against the existing Web deployment, and rolls them out before Web starts
requiring preset 4. It then deploys V2/V3/V4 readers, proves the inactive V2
boundary, activates V4 producers on exact targets, observes legacy drain, and
only then permits a separate cleanup release.

This runbook does not authorize a deployment. The operator must have an
approved production change window and must retain every checkpoint named
below. Never paste cookies, database URLs, OAuth tokens, execution tickets, or
provider credentials into the evidence record.

## Release shape

Use two qualified commits and never collapse them into one production
promotion:

1. **Compatibility commit:** preset-4 Runtime and worker profiles that still
   emit V2, migrations, V2/V3/V4 readers, strict V4 decisions, proof tooling,
   and the telemetry report.
2. **Activation commit:** the same qualified tree plus
   `KESTREL_HOSTED_APPROVAL_PROTOCOL=v4` in the Workspace Runtime and
   turn-worker images.

The V2 default is the inactive boundary. An invalid configured value fails
startup. Existing V2 interactions remain V2; existing V3 interactions remain
V3; new Remember-capable interactions are V4. No version may be reconstructed
or silently converted.

## Target checklist

Complete current provider state before changing anything.

| Target                         | Current production state                    | Required action                                                          | Required proof                                              | Status     |
| ------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- | ---------- |
| PostgreSQL                     | Record migration head                       | Apply additive migrations through the native `one` build                 | Migration and build succeeded                               | Pending    |
| Vercel `one`                   | Record deployment ID and commit             | Promote compatibility commit only after compatible images are live, then promote activation commit | Exact deployment, health, approval API                      | Pending    |
| Vercel `docs`                  | Record deployment ID and commit             | Native deployment collateral for both promotions                         | Exact build and production URL                              | Pending    |
| Workspace Runtime              | Inventory every Environment image           | Publish compatibility pair, then V4 pair                                 | Local image E2E, disposable canary, live canary Environment | Pending    |
| Environment Router             | Inventory every Environment image           | Publish with Workspace Runtime under the same tag                        | Pair smoke, operation, Workspace and Preview canaries       | Pending    |
| turn-worker                    | Inventory every started and stopped Machine | Publish compatibility image, then V4 image; update one Machine at a time | Worker check, durable turn, hosted approval proof           | Pending    |
| Mobile API                     | Part of `one`; no separate binary here      | Keep V2/V3/V4 and boolean drain readers during rollout                   | Mobile contract tests and one V4 decision                   | Pending    |
| control-worker                 | Record health only                          | No image change                                                          | Healthy before Environment operations                       | Unaffected |
| preview-edge                   | Record current image                        | No change                                                                | None beyond production health                               | Unaffected |
| runpod-worker / managed RunPod | Record current state                        | No change and no spend                                                   | None                                                        | Unaffected |

Stop if the repository delta proves an “unaffected” target changed.

## Stage 0 — qualify both commits and image modes locally

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
current one/docs deployment IDs:
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

Check out each exact candidate commit before building its images. Never build
the compatibility tag from the activation checkout. Build the three affected
production images at each candidate commit, and use a different local tag for
each commit:

```bash
docker buildx build --platform linux/amd64 --load \
  --file apps/workspace-runtime/Dockerfile \
  --tag local/kestrel-workspace-runtime:<candidate-tag> \
  --build-arg KESTREL_BUILD_ID=<candidate-tag> .
bash apps/workspace-runtime/scripts/image-smoke.sh \
  local/kestrel-workspace-runtime:<candidate-tag> <v2-or-v4>

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
  local/kestrel-one-turn-worker:<candidate-tag> <v2-or-v4>
```

The compatibility images must report V2 as their hosted approval producer.
The activation Workspace Runtime and turn-worker images must report V4. For
each candidate, run a real approved model through the exact prebuilt Runtime
pair and retain the participating image IDs:

```bash
pnpm --dir apps/workspace-runtime canary:images:local -- \
  --workspace-image local/kestrel-workspace-runtime:<candidate-tag> \
  --router-image local/kestrel-environment-router:<candidate-tag>
```

The result must report `imageSource: "prebuilt"` and the same image IDs recorded
by `docker image inspect`. Retain the resolved `workspace_hosted` preset version
4 and `hosted_workspace` policy-pack evidence for the compatibility image. The
turn-worker does not participate in this local Runtime-pair path and remains
gated by its extraction/startup smoke above and the production durable-turn
canary in Stage 1. If the repository cannot route the real-model path through
the prebuilt Runtime pair, stop here and repair that test seam; source tests,
image health, or a later production canary do not replace it.

**Resume evidence:** both commit SHAs, four validation results, Web build,
three image IDs and smokes for each commit, and exact local-image real-model
results.

## Stage 1 — prove compatibility images against old Web

Keep the existing production Web and Mobile deployment unchanged throughout
this stage. Use the exact compatibility checkout qualified in Stage 0. Publish
only the preset-4 images that still emit V2:

```bash
pnpm production:image:publish --role workspace-runtime --tag <compatibility-tag> --approval-protocol v2
pnpm production:image:publish --role environment-router --tag <compatibility-tag>
pnpm production:image:publish --role turn-worker --tag <compatibility-tag> --approval-protocol v2
```

`--approval-protocol v2` is a smoke expectation, not an image override. Stop if
either producer image was built with V4 or fails the V2 smoke.

Follow the
[runtime-pair rollout](../../deploy/fly/kestrel-one-runner/ROLLOUT.md) and
[turn-worker rollout](../../deploy/fly/kestrel-one-turn-worker/ROLLOUT.md)
exactly. The hosted approval ordering in this runbook takes precedence over
their ordinary Web-first dependency rule.

First prove the worker image without changing a queue consumer. Run its
disposable attachment canary, and retain the immutable image identity. Then:

1. Update one started turn-worker Machine.
2. Require the `worker` check and one durable ordinary turn.
3. Update the remaining started Machines individually while preserving
   capacity. Do not run a hosted canary against a mixed started fleet because
   the queue cannot target one worker.
4. Run the disposable runtime-pair canary.
5. Update one exact canary Environment and wait for
   `environment.update.ready`.
6. Before submitting a model turn, call the canary Environment's
   `workspace/canary/exact-tool-preflight` endpoint through authenticated
   operator tooling. Require `exec_command` to be available with an exact Ask
   First decision. This request must not create a turn or spend model tokens.
7. With old Web still serving production, create one bounded hosted V2 request
   on the canary Environment and decline it. Confirm the persisted interaction
   version is `runner_hosted_tool_approval_interaction_v2`, the decision is
   terminal, and no provider effect executed.

Stop if old Web rejects preset 4, cannot render or persist the V2 decision, or
spends model tokens before the exact-tool preflight succeeds. Do not promote
new Web as a workaround. Restore the exact previous images first, then repair
the compatibility boundary in a new qualified commit. If old Web rejects the
preflight, retain proof that it created no turn and made no model request
before rollback.

Do not activate the runtime pair or update another Environment yet. Do not
start the drain clock. V2 production is still expected.

**Rollback:** restore each changed turn-worker Machine to its recorded image.
Restore the complete Router/Workspace pair on the canary Environment and prove
the old Web path again. Never repair only one image in the pair.

**Resume evidence:** published immutable compatibility images; every started
worker before/after record; disposable canaries; durable ordinary turn; exact
canary Environment operation; no-spend preflight response; V2 request,
decline, and no-effect evidence; and rollback identities.

## Stage 2 — complete the preset-4 V2 image rollout

Stage 1 must prove that old Web accepts the preset-4, V2-producing
compatibility images. Keep old Web deployed while completing this stage.

1. Update every stopped turn-worker Machine individually without starting it.
2. Re-inventory every started and stopped Machine. Each must resolve to the
   compatibility image.
3. Run the live Workspace and Preview canaries on the accepted canary
   Environment.
4. Activate the exact accepted compatibility Router/Workspace pair.
5. Update every approved noncanary Environment through a separate durable
   operation.
6. For each Environment, require `environment.update.ready`, exact paired image
   identities, and the smallest affected Workspace proof.
7. Re-inventory every Environment. Each must use the compatibility pair and
   resolve `workspace_hosted` preset 4 while still producing V2.

Do not promote new Web until the complete Machine and Environment inventories
are uniform. An unqualified preset-2 or preset-3 producer would be rejected as
soon as the new Web assertion becomes active.

Do not start the drain clock. V2 production is still expected.

**Rollback:** restore each exact turn-worker Machine to its recorded image.
Restore the complete Router/Workspace pair on the canary Environment, prove
both canaries, reactivate the previous pair, then update other Environments
individually.

**Resume evidence:** published immutable images, every Machine before/after
record, durable turn, canary operation, Workspace/Preview results, activation
record, per-Environment operations, and final preset-4/V2 inventories.

## Stage 3 — deploy compatible readers and prove inactive V2

Only after Stage 2 establishes a uniform preset-4/V2 fleet, promote the
compatibility commit through the protected `main` to `production` process.

1. Wait for native `one` and `docs` deployments.
2. Require the `one` migration/build and both production deployments to pass.
3. Confirm Web and Mobile read V2, V3, and V4 while old boolean submissions
   remain accepted.
4. Confirm Web's preset-4 assertion accepts every inventoried production
   Runtime and worker profile.
5. Repeat the exact-tool no-spend preflight before submitting a model turn.
6. Confirm every new hosted interaction still emits V2.

Set the named canary variables in the existing operator environment. Run the
boolean-reader denial canary with
`KESTREL_ONE_CANARY_APPROVAL_PROTOCOL=legacy_v1`:

```bash
pnpm --dir apps/web canary:github:approval
```

The command must report `legacy_v1`, a persisted decline, and
`effectState=not_started`.

Then run one canonical V2 checkpoint on an exact canary thread:

1. Create one new hosted approval and record its turn and interaction IDs.
2. Read the stored request envelope and require
   `runner_hosted_tool_approval_interaction_v2`.
3. Decline through the visible Web card.
4. Reload the thread and confirm the same interaction remains terminal.
5. Run the exact proof command:

   ```bash
   pnpm --dir apps/web hosted-approval:proof -- \
     --thread <thread-id> \
     --interaction <interaction-id>
   ```

6. Require no tool execution, no remembered approval, and one terminal
   decision.

Also resume one already-persisted metadata-less V3 interaction through Approve
Once or Decline. Do not renegotiate its recorded profile or convert it to V4.

**Rollback:** restore Web to the recorded old deployment. Keep the compatible
preset-4/V2 images in place because Stage 1 proved that exact rollback pair.
Never reverse additive migrations.

**Resume evidence:** promotion PR and commit; both Vercel deployment IDs;
migration result; production health; preset inventory; no-spend preflight;
legacy canary JSON; canonical V2 proof JSON; and metadata-less V3 resume proof.

## Stage 4 — activate V4 on controlled targets

Promote the activation commit through the protected `main` to `production`
path and wait for the `one` and `docs` deployments. From the exact activation
checkout qualified in Stage 0, publish one immutable activation image set:

```bash
pnpm production:image:publish --role workspace-runtime --tag <activation-tag> --approval-protocol v4
pnpm production:image:publish --role environment-router --tag <activation-tag>
pnpm production:image:publish --role turn-worker --tag <activation-tag> --approval-protocol v4
```

`--approval-protocol v4` is also a smoke expectation. It must verify the exact
activation checkout rather than convert a compatibility image.

Before emitting V4 from a Workspace Runtime, qualify the activation runtime
pair with its disposable canary. Roll the activation image to every started
turn-worker Machine, one Machine at a time while preserving capacity. Require
the exact `worker` check after each update and inventory every eligible queue
consumer before continuing. The turn queue has no per-Machine routing, so a
hosted canary while any started worker still runs the compatibility image
cannot prove which image consumed it.

After every started queue consumer is on the activation image, update only one
controlled canary Environment to the activation runtime pair and wait for
`environment.update.ready`. Preserve stopped workers and every other
Environment on compatibility images. Use exact-target provider changes; do not
activate an app-wide Fly secret to perform this canary.

Run the V4 Chromium canary with
`KESTREL_ONE_CANARY_APPROVAL_PROTOCOL=durable_v4`,
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

**Stop condition:** any started turn-worker not provably running the activation
image; any identity mismatch, duplicate consumption, approved
state without committed effect, decline with an effect, remembered call that
shows a card, or new thread that skips the card.

**Rollback:** restore the canary Environment to the exact compatibility pair
and prove Workspace and Preview again. Restore each changed started
turn-worker Machine to the compatibility image, one Machine at a time while
preserving capacity. If the activation Web deployment is implicated, restore
the compatibility deployment. Keep additive migrations and recorded V2, V3,
and V4 interactions intact.

**Resume evidence:** browser video or trace, canary JSON, proof JSON, GitHub
effect URL, negative acceptance results, restart proof, credential-rotation
proof, the complete started-worker image inventory, and exact canary
Environment images.

## Stage 5 — activate V4 broadly

Use the exact activation images accepted in Stage 4. Do not rebuild or assign
a second tag between canary acceptance and general rollout.

Update stopped turn-worker Machines individually without starting them. Re-run
one durable ordinary turn and the hosted acceptance against the now-uniform
started fleet. Run the live Workspace and Preview canaries on the accepted
canary Environment, activate the exact accepted runtime pair, then update every
approved noncanary Environment through a separate operation. Do not rebuild
images or repeat a mixed-fleet canary.

Existing V2 interactions finish as V2 or expire. Existing V3 interactions
finish as V3. Existing V4 interactions finish as V4. Never downgrade any of
them into reconstruction.

**Rollback:** restore compatible V2 images on exact targets while retaining
compatible readers. Do not roll back migrations. Do not turn an already-created
V3 or V4 interaction into another version.

**Resume evidence:** second promotion, exact images, target-by-target rollout,
full hosted acceptance, runtime activation, and rollback identities.

## Stage 6 — observe legacy drain

Record the time when every approved producer is V4 and every compatible reader
is deployed. Run:

```bash
pnpm --dir apps/web hosted-approval:drain-report -- \
  --since <drain-start-ISO-timestamp>
```

Repeat it throughout the observation window. Any compatibility decision, late
terminal activity from an old interaction, or legacy provider consumption
resets the drain start. A future `--since` boundary is invalid.
`databaseDrainReady=true` is necessary but never authorizes cleanup; the
report deliberately always returns `cleanupAuthorized=false`.

Retain zero old decisions, late old-interaction terminal events, and pending
interactions; zero actionable or newly consumed `legacy_v1` provider
approvals; closed old authority expiries; terminal incident targets; every
started and stopped turn-worker image; every tenant runtime pair; and one
complete worker rollout cycle after the last compatibility use.

The current provider approval cap is five minutes, but the actual retained row
expiry and complete image inventories are authoritative. Do not substitute a
five-minute timer for those facts.

**Resume evidence:** timestamped report series, complete Machine and
Environment inventories, final compatibility-use timestamp, worker-cycle
completion, and terminal incident evidence.

## Stage 7 — cleanup release

Only after Stage 6 evidence is complete, implement the deletion list in Issue
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
