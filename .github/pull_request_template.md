## Summary

- what changed
- why it changed

## Surface

- Desktop
- Web / Kestrel One
- CLI
- Evaluations / Ruhroh definitions
- SDK / package layer
- Runtime / shared contracts
- Docs only

## Validation

Confirm the canonical pull-request validation:

```bash
pnpm validate
```

List any focused process, PostgreSQL, Chromium, mutation, documentation,
Desktop, Ruhroh, or release checks separately when the change touches those
surfaces.

For changes to production images or runtime delivery, add this note:

```text
Production owner: Fly, managed RunPod, and tenant runtime changes are local manual operations. Review `docs/production-delivery-channels.md`; do not add a production-push deployment or a web-triggered deployment path.
```

PR CI must not publish images, update Machines, register runtime pairs, or
activate tenant runtime versions.

## Notes

Anything reviewers should pay attention to.
