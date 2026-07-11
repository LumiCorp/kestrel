# Contributing to Kestrel

Kestrel Desktop is the flagship product surface of the Kestrel Suite. Contributions should preserve that Desktop-first public story while respecting the shared runtime, companion surfaces, and contract-heavy validation model underneath it.

## Where To Start

- Desktop product work: start with [apps/desktop/README.md](https://github.com/LumiCorp/kestrel/blob/main/apps/desktop/README.md)
- Public docs and product framing: start with [README.md](https://github.com/LumiCorp/kestrel/blob/main/README.md) and [apps/docs/README.md](https://github.com/LumiCorp/kestrel/blob/main/apps/docs/README.md)
- Runtime and shared contracts: start with [ARCHITECTURE.md](https://github.com/LumiCorp/kestrel/blob/main/ARCHITECTURE.md), [RELIABILITY.md](https://github.com/LumiCorp/kestrel/blob/main/RELIABILITY.md), and [SECURITY.md](https://github.com/LumiCorp/kestrel/blob/main/SECURITY.md)

## Development Setup

```bash
cp .env.example .env
pnpm install
pnpm run desktop:dev
```

Kestrel Desktop is the recommended first-run path for local evaluation and product-facing changes.

## Validation Expectations

Run the narrowest useful checks for your change first, then the broader gates when appropriate.

Baseline repo checks:

```bash
pnpm run governance:check
pnpm run test
pnpm run prompt-suite
```

Runtime/core and replay-oriented work should also run:

```bash
pnpm run evals:release-check
```

Desktop-focused public ship checks:

```bash
pnpm --filter @kestrel/desktop test
pnpm --filter @kestrel/desktop build
```

Docs-heavy changes should at minimum run:

```bash
pnpm run check:docs
pnpm run docs:test
```

If `governance:check` fails at `check:desktop-resources`, refresh the mirrored desktop resources and rerun governance:

```bash
pnpm --filter @kestrel/desktop prepare:resources
pnpm run governance:check
```

## Pull Requests

- Keep changes small, reversible, and grounded in existing shared utilities.
- Preserve runtime contract invariants, replay semantics, and evidence-backed behavior.
- Explain user-visible impact clearly, especially for Desktop, runtime, and docs changes.
- Link issues when relevant and describe which validation commands you ran.

## Reporting Problems

- Bugs and feature requests: open a GitHub Issue.
- Usage questions: use GitHub Discussions if enabled for the public repo; otherwise open an Issue.
- Security issues: do not file a public issue. Follow [SECURITY.md](https://github.com/LumiCorp/kestrel/blob/main/SECURITY.md).
