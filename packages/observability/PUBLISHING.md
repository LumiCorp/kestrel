# Publishing `@kestrel-agents/observability`

1. Run `pnpm run observability:release-check`.
2. Confirm the packed tarball includes `README.md`, `LICENSE`, and the built `dist/` files.
3. Publish from `packages/observability` with `pnpm publish --access public`.
