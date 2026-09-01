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
It first establishes a Web bridge against the actual uniform, unmarked
`workspace_hosted` preset-2 production fleet from baseline `1760c3769`. It
then builds and rolls marked preset-4 compatibility images that still emit V2,
proves the inactive V2 boundary, and only afterward builds and activates V4
producers on exact targets. Finally it observes legacy drain before permitting
a separate cleanup release.

This runbook does not authorize a deployment. The operator must have an
approved production change window and must retain every checkpoint named
below. Never paste cookies, database URLs, OAuth tokens, execution tickets, or
provider credentials into the evidence record.

## Release shape

Use one qualified bridge source release and two separately qualified producer
artifact modes. Never collapse their production evidence:

1. **Bridge source commit:** V2/V3/V4 readers and a temporary Web assertion
   with exactly three accepted hosted producer profiles: unmarked
   `workspace_hosted` preset 2 with policy `kestrel` version 4 and the
   `hosted_workspace` pack; preset 4 with that same policy identity, pack, and
   explicit producer marker `v2`; or preset 4 with that identity, pack, and
   marker `v4`. Every accepted result also has the canonical
   `kestrel:workspace_hosted:<fingerprint>` profile identity. Preset 2 with any
   producer marker, unmarked preset 3, `ci_bot`, another pack or policy
   identity, an unknown profile or preset, and an unsupported protocol fail
   closed. This release also contains parameterized producer Dockerfiles,
   migrations, proof tooling, and telemetry. The compatibility images are
   built with `KESTREL_HOSTED_APPROVAL_PROTOCOL=v2` and carry the matching OCI
   label.
2. **Activation artifacts:** images built from that same qualified source with
   `KESTREL_HOSTED_APPROVAL_PROTOCOL=v4` and the matching OCI label. Record
   different immutable tags and registry digests. A protocol build argument is
   the explicit artifact boundary; do not invent an empty source commit or
   mutable retag to distinguish activation.

The V2 default is the inactive boundary. An invalid configured value fails
startup. Existing V2 interactions remain V2; existing V3 interactions remain
V3; new Remember-capable interactions are V4. No version may be reconstructed
or silently converted.

## Target checklist

Complete current provider state before changing anything.

| Target                         | Current production state                    | Required action                                                          | Required proof                                              | Status     |
| ------------------------------ | ------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- | ---------- |
| PostgreSQL                     | Record migration head                       | Apply additive migrations through the native `one` build                 | Migration and build succeeded                               | Pending    |
| Vercel `one`                   | Record deployment ID and commit             | Promote bridge commit before compatibility images                        | Exact deployment, health, approval API                      | Pending    |
| Vercel `docs`                  | Record deployment ID and commit             | Native deployment collateral for the bridge promotion                    | Exact build and production URL                              | Pending    |
| Workspace Runtime              | Inventory every Environment image           | Publish compatibility pair, then V4 pair                                 | Local image E2E, disposable canary, live canary Environment | Pending    |
| Environment Router             | Inventory every Environment image           | Publish with Workspace Runtime under the same tag                        | Pair smoke, operation, Workspace and Preview canaries       | Pending    |
| turn-worker                    | Inventory every started and stopped Machine | Publish compatibility image, then V4 image; update one Machine at a time | Worker check, durable turn, hosted approval proof           | Pending    |
| Mobile API                     | Part of `one`; no separate binary here      | Keep V2/V3/V4 and boolean drain readers during rollout                   | Mobile contract tests and one V4 decision                   | Pending    |
| control-worker                 | Record health only                          | No image change                                                          | Healthy before Environment operations                       | Unaffected |
| preview-edge                   | Record current image                        | No change                                                                | None beyond production health                               | Unaffected |
| runpod-worker / managed RunPod | Record current state                        | No change and no spend                                                   | None                                                        | Unaffected |

Stop if the repository delta proves an “unaffected” target changed.

## Stage 0 — inventory the deployed preset-2 baseline and qualify both artifact modes

Record:

```text
Operator:
Start time:
Bridge source commit:
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
resolved profile for every started producer:
resolved policy identity and policy pack for every started producer:
producer protocol marker or confirmed absence for every started producer:
```

Refresh the protected branches and inspect the complete delta. Require a clean
checkout at the bridge source commit. Run:

```bash
pnpm validate
pnpm validate:postgres
pnpm validate:process
pnpm validate:audit
pnpm --dir apps/web build
```

Before qualification, resolve every started turn-worker and Environment
profile. Stop unless the production fleet is uniformly the exact deployed
baseline: `workspace_hosted` preset 2, policy `kestrel` version 4,
`hosted_workspace`, canonical `kestrel:workspace_hosted:<fingerprint>` profile
identity, and no `hostedApprovalProducerProtocol` field. Preset 2 with any
producer marker or contradictory policy metadata, preset 3, preset 4,
`ci_bot`, another pack, an unknown profile, or a mixed fleet is not the
reviewed starting state. The current pre-bridge Web deployment is a rollback
target only while this exact unmarked preset-2 inventory remains uniform; this
runbook never claims that old Web accepts marked preset 4.

From that exact checkout, build the three affected production images once in
each producer mode. Use a different local tag for each artifact boundary and
pass the producer protocol into the build:

```bash
docker buildx build --platform linux/amd64 --load \
  --file apps/workspace-runtime/Dockerfile \
  --tag local/kestrel-workspace-runtime:<candidate-tag> \
  --build-arg KESTREL_BUILD_ID=<candidate-tag> \
  --build-arg KESTREL_HOSTED_APPROVAL_PROTOCOL=<v2-or-v4> .
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
  --build-arg KESTREL_BUILD_ID=<candidate-tag> \
  --build-arg KESTREL_HOSTED_APPROVAL_PROTOCOL=<v2-or-v4> .
bash deploy/fly/kestrel-one-turn-worker/smoke.sh \
  local/kestrel-one-turn-worker:<candidate-tag> <v2-or-v4>
```

The compatibility images must report V2 in both the runtime environment and
`com.lumicorp.kestrel.hosted-approval-producer` OCI label. The activation
Workspace Runtime and turn-worker images must report V4 in both places. For
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
canary in Stage 2. If the repository cannot route the real-model path through
the prebuilt Runtime pair, stop here and repair that test seam; source tests,
image health, or a later production canary do not replace it.

**Resume evidence:** bridge source commit SHA, four validation results, Web build,
three image IDs and smokes for each artifact mode, and exact local-image
real-model results.

## Stage 1 — deploy the bridge against the unmarked preset-2 baseline

Promote the exact bridge/compatibility commit through the protected `main` to
`production` path while every producer remains on the Stage 0 unmarked
preset-2 inventory. Wait for native `one` and `docs` deployments, then require
the `one` migration/build and both production deployments to pass.

1. Confirm Web and Mobile read V2, V3, and V4 while old boolean submissions
   remain accepted.
2. Resolve the profile from every inventoried producer. The bridge must accept
   the exact unmarked `workspace_hosted` preset-2, `kestrel` version-4,
   `hosted_workspace` baseline.
3. Use a non-executing contract probe to prove preset 2 with `v2`, `v3`, or
   `v4` producer metadata; preset 3; `ci_bot`; another policy pack or policy
   identity; an unknown profile; unmarked preset 4; and unsupported protocols
   all fail closed before model spend.
4. Repeat the exact-tool no-spend preflight on one preset-2 canary Environment.
   Require `exec_command` Ask First without creating a turn or model request.
5. Complete one bounded baseline V2 decline and require a terminal decision
   with no provider effect.

Do not publish or roll a preset-4 image until all bridge evidence is retained.

**Rollback:** restore the recorded Web deployment. This is safe only because
the producer fleet is still uniformly the exact unmarked preset-2 baseline.
Never roll back to pre-bridge Web after any preset-4 producer is active.

**Resume evidence:** promotion PR and commit; both Vercel deployment IDs;
migration/build results; complete preset-2 inventory; exact bridge allowlist
proof; fail-closed probes; no-spend preflight; V2 decline; and rollback ID.

## Stage 2 — build, prove, and roll preset-4/V2 compatibility images

Stage 1 must establish the bridge Web while the fleet is still uniformly the
unmarked preset-2 baseline. Use the exact bridge source checkout qualified in
Stage 0 and publish new immutable tags only:

```bash
pnpm production:image:publish --role workspace-runtime --tag <compatibility-tag> --approval-protocol v2
pnpm production:image:publish --role environment-router --tag <compatibility-tag>
pnpm production:image:publish --role turn-worker --tag <compatibility-tag> --approval-protocol v2
```

For both producers, `--approval-protocol v2` is a Docker build input, smoke
expectation, and verified OCI-label value. Retain the publisher JSON containing
the exact protocol, tag, and registry digest. Stop before rollout if any field
is missing, any digest is mutable or unresolved, or the image reports a
different protocol.

Follow the
[runtime-pair rollout](../../deploy/fly/kestrel-one-runner/ROLLOUT.md) and
[turn-worker rollout](../../deploy/fly/kestrel-one-turn-worker/ROLLOUT.md)
exactly. First run the disposable worker and runtime-pair canaries against the
published digests. Then:

1. Update one started turn-worker Machine to the exact compatibility digest.
2. Require the `worker` check and one durable ordinary turn.
3. Update remaining started Machines individually while preserving capacity.
   Do not run a hosted canary against a mixed started fleet because the queue
   cannot target one worker.
4. Update one exact canary Environment to the compatibility Router/Workspace
   pair and wait for `environment.update.ready`.
5. Run exact-tool no-spend preflight, then one bounded hosted V2 decline.
   Require preset 4, explicit producer protocol V2, a V2 interaction, no tool
   execution, and no remembered record.
6. Update every stopped turn-worker Machine individually without starting it.
7. Run the live Workspace and Preview canaries, activate the accepted pair,
   and update each approved noncanary Environment with a separate durable
   operation.
8. Re-inventory all Machines and Environments. Every producer must resolve to
   the recorded compatibility digest and preset-4/V2 profile.

Do not roll back Web to its pre-bridge deployment. An old Web cannot accept
preset 4. Do not start the drain clock; V2 production is still expected.

**Rollback:** restore each exact turn-worker Machine to its recorded image.
Restore the complete Router/Workspace pair on the canary Environment, prove
both canaries, reactivate the previous pair, then update other Environments
individually.

**Resume evidence:** published immutable images, every Machine before/after
record, durable turn, canary operation, Workspace/Preview results, activation
record, per-Environment operations, and final preset-4/V2 inventories.

## Stage 3 — prove the inactive V2 checkpoint

Only after Stage 2 establishes a uniform preset-4/V2 fleet, repeat production
health and confirm the already-deployed Web and Mobile readers still accept
V2, V3, V4, and old boolean submissions. Confirm the bridge assertion accepts
every inventoried preset-4 producer only with its explicit V2 marker. Repeat
the exact-tool no-spend preflight and confirm every new hosted interaction
still emits V2.

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

**Rollback:** keep the bridge Web deployed and restore each exact producer to
its recorded compatibility digest if the checkpoint changes producer state.
Never restore pre-bridge Web while preset-4 images exist, and never reverse
additive migrations.

**Resume evidence:** production health; complete preset-4/V2 digest inventory;
no-spend preflight; legacy canary JSON; canonical V2 proof JSON; and
metadata-less V3 resume proof.

## Stage 4 — activate V4 on controlled targets

Keep the qualified bridge Web deployed. From the exact bridge source checkout
qualified in Stage 0, publish one immutable activation image set:

```bash
pnpm production:image:publish --role workspace-runtime --tag <activation-tag> --approval-protocol v4
pnpm production:image:publish --role environment-router --tag <activation-tag>
pnpm production:image:publish --role turn-worker --tag <activation-tag> --approval-protocol v4
```

For both producers, `--approval-protocol v4` is a Docker build input, smoke
expectation, and verified OCI-label value. Retain the publisher JSON containing
the exact protocol, new immutable tag, and registry digest. Never retag or
convert a compatibility image.

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

**Resume evidence:** activation promotion, exact images, target-by-target rollout,
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
target rows are terminal. This is also the earliest release that may remove
the temporary unmarked preset-2 Web allowance and restore a strict marked
preset-4 assertion. Remove it only after the Stage 6 report and complete
Machine and Environment inventory prove that no preset-2 producer remains or
can re-enter service. Run all four gates, both image qualifications, and the
full acceptance suite again.

After cleanup, old writers are not a rollback option. Failures are fixed
forward while preserving canonical interactions, consume-before-provider
atomicity, exact normalization, and effect outcomes.

## Closeout record

```text
Bridge source commit and promotion:
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
