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

Kestrel has one required pull-request validation command:

```bash
pnpm validate
```

Developers and GitHub Actions run this exact command. The required gate checks
the public repository boundary, builds shared and root artifacts, typechecks
workspaces, and runs hermetic test groups sequentially with Node test
concurrency capped at four.

The runner records phase, task, contract, and process-launch durations under
`test-results/validation/`. Durations are diagnostic evidence, not blocking
correctness gates. GitHub Actions' 15-minute job timeout is the operational hang
watchdog.

The required gate does not start Docker or Chromium, install browser
dependencies, collect repository-wide V8 coverage, execute mutations, or build
release artifacts.

## Focused boundary validation

Heavier checks remain explicit commands for their owning surfaces:

```bash
pnpm run validate:process
pnpm run validate:postgres
pnpm run validate:chromium
pnpm run validate:audit
pnpm run ruhroh:validate
pnpm run validate:release:macos
```

`validate:audit` verifies critical mutations and the contract registry. It does
not replay other boundaries or enforce a repository-wide coverage percentage.

Process validation owns child-process, daemon, CLI, TUI, and packed-consumer
contracts. PostgreSQL validation owns migrations and real-database behavior.
Chromium validation owns the production Web build and cross-surface browser
journeys. macOS packaging remains a release-preparation step.

## Proof registry

Tests call `contractTest(contractId, title, ...)`. The versioned registry names
the exact proofs, owner, risk, counterexample, and boundary. Critical contracts
name targeted semantic mutations. The checker rejects unknown contracts,
boundary mismatches, missing exact proofs, dynamic declarations, skips, todos,
focused tests, retries, missing runtime evidence, and stale mutation evidence.
