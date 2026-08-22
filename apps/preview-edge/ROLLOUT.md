# Preview Edge rollout

Preview Edge is a manually published Fly image deployed to one exact Machine at
a time. Its live proof is public preview routing, not just process health.
Publishing a tag is not deployment proof.

Use the repository-wide [production delivery runbook](../../docs/production-delivery-channels.md)
for the protected `main` to `production` promotion and common provider gates.
This file owns Preview Edge configuration, ordering, verification, and rollback.

## 1. Set the release boundary

Before publishing anything:

1. Confirm the exact changes currently on `main` that the protected
   `main` to `production` pull request will promote.
2. Work from a clean checkout containing the intended production code and run
   `pnpm validate`.
3. Verify `vercel whoami`, `fly auth whoami`, and `docker info`.
4. Choose a new readable tag. Never overwrite the current or rollback tag.
5. Record the operator, start time, production revision, both Vercel
   deployments, every Preview Edge Machine ID, state, check result, image tag,
   and resolved provider image.

Inspect the exact Fly targets without changing them:

```bash
fly machine list --app kestrel-preview-edge
fly releases --app kestrel-preview-edge
```

When the image depends on a Web API, schema, or ticket-contract change, complete
the protected `main` to `production` promotion and verify both native Vercel
deployments before changing a live Preview Edge Machine. Stop if the Kestrel One
migration, build, production health, or smallest affected preview path fails.

## 2. Preserve the public ingress contract

`fly.preview-edge.toml` at the repository root is the only deployable Fly
configuration for this app. Before an image rollout, confirm each selected
Machine exposes internal port 8080, port 80 with HTTP and forced HTTPS, and port
443 with TLS plus HTTP:

```bash
fly machine list --app kestrel-preview-edge --json
```

`production:fly:machine` enforces this contract before and after its image-only
update. It refuses configuration drift instead of changing traffic routing.

If the contract is missing, reconcile configuration as a separate app-wide
operation using the current image reference, then verify every Machine before
returning to the image rollout:

```bash
fly deploy \
  --app kestrel-preview-edge \
  --config fly.preview-edge.toml \
  --image <current-image-reference> \
  --update-only \
  --ha=false \
  --strategy rolling
```

Record that configuration operation separately because it may restart more
than one Machine. DNS, certificates, secrets, and traffic routing are also
separate provider-native operations; an image command never changes them.

## 3. Publish the selected image

```bash
pnpm production:image:publish \
  --role preview-edge \
  --tag <tag>
```

The command builds `linux/amd64`, runs the image smoke, and pushes the selected
tag. Retain its final JSON output. The smoke proves the image-local health and
route-isolation contracts only; it does not prove production ingress, tickets,
Workspace routing, Web compatibility, or a public preview.

## 4. Update started Machines first

Update one started Machine and no other target:

```bash
pnpm production:fly:machine \
  --role preview-edge \
  --machine <started-machine-id> \
  --tag <tag>
```

Then verify that exact Machine before selecting another one:

```bash
fly machine status <started-machine-id> --app kestrel-preview-edge
fly logs --app kestrel-preview-edge --machine <started-machine-id>
```

Require the Machine to remain started, report the requested image, retain the
public ingress contract, and pass the `preview_edge` health check. Repeat this
one-Machine operation for every started Machine in scope before updating any
stopped Machine.

## 5. Prove public preview delivery

Using a designated production canary Environment and a current scoped execution
ticket, run the existing preview canary:

```bash
pnpm --dir apps/web canary:environment:preview
```

Retain its exact Environment, Workspace, preview ID, public URL, and JSON result.
Require all of the following:

- the selected Workspace starts the bounded Vite process;
- Preview Edge returns the public document and Vite client;
- the WebSocket upgrade succeeds;
- the canary closes the preview and terminal session;
- no new authorization, routing, or upstream failure is attributable to the
  updated Machine.

Generic production health, a direct `/health` response, or image smoke is not
public preview delivery proof.

## 6. Update stopped Machines

After all started Machines and the public preview path pass, update each stopped
Machine with a separate invocation:

```bash
pnpm production:fly:machine \
  --role preview-edge \
  --machine <stopped-machine-id> \
  --tag <tag>
```

Confirm the provider record reports the requested image, the ingress contract
is intact, and the Machine remains stopped. Do not start a standby merely to
prove an image update.

## Rollback

If a started Machine or public preview proof fails, stop the rollout and restore
that exact Machine to its recorded previous tag with `production:fly:machine`.
Do not update a standby or change ingress to compensate for an image failure.
Re-run the Machine checks and public preview canary after rollback.

## Closeout evidence

Record only observed results:

```text
Operator and time:
Promotion PR and included scope:
Kestrel One and Docs deployment results:
Published tag and image:
Started Machine before -> after -> ingress and health:
Public preview canary Environment / preview / result:
Stopped Machine before -> after -> state:
Failures and disposition:
```
