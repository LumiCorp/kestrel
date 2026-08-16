# Preview Edge image rollout

Choose a readable operator tag, build and smoke the image locally, then update
one exact Fly Machine:

```bash
pnpm production:image:publish -- --role preview-edge --tag <tag>
pnpm production:fly:machine -- \
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
