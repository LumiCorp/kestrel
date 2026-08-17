# Preview Edge rollout

`fly.preview-edge.toml` at the repository root is the only deployable Fly
configuration for this app. Image publication uses the Dockerfile registered in
`deploy/fly/image-catalog.json`; it does not use a second Fly configuration.

Before an image rollout, inspect the selected Machine and confirm its provider
record contains the public HTTP service on internal port 8080, with port 80
using the HTTP handler and forced HTTPS and port 443 using TLS plus HTTP:

```bash
fly machine list --app kestrel-preview-edge --json
```

`production:fly:machine` enforces that contract before and after its image-only
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
than one Machine.

Choose a readable operator tag, build and smoke the image locally, then update
one exact Fly Machine:

```bash
pnpm production:image:publish --role preview-edge --tag <tag>
pnpm production:fly:machine \
  --role preview-edge \
  --machine <machine-id> \
  --tag <tag>
```

The first command does not deploy. The second prints the authenticated Fly
identity and provider state, requires the role, Machine ID, and tag to be typed
back, updates only that Machine, and prints a fresh provider record. Rollback is
the same Machine command with the previous tag.

DNS, certificates, secrets, and traffic routing are separate provider-native
operations. The image command never changes them.
