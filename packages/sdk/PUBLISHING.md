# Publishing `@kestrel-agents/sdk`

## Release Checklist

Run the package-specific checks from the repo root:

```bash
pnpm run sdk:build
pnpm run sdk:test
pnpm run sdk:smoke
pnpm run sdk:release-check
```

`sdk:release-check` validates the packed tarball, not just the workspace sources. It confirms:

- manifest metadata is present
- the tarball includes `README.md`, `LICENSE`, and built entrypoints
- the root package exports the agent-first API
- the advanced `./runner` subpath remains importable
- the packed runner client contains both explicit remote and Local Core transports
- removed artifacts such as `NativeRunnerClient` are not shipped
- the packed package can be imported as installed output

## Publish Flow

1. Bump the version in `packages/sdk/package.json`.
2. Run the release checklist.
3. Publish from the package workspace:

```bash
pnpm --filter @kestrel-agents/sdk publish --access public
```

## Runtime Support

This package is intended for server-side Node.js runtimes only.

- Supported: Node.js 20+, Next.js route handlers, Server Actions, backend services, workers
- Not supported: browsers, edge runtimes
