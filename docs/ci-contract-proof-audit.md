---
id: ci-contract-proof-audit
domain: quality
status: active
owner: kestrel-quality
last_verified_at: 2026-07-20
depends_on:
  - ../.github/workflows/ci.yml
  - ../tests/proof/registry.json
  - ../tests/proof/catalog.json
---

# CI contract-proof audit

This audit records the replacement of Kestrel's gate-oriented CI with required,
selective contract proofs. It describes the corpus and local validation at the
time of the change; GitHub runner timings belong in the pull-request run summary,
not in this source-controlled baseline.

## Corpus disposition

| Disposition  | Tests | Reason                                                                                    |
| ------------ | ----: | ----------------------------------------------------------------------------------------- |
| Before audit | 3,446 | Statically discoverable automated test declarations                                       |
| Retained     | 3,384 | Registered to an executable contract and a required lane                                  |
| Merged       |     0 | No pair was equivalent enough to merge without weakening its counterexample               |
| Deleted      |    62 | Optional, synthetic, configuration-shape, stale browser, or non-current operations checks |

The versioned catalog assigns every retained test a stable identity, owner, risk,
counterexample, distinct dimension, role, lane, and required environment. The
proof checker rejects unregistered or stale entries, duplicate identities or
dimensions, dynamic titles, skips, todos, focused tests, retries, optional lanes,
and stale high- or critical-risk mutation records.

Retained tests by required lane:

| Lane                | Tests | Required environment |
| ------------------- | ----: | -------------------- |
| policy and registry |    15 | Linux                |
| runtime             | 2,496 | Linux                |
| public packages     |    84 | Linux                |
| web                 |   543 | Linux                |
| hosted services     |    65 | Linux                |
| PostgreSQL          |    15 | Linux and PostgreSQL |
| Chromium product    |     9 | Linux and Chromium   |
| Desktop             |   125 | Linux                |
| documentation       |    31 | Linux                |
| macOS packaging     |     1 | macOS                |

## Removed ceremony

- Scheduled canaries and post-merge `push` CI.
- WebKit execution and scheduled-canary conditionals. CI now claims Chromium only.
- The deterministic prompt-suite harness; Ruhroh owns model-quality evaluation.
- Synthetic replay execution and synthetic seed fixtures. The replay comparator
  and current-runtime replay behavior remain covered.
- Release-track governance, warning-only invariants, and exact workflow or package
  script shape assertions.
- Browser and PTY operations checks that did not reliably exercise a current,
  required product contract.

The former release-evaluation command is now Ruhroh configuration validation and
runs only for evaluation-configuration ownership. It does not claim to execute an
evaluation.

## Failure-signal comparison

The old topology mixed real failures with non-actionable noise: PostgreSQL tests
could silently skip, TUI behavior depended on ambient `CI` and database state,
package consumers raced concurrent workspace builds, stale browser flows failed
against the current product, and synthetic replay asserted fixture machinery
rather than the runtime.

The audit found defects that the previous topology did not make legible:

- A replay mutation initially survived because the owning assertion did not name
  the missing strict event. The assertion now kills that mutation.
- PostgreSQL retry and Chromium product mutations are killed by their owning
  contract tests and recorded against current production and test hashes.
- PostgreSQL and macOS requirements are explicit lanes; they cannot silently skip
  in a normal Linux lane.
- CLI, TUI, package-consumer, and browser contracts that remain are required and
  run with zero skips and zero retries.

This change intentionally adds no coverage percentage, duration budget, or other
arbitrary threshold. A failure is useful when it identifies a named contract and
a concrete counterexample.

## Measured local validation

The full audited corpus was exercised through the replacement lane commands on
the implementation worktree. Observed local runner time is diagnostic only:

| Lane or proof                                 | Approximate local duration | Result                      |
| --------------------------------------------- | -------------------------: | --------------------------- |
| Runtime core, shell smoke, and CLI operations |                      115 s | Passed                      |
| Public packages and consumer integration      |                       46 s | Passed                      |
| Hosted services                               |                        5 s | Passed                      |
| Desktop                                       |                       25 s | Passed                      |
| Documentation                                 |                       18 s | Passed                      |
| Retained TUI PostgreSQL operations            |                       34 s | Passed, 7 tests, zero skips |
| Chromium durable-conversation proof           |                      168 s | Passed, 3 tests             |
| macOS CLI and Desktop packaging               |                       80 s | Passed                      |
| Proof-system unit tests                       |                        3 s | Passed, 15 tests            |

## First GitHub all-lanes run

Pull request #66 exercised every required lane on GitHub Actions after the
Linux-only Local Core process-contention failure was repaired:

| Job                            | GitHub duration | Result |
| ------------------------------ | --------------: | ------ |
| Contract-proof plan            |             4 s | Passed |
| Policy and proof registry      |       1 min 1 s | Passed |
| Runtime unit and integration   |      4 min 33 s | Passed |
| Public packages                |      1 min 50 s | Passed |
| Web unit, typecheck, and build |      4 min 58 s | Passed |
| Hosted services                |       1 min 2 s | Passed |
| PostgreSQL                     |      2 min 43 s | Passed |
| Chromium product               |      6 min 20 s | Passed |
| Desktop                        |      1 min 52 s | Passed |
| Documentation                  |      1 min 36 s | Passed |
| macOS packaging                |      4 min 15 s | Passed |
| `ci-required`                  |             2 s | Passed |

Chromium was the critical lane at 6 minutes 20 seconds. Including the planner
and aggregate, the proof system's observed critical path was approximately 6
minutes 26 seconds. `ci-plan` and `ci-required` are dependency-free Node
programs; `ci-required` consumed job results directly and performed no checkout
or setup.
