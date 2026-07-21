---
id: ci-contract-proof-audit
domain: quality
status: active
owner: kestrel-quality
last_verified_at: 2026-07-21
depends_on:
  - ../.github/workflows/ci.yml
  - ../package.json
  - ../tests/proof/registry.json
  - ../tests/proof/catalog.json
---

# CI validation-contract audit

Kestrel has one portable pull-request validation contract:

```bash
pnpm validate
```

Developers and GitHub Actions run this exact command. It is fail-fast and always
executes the complete portable suite; file-based lane selection and separate
local/CI command maps are intentionally absent.

## Portable validation

The command verifies Node.js 22, builds shared workspace packages, checks root
type safety and proof-registry integrity, then validates
governance, Ruhroh configuration, OpenAPI and route ownership, runtime behavior,
public packages, Kestrel One, hosted services, PostgreSQL integration, Chromium
product contracts, Desktop, and documentation.

Environment setup is explicit but is not a second validation definition. A
developer machine needs the frozen pnpm workspace, Docker, and Playwright
Chromium. GitHub Actions prepares those dependencies before invoking
`pnpm validate`.

## Proof registry

The versioned proof catalog assigns every retained automated test a stable
identity, owner, risk, counterexample, dimension, role, lane, and required
environment. Those fields describe the contract and where it executes; they no
longer select a subset of tests for a change.

The proof checker rejects unregistered or stale entries, duplicate identities
or dimensions, dynamic titles, skips, todos, focused tests, retries, and stale
high- or critical-risk mutation evidence.

## Release-only validation

macOS packaging is not portable and is therefore not a pull-request gate. Run
it explicitly during release preparation:

```bash
pnpm run validate:release:macos
```

Focused component commands remain available for iteration. Passing them does
not replace the complete `pnpm validate` readiness contract.
