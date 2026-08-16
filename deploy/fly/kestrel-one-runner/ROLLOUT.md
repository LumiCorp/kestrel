# Hosted Environment runtime rollout

Workspace Runtime and Environment Router are separate GHCR images operated as
one manual pair. Choose a readable tag and publish each role locally:

```bash
pnpm production:image:publish -- --role workspace-runtime --tag <tag>
pnpm production:image:publish -- --role environment-router --tag <tag>
```

Update one selected Environment through its existing durable operation:

```bash
pnpm --dir apps/web runtime:update -- \
  --environment <environment-id> \
  --tag <tag>
```

Review the printed current and requested images, type back the Environment ID
and tag, and follow the returned operation until `environment.update.ready`.
Run the Workspace and preview canaries manually. To make that pair the default
for new Environments, explicitly activate the exact completed operation:

```bash
pnpm --dir apps/web production:runtime:activate -- \
  --tag <tag> \
  --canary-operation <operation-id>
```

No command discovers or updates another Environment. Repeat `runtime:update`
for each approved target. Rollback uses the same sequence with the previous
operator tag.
