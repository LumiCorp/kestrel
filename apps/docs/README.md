# `@kestrel/docs`

This app is the published documentation site for Kestrel.

It turns the repo's docs content into an editorial Next.js site covering product narrative, runtime model, apps, packages, CLI workflows, deployment, operations, and reference material.

## What Lives Here

- the docs site application shell
- content loading and navigation helpers
- MDX-backed documentation content under `content/`
- local search indexing and search UI

## Scope

Use this app when you are working on:

- public or contributor-facing docs site experience
- docs navigation and search
- MDX rendering and content organization

The root source-of-truth docs still live at the repo root and under `docs/`; this app is the richer published presentation layer for them.

## Local Development

From the repo root:

```bash
pnpm run docs:dev
```

Build:

```bash
pnpm run docs:build
```

## Related Code

- [Docs site metadata](apps/docs/lib/site.ts)
- [Root docs index](docs/index.md)
- [Root README](README.md)
