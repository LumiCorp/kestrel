---
id: hosted-approval-v4-rollout
domain: operations
status: active
owner: kestrel-one
last_verified_at: 2026-09-02
depends_on:
  - ../production-delivery-channels.md
  - ../../deploy/fly/kestrel-one-runner/ROLLOUT.md
  - ../../deploy/fly/kestrel-one-turn-worker/ROLLOUT.md
---

# Hosted approval V4 steady-state production runbook

This is the production procedure for the final hosted execution contract:
`workspace_hosted@4`, producer protocol `v4`, policy `kestrel@5`, approval
pack `hosted_workspace`, and canonical profile IDs of the form
`kestrel:workspace_hosted:<fingerprint>`.

This runbook does not authorize a deployment. Use it only in an approved
production change window. It intentionally contains no compatibility-image
stage, intermediate runtime pair, stable Desktop release, or platform-passkey
canary. V2 and V3 interaction readers remain supported, but old producers are
not deployable under this procedure.

Never paste cookies, database URLs, OAuth tokens, execution tickets, or
provider credentials into the evidence record.

## Invariants

- Promote one exact source tree through protected `main` and `production`.
- Deploy Web before changing any producer. Old Web cannot consume final V4
  producer output.
- Publish only final V4 images. An image used in production must have an
  immutable repository digest and must pass its publisher smoke check.
- Keep all turn-worker Machines stopped while producer images or Environment
  runtime pairs are mixed.
- Change Machines and Environments individually. Preserve the original state
  of each Machine and every stopped Workspace.
- Fail closed on any inventory disagreement, contract mismatch, migration
  failure, provider operation failure, image mismatch, or canary failure.
- Do not reopen queued work until every active producer reports the final
  contract and final image.

## Stage 0 — inventory and qualify

Record the complete rollback inventory before changing state:

```text
Operator and change window:
origin/main commit and tree:
origin/production commit and tree:
promotion range and changed files:
current one deployment ID, URL, commit, and state:
current docs deployment ID, URL, commit, and state:
migrations 0083 through 0099:
control-worker Machine IDs, states, checks, and image digests:
turn-worker Machine IDs, states, checks, and image digests:
previously active control-worker Machine:
previously active turn-worker Machine:
every production Environment and current Router/Workspace pair:
every Workspace and current state:
runtime-channel current and previous pairs:
current Browser-worker repository digest:
canary Environment:
rollback digest for every changed target:
```

Refresh both protected branches and require the intended source checkout to be
clean. Preserve unrelated local work. Before promotion, run the repository
qualification required by the changed boundaries, including:

```bash
pnpm install --frozen-lockfile
pnpm validate
pnpm validate:process
pnpm validate:postgres
pnpm validate:chromium
```

The packaged-runtime release gate must generate a real `workspace_hosted`
profile through the packaged runner and pass that result to the same shared
validator used by Web. It must prove the complete final tuple and independently
mutate preset ID/version, producer protocol, policy ID/version, approval pack,
and both profile IDs. Every unsupported mutation must fail before `run.start`
or model spend.

Stop if the inventory is incomplete or any currently active producer cannot
be mapped to an exact image digest and resolved profile.

## Stage 1 — protected promotion and Web-first deployment

Merge the qualified change into `main`, then promote only that `main` state to
`production` through the protected promotion pull request. After both merges:

1. Fetch the protected refs again.
2. Require the `origin/main` and `origin/production` tree hashes to match
   exactly.
3. Deploy `one` through native Vercel and wait for the production alias.
4. Deploy `docs` through native Vercel and wait for the production alias.
5. Verify migrations 0083 through 0099, production health, and V2/V3/V4
   interaction-reader compatibility.
6. Run a no-spend production profile-resolution probe. Require the exact final
   hosted contract and exact-tool decisions before changing a producer.

Do not roll Web back by itself after a final V4 producer is active. If the new
Web fails, remain in maintenance and fix Web forward.

## Stage 2 — settle and stop producers

Let active turns reach terminal state. Leave newly submitted work queued.
Stop the previously active turn-worker and confirm every turn-worker Machine is
stopped before publishing or replacing producer images.

Record a fresh Machine and Environment inventory. If it differs from Stage 0
without an explained, exact operation, stop.

## Stage 3 — publish final images

Publish only the final images required by the source delta:

```bash
pnpm production:image:publish --role workspace-runtime --tag <release-tag> --approval-protocol v4
pnpm production:image:publish --role environment-router --tag <release-tag>
pnpm production:image:publish --role turn-worker --tag <release-tag> --approval-protocol v4
pnpm production:image:publish --role control-worker --tag <release-tag>
pnpm production:image:publish --role browser-worker --tag <release-tag>
```

Omit unaffected roles only when the source delta and qualification evidence
prove they are unaffected. Record the immutable repository digest printed by
every publisher. Workspace Runtime and turn-worker images must report producer
protocol V4 in their runtime environment and OCI label. Never publish a V2 producer image,
reuse an intermediate tag, or convert an existing image by
retagging it.

Run the disposable worker and runtime-pair canaries required by the linked
rollout documents before changing production targets.

## Stage 4 — update control and turn Machines

Update control-worker Machines one at a time to the final digest. Preserve each
Machine's original state. When both images are exact, return the previously
active control-worker to service and require its health check before issuing
Environment operations.

Keep every turn-worker stopped. Replace the previously active Machine and each
stopped standby individually with the final turn-worker digest. Start none of
them. Re-inventory all turn-worker Machines and require the exact final image
and stopped state.

## Stage 5 — update Environments and activate the runtime pair

For each active production Environment, submit one durable update operation
with the exact final Router and Workspace image digests. Wait for an
`environment.update.ready` event before moving to the next Environment.

For every completed operation:

- verify the operation's Environment identity;
- verify its exact Router and Workspace image digests from both the control
  plane and provider;
- verify the Router and ready Workspace health checks;
- preserve every Workspace that was stopped before the update as stopped.

After the live Workspace and Preview canaries pass on the canary Environment,
activate the final pair in the runtime channel. Record the new generation,
version ID, release tag, canary operation, and previous pair for rollback.

Keep maintenance closed until every Environment is exact. Never run a hosted
approval canary while the fleet is mixed.

## Stage 6 — configure the Browser worker

Set `KESTREL_BROWSER_WORKER_IMAGE` in production to the immutable repository
digest printed by the Browser-worker publisher. Retain the prior digest for
rollback. Wait for the resulting native `one` deployment and production alias,
then repeat health, migration, and reader verification.

## Stage 7 — start the single active turn worker

Run the live release gate: resolve the exact final profile in production and
complete one ordinary durable turn. Then start only the previously active
turn-worker. Leave every standby stopped.

Re-inventory every active producer. No active Machine or Environment may
report an old digest, old preset, protocol other than V4, policy other than
`kestrel@5`, another approval pack, or a noncanonical profile ID.

## Stage 8 — production acceptance

Run the complete suite against production:

1. one ordinary durable turn;
2. Workspace canary, including file mutation, conflict behavior, terminal,
   application proxy, and cleanup;
3. Preview canary, including document load and WebSocket upgrade;
4. hosted approval decline;
5. hosted approval approve-once;
6. hosted approval remember;
7. remembered automatic reuse without a new approval card;
8. Browser canary with one remembered domain grant, viewer and takeover,
   sentinel password and OTP redaction, approved upload,
   quarantined-download promotion, network isolation, close, and complete
   Machine/profile/capability/proxy cleanup.

Any failed assertion closes the gate. Stop the active turn-worker, leave work
queued, preserve evidence, and fix forward.

## Stage 9 — reopen and retain evidence

Reopen normal operation only after all acceptance canaries pass and the final
inventory proves a uniform V4 fleet. Retain:

- promotion pull requests, commits, and equal tree hashes;
- `one` and `docs` deployment IDs and URLs;
- migration, health, reader, and no-spend gate results;
- publisher output and immutable image digests;
- every Machine before/after record and preserved state;
- every Environment operation and `environment.update.ready` event;
- runtime-channel activation and rollback pair;
- Browser-worker current and prior digests;
- complete acceptance results and cleanup evidence.

## Rollback

Rollback is an exact-target maintenance operation, not permission to restore an
incompatible Web/producer combination.

1. Stop all turn workers.
2. Restore each affected Machine individually to its recorded image and state.
3. Restore the complete previous Router/Workspace pair on the canary
   Environment and prove Workspace and Preview before activating it.
4. Reactivate the previous runtime-channel pair, then restore other
   Environments individually and wait for each ready event.
5. Restore the prior Browser-worker digest and wait for `one`.
6. Start only the previously active turn-worker after the inventory is uniform
   and the live release gate passes.

Do not roll back migrations. Do not roll Web back to a version that rejects
the producer fleet. When no recorded compatible combination exists, keep
maintenance closed and repair forward.
