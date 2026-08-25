---
id: ci-validation
domain: quality
status: active
owner: kestrel-quality
last_verified_at: 2026-07-31
depends_on:
  - ../.github/workflows/ci.yml
  - ../package.json
  - ../tests/proof/mutations.json
---

# CI validation

Kestrel has one required pull-request validation command:

```bash
pnpm validate
```

Developers and GitHub Actions run this exact command. The required gate checks
the public repository boundary, builds shared and root artifacts, typechecks
workspaces, and runs hermetic test groups sequentially with Node test
concurrency capped at four.

The runner records phase, task, and process-launch durations under
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

`validate:audit` executes the targeted critical mutations in
`tests/proof/mutations.json`. It passes only when every mutation is killed by
its owning tests. The command prepares one temporary PostgreSQL fixture because
ten mutations are owned by real database tests; it does not run the broader
PostgreSQL contract suite. It does not replay other boundaries, maintain a
separate test registry, or enforce a repository-wide coverage percentage.

Process validation owns child-process, daemon, CLI, TUI, and packed-consumer
contracts. PostgreSQL validation owns migrations and real-database behavior.
Chromium validation owns the production Web build and cross-surface browser
journeys. macOS packaging remains a release-preparation step.

## Critical mutation checks

Tests use their native Node or Playwright runners. The mutation specification
names only the production change and the exact tests that must reject it.
Validation executes those mutations live in a temporary checkout; it does not
write checked-in evidence or classify unrelated tests. Before applying any
mutation, it confirms that each unique owning-test command passes against the
unmodified candidate.

Use a focused mutation ID while iterating:

```bash
pnpm run test-proofs:mutations -- <mutation-id>
```

`validate:process` builds shared, root, and Workspace Runtime artifacts before
starting its process tests, so it can run directly after a clean dependency
install.

Process validation is modular for focused iteration. The aggregate command
remains the complete process gate; list or select one explicit module when
debugging a failure:

```bash
pnpm validate:process:modules
pnpm validate:process -- --module unit
pnpm validate:process -- --module integration
```

Every discovered process test must belong to exactly one declared module. A
module selection changes only the test set; it does not bypass the process
validation setup or change the aggregate `all` coverage.
