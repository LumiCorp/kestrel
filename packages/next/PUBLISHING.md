# Publishing `@kestrel-agents/next`

1. Run `pnpm run next:release-check`.
2. Confirm the packed tarball includes `README.md`, `LICENSE`, and the built `dist/` files.
3. Publish from `packages/next` with `pnpm publish --access public`.
