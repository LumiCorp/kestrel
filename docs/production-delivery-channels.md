---
id: production-delivery-channels
domain: operations
status: active
owner: kestrel-one
last_verified_at: 2026-08-16
depends_on:
  - ../apps/web/vercel.json
  - ../deploy/fly/image-catalog.json
  - ../scripts/publish-production-image.ts
  - ../scripts/deploy-production-fly-machine.ts
  - ../apps/web/scripts/update-environment-runtime.ts
  - ../apps/web/scripts/activate-production-runtime.ts
---

# Production release runbook

This is the canonical procedure for releasing Kestrel One. The operator owns
the release. There is no coordinated release object and no requirement to
derive image identity from Git.

- Advancing the protected `production` branch lets Vercel natively deploy
  `one` and `docs`. The `one` build performs the ordinary production migration.
- Every image is published manually with a tag chosen by the operator.
- Every Fly Machine is changed manually, one exact Machine at a time.
- Managed RunPod worker and profile changes are separate manual operations.
- Every tenant Environment is changed manually. No command widens the rollout.

## Before starting

Work from the repository root. Decide which of these targets are actually in
scope:

| Target | Delivery path |
| --- | --- |
| `one` | Vercel native deployment from `production` |
| `docs` | Vercel native deployment from `production` |
| `preview-edge` | Published image, then one Fly Machine update |
| `turn-worker` | Published image, then one Fly Machine update |
| `control-worker` | Published image, then one Fly Machine update |
| `runpod-worker` | Published image, then one Fly Machine update |
| Router and Workspace Runtime | Two published images, then one Environment update |
| Managed RunPod profile | Separate manual profile operation; never implied by a worker image |

Confirm the local checkout contains the intended code and run the repository
gate:

```bash
pnpm validate
```

Verify the provider sessions you intend to use:

```bash
vercel whoami
fly auth whoami
docker info
```

Choose one readable container tag, such as `aug16-runtime-fix`. A tag may use
letters, numbers, `_`, `.`, and `-`; it must begin with a letter, number, or
underscore. The commands trust the operator's chosen tag.

Write down the release scope, tag, operator, start time, and the current image
for every target before changing anything. The provider records are the source
of truth.

## 1. Deploy `one` and `docs`

Advance the protected `production` branch through the normal repository
process. Do not run a repository deployment workflow for Fly or RunPod.

In Vercel, wait for the native production deployments of both projects:

1. Confirm `one` used the production branch and its migration/build completed.
2. Confirm `docs` used the production branch and its build completed.
3. Open the production URLs and verify the smallest affected user path.
4. Record the two Vercel deployment IDs and results.

If either deployment fails, stop. Diagnose that Vercel deployment independently;
do not change Fly, RunPod, or tenant Environments to compensate.

## 2. Publish only the images in scope

Valid roles are `workspace-runtime`, `environment-router`, `preview-edge`,
`turn-worker`, `control-worker`, and `runpod-worker`.

Publish one role at a time:

```bash
pnpm production:image:publish \
  --role <role> \
  --tag <tag>
```

The command builds the selected role for `linux/amd64`, runs that role's image
smoke, and pushes the selected tag. It does not inspect Git, deploy the image,
or update another role. Save the final JSON output in the release notes.

If build, smoke, or push fails, nothing has been deployed. Fix the failure and
rerun only the selected role.

## 3. Update one platform Fly Machine

This procedure applies to `preview-edge`, `turn-worker`, `control-worker`, and
the Fly-hosted `runpod-worker`.

Find and inspect the exact target in its catalog-mapped app:

```bash
fly machine list --app <app>
fly machine status <machine-id> --app <app>
```

Record the current image. Then update one Machine:

```bash
pnpm production:fly:machine \
  --role <preview-edge|turn-worker|control-worker|runpod-worker> \
  --machine <machine-id> \
  --tag <tag>
```

The command prints the signed-in Fly identity, current provider record, exact
requested image, and confirmation text. Read it, type the exact confirmation,
and retain the fresh provider record printed after `fly machine update`.

For `preview-edge`, the command also requires the selected Machine to expose
HTTP 80 and HTTPS 443 to internal port 8080 before the confirmation and after
the update. It refuses missing or changed ingress instead of repairing Fly
configuration during an image rollout.

Verify that Machine before touching another one:

```bash
fly machine status <machine-id> --app <app>
fly logs --app <app>
```

`fly machine update` preserves a stopped Machine's state. If this exact Machine
should be running, start it explicitly:

```bash
fly machine start <machine-id> --app <app>
```

Confirm the Machine is in the intended state, reports the requested tagged image, and passes
the role's normal health or work-delivery check. Updating another Machine is a
new invocation with its own review and confirmation.

### Fly configuration

An image change never activates staged secrets. If configuration is also in
scope, review it separately:

```bash
fly secrets list --app <app>
```

Activate staged secrets only as an explicit app-wide action:

```bash
fly secrets deploy --app <app>
```

Record configuration activation separately because it may restart more than
the selected Machine.

For Preview Edge, `fly.preview-edge.toml` is the only deployable Fly
configuration. If a Machine is missing its public ingress contract, reconcile
the app separately with the current image reference:

```bash
fly deploy \
  --app kestrel-preview-edge \
  --config fly.preview-edge.toml \
  --image <current-image-reference> \
  --update-only \
  --ha=false \
  --strategy rolling
```

Verify every Preview Edge Machine has the same 80/443-to-8080 service mapping
before resuming image rollout. Keep this app-wide configuration evidence
separate from the one-Machine image update.

### Fly rollback

Use the same one-Machine command with the previously recorded tag:

```bash
pnpm production:fly:machine -- \
  --role <role> \
  --machine <machine-id> \
  --tag <previous-tag>
```

Verify and record the provider result again. Do not roll back sibling Machines
unless the operator explicitly selects each one.

## 4. Update one Router and Workspace Runtime pair

Router and Workspace Runtime are a pair for tenant Environments, but publishing
one never publishes or deploys the other. Publish both explicitly with the tag
you intend to use:

```bash
pnpm production:image:publish --role workspace-runtime --tag <tag>
pnpm production:image:publish --role environment-router --tag <tag>
```

Before changing a tenant, prove the pair on disposable Fly resources:

```bash
pnpm --dir apps/web canary:environment:fly -- --tag <tag>
```

That command creates isolated provider resources, exercises routing,
persistence, backup/restore, and cleanup, then deletes those resources. A pass
is isolated-provider evidence, not production proof.

Choose one exact canary Environment and queue only that Environment:

```bash
pnpm --dir apps/web runtime:update \
  --environment <environment-id> \
  --tag <tag>
```

The command pulls the `one` production configuration into a temporary local
directory, prints the authenticated Vercel operator, current pair, requested
pair, and exact confirmation. It returns the real Environment operation ID.

Follow that operation in **Platform > Environment operations** or the selected
Environment's **Activity** page. Do not continue until its status is
`completed` and its stage is `environment.update.ready`. On failure, retain the
operation ID and error and stop; do not activate the pair.

Run the live Workspace and Preview canaries with credentials for that exact
canary Environment:

```bash
pnpm --dir apps/web canary:environment:workspace
pnpm --dir apps/web canary:environment:preview
```

The Workspace canary requires `KESTREL_ONE_CANARY_URL`,
`KESTREL_ONE_CANARY_COOKIE`, `KESTREL_ONE_CANARY_THREAD_ID`, and
`KESTREL_ONE_CANARY_APP_PORT`. It also requires
`KESTREL_ONE_CANARY_MODEL_ID`, which must exactly match an approved OpenAI,
Anthropic, or OpenRouter language model for the selected Thread. The canary
rejects private inference and never falls back to the Environment default. The
selected Thread must be bound to the canary Environment. The Preview canary
requires `KESTREL_PREVIEW_CANARY_GATEWAY_URL`,
`KESTREL_PREVIEW_CANARY_CONTROL_PLANE_URL`,
`KESTREL_PREVIEW_CANARY_TICKET`, and
`KESTREL_PREVIEW_CANARY_PROJECT_DIR`. Supply secrets through the local process
environment; do not paste their values into release notes.

When the operation and both live canaries pass, activate the pair for new
provisioning:

```bash
pnpm --dir apps/web production:runtime:activate \
  --tag <tag> \
  --canary-operation <operation-id>
```

Review the printed current pair, requested pair, and canary operation, then
type the exact confirmation. Activation changes only the current/previous
runtime pointers used by new provisioning. It does not enqueue any Environment.

Update each approved noncanary Environment through a separate `runtime:update`
command and observe its exact operation to completion. There is no batch step.

### Router and Workspace rollback

Treat the previous tag as another manual release:

1. Run the disposable Fly pair canary with the previous tag.
2. Update one canary Environment to the previous tag.
3. Run its live Workspace and Preview canaries.
4. Activate the previous tag using that exact completed operation.
5. Update any other approved Environment individually.

Do not reverse a database migration to make an older runtime work. If the prior
images are incompatible with current data, stop and fix forward.

## 5. Managed RunPod changes

The `runpod-worker` is a Fly Machine and uses the one-Machine procedure above.
Changing its image does not create, edit, qualify, select, or remove a managed
RunPod profile or provider deployment.

If a managed RunPod profile change is intentionally in scope, perform it as a
separate authenticated administrative operation. Record the organization,
profile, image configured for the provider, qualification job/result, and one
real inference result. Do not combine it with a worker image update and do not
apply it to another organization implicitly.

## 6. Close the release

Record only concrete results:

```text
Operator:
Started / completed:
Operator tag:
Intended targets:
Vercel one deployment and result:
Vercel docs deployment and result:
Migration result:
Published role -> tagged image:
Fly app / Machine -> before image -> after image -> health:
Canary Environment -> operation ID -> result:
Workspace canary result:
Preview canary result:
Runtime activation result:
Managed RunPod profile / qualification / inference result:
Failures and disposition:
```

Omit rows that were out of scope. Never mark a target released from a build,
mock, walkthrough, or another provider's success.

## Evidence meanings

| Evidence | What it proves |
| --- | --- |
| Unit or mock test | Local command and contract behavior only |
| Image smoke | The selected image starts and satisfies its smoke contract |
| Disposable Fly or RunPod result | Isolated-provider behavior only |
| Production provider record and health | The exact selected production target changed and is healthy |
| Completed Environment operation and live canaries | The exact selected tenant update worked |

Production proof is target-specific. No result implicitly proves or updates a
sibling Machine, another role, another provider, or another tenant Environment.

The executable contracts are the [image publisher](../scripts/publish-production-image.ts),
[one-Machine Fly updater](../scripts/deploy-production-fly-machine.ts),
[Environment updater](../apps/web/scripts/update-environment-runtime.ts), and
[runtime activator](../apps/web/scripts/activate-production-runtime.ts).
