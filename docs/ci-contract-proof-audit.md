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
---

# CI validation-contract audit

Kestrel has one portable pull-request validation contract:

```bash
pnpm validate
```

Developers and GitHub Actions run this exact command. `scripts/validate.mjs`
owns a fixed, path-independent DAG; there is no second CI command map or
changed-file classifier.

## Portable validation

The runner verifies Node.js 22, performs each shared build once, and then runs
static analysis, hermetic tests, and portable application builds concurrently.
Process integration follows. One PostgreSQL container supplies isolated cloned
databases to all database contracts, then one production Web environment and
one Chromium process execute the two browser journeys. Contract, coverage, and
mutation evidence are audited last.

Every test belongs to exactly one boundary: `hermetic`, `process`, `postgres`,
or `chromium`. The clean-suite target is six minutes and the enforced maximum
is eight minutes. Phase budgets, process launches, the one-container invariant,
the one-browser invariant, coverage, contract timings, and slow tasks are
written under `test-results/validation/`.

Environment setup is explicit but is not a second validation definition. A
developer machine needs the frozen pnpm workspace, Docker, and Playwright
Chromium. GitHub Actions prepares those dependencies before invoking
`pnpm validate`.

## Proof registry

Tests call `contractTest(contractId, title, ...)`. The versioned registry names
the exact proofs, owner, risk, counterexample, one of the four boundaries, and a
runtime budget. Critical contracts also name targeted semantic mutations.

The checker rejects unknown contracts, boundary mismatches, missing exact
proofs, dynamic declarations, skips, todos, focused tests, retries, budget
overruns, and stale critical killed-mutation evidence. V8 execution and branch
range signals are compared by component; no arbitrary global percentage is
used.

## Release-only validation

macOS packaging is not portable and is therefore not a pull-request gate. Run
it explicitly during release preparation:

```bash
pnpm run validate:release:macos
```

Focused component commands remain available for iteration. Passing them does
not replace the complete `pnpm validate` readiness contract.
