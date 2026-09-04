# Kestrel One Browser-worker rollout

The Browser worker is an immutable image template for dedicated, ephemeral
Browser Session Machines. It is not a long-lived worker fleet. Kestrel One's
control plane creates one no-volume Machine per active session in the owning
Environment's Fly app, pins that Machine to the configured image digest, and
destroys it when the session becomes terminal.

Use the repository-wide [production delivery runbook](../../../docs/production-delivery-channels.md)
for the protected `main` to `production` promotion and common provider gates.
This file owns Browser-worker publication, session-scoped proof, rollback, and
cleanup. Never use `production:fly:machine` for this role.

## 1. Set the release boundary

Before publishing anything:

1. Confirm the exact changes on `main` that the protected `main` to
   `production` pull request will promote.
2. Work from a clean checkout containing the intended production code and run
   `pnpm validate`, `pnpm validate:process`, `pnpm validate:postgres`, and
   `pnpm validate:chromium`.
3. Stage both pinned Linux runtime assets with
   `pnpm run browser:runtime:stage:hosted`. Record their URLs and SHA-256 values
   from `src/browser/runtimeReleaseManifest.ts`; do not retain downloaded
   binaries as release evidence or commit them.
4. Build the image locally from
   `deploy/fly/kestrel-one-browser-worker/Dockerfile` for `linux/amd64` and run
   `deploy/fly/kestrel-one-browser-worker/smoke.sh` against that exact local
   image. The image smoke must prove the pinned engine and Chrome revisions,
   wait for the actual worker listener for up to the 60-second cold-start
   ceiling, print container logs if readiness fails, and prove nonroot/read-only
   operation, exact control operations, and clean close. The
   smoke runs the worker on an otherwise routed network and must also prove
   that its namespace firewall denies steady-state DNS, direct public and
   private traffic, and another port on the exact Gateway Machine while
   authenticated Browser navigation succeeds through the pinned Gateway
   address and dedicated TCP port 43109. The same smoke must prove that only
   that exact Gateway peer can initiate worker control on port 43105 and that
   an unauthorized private peer cannot reach either control or a listener
   opened on another port by the unprivileged worker.
5. Choose a new readable tag. Record the operator, start time, production
   revision, prior `KESTREL_BROWSER_WORKER_IMAGE` digest, candidate tag, and
   intended canary organization, Environment, Project, Thread, and target. Do
   not record page contents, URL queries, form values, credentials, or
   screenshots in operational evidence.

Stop if the local build or image smoke fails, the candidate cannot start
without fetching runtime assets, or the prior immutable digest is unknown.

## 2. Satisfy Web and migration dependencies

Browser Session schema, lifecycle, worker capability, egress, artifact, or
configuration changes must reach Kestrel One through the protected `main` to
`production` promotion before the new image is selected. Wait for the native
Kestrel One migration and build to pass. Verify production health without
opening a Browser Session.

Keep the prior image digest configured until publication succeeds. A mutable
tag is never valid for `KESTREL_BROWSER_WORKER_IMAGE`.

## 3. Publish and capture the immutable digest

Publish only this role:

```bash
pnpm production:image:publish \
  --role browser-worker \
  --tag <tag>
```

The command stages and verifies the exact pinned runtime assets, builds
`linux/amd64`, runs the image smoke, pushes the tag, and prints the exact
`registry.fly.io/kestrel-one-browser-worker@sha256:<digest>` repository
identity. Retain that JSON output. A successful smoke without the repository
digest is incomplete publication evidence.

Do not use `production:fly:machine`. Browser Machines do not exist until the
control plane opens a session, and every session Machine must already use the
selected immutable digest at creation.

## 4. Select the digest and run one session canary

Install the published repository digest as `KESTREL_BROWSER_WORKER_IMAGE`
through the reviewed Kestrel One production configuration path, retain the
prior digest for rollback, and complete the resulting Kestrel One deployment.
Do not set the variable to the publication tag or a bare image ID.

The control-worker reconciler must use the same immutable
`KESTREL_BROWSER_WORKER_IMAGE` value as Kestrel One. Verify the running process
configuration, not just staged secrets, and preserve active/standby states
when updating individual Machines. Browser qualification must run with
reconciliation active during Machine creation and startup; an isolated worker
smoke without its lifecycle owner does not prove this race is safe.

Use one designated, bounded Thread to open a Browser Session against either an
active owned Kestrel Edge preview or an already-approved public HTTPS/443
origin. The canary must:

1. create exactly one Browser Session and one labeled, no-volume Fly Machine;
2. record the candidate repository digest in `browser_session_resources` and
   observe the same resolved image identity from Fly;
3. become ready within 60 seconds and only after the worker self-measures
   agent-browser `v0.35.0-kestrel.1` and Chrome for Testing `152.0.7977.54`;
4. prove the worker booted its default-drop input and output nftables ceiling
   on Fly, resolved and pinned the exact current Gateway Machine as both its
   control peer and egress peer, dropped to uid/gid 10001 with no effective
   capabilities, and cannot reach DNS, a direct public destination, an
   unauthorized Environment Machine, or another port on the Gateway; also
   prove an unauthorized private peer cannot connect to worker control or a
   second listener opened by the unprivileged worker;
5. complete open, navigation or inspection, one Thread-authorized screenshot,
   and close through the ordinary Browser App path;
6. preserve the exact session ID and generation through capability and worker
   evidence without exposing the worker address or credential; and
7. reach a terminal session state, confirm the labeled Machine is absent even
   when Fly removed it before cleanup began, record `cleanupConfirmedAt`, and
   confirm cleanup of profile, proxy authority, and capabilities.

Record this unified release-evidence canary as `browser-worker-session` with
status `passed`, its completion time, the immutable digest, Browser Session ID,
generation, sanitized target origin, terminal state, cleanup confirmation, and
metadata-only cost evidence. Generic Kestrel One health, the local image smoke,
or another role's canary is not Browser-worker session proof.

Stop on startup failure, image mismatch, unmeasured runtime versions, unknown
operation outcome, direct-egress evidence, unexpected approval, artifact
failure, terminal cleanup pending, or any residual labeled Machine. Do not
retry an uncertain effect or open more sessions to make the rollout appear
healthy.

## Rollback

Restore the previously recorded immutable repository digest as
`KESTREL_BROWSER_WORKER_IMAGE` through the same reviewed Kestrel One
configuration path and complete that deployment. This changes only subsequent
Browser Session Machine creation; it does not mutate a running session
Machine.

Close the canary session through the ordinary Browser App path. If it cannot
close normally, persist terminal intent and use the existing reconciliation
path until the exact session-labeled Machine is confirmed absent. Do not use
the fixed-Machine updater, retag an image, reconnect a lost session, or reuse a
profile. Record the restored digest, deployment result, session terminal state,
and cleanup confirmation.

After rollback, open one bounded session only if needed to prove new Machines
use the restored digest. Delete the rejected tag later only through the normal
registry-retention process; never delete an image digest still referenced by a
Browser Session record or release evidence.
