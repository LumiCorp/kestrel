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
| Before audit | 3,439 | Statically discoverable automated test declarations                                       |
| Retained     | 3,377 | Registered to an executable contract and a required lane                                  |
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
| runtime             | 2,495 | Linux                |
| public packages     |    84 | Linux                |
| web                 |   543 | Linux                |
| hosted services     |    65 | Linux                |
| PostgreSQL          |    15 | Linux and PostgreSQL |
| Chromium product    |     9 | Linux and Chromium   |
| Desktop             |   125 | Linux                |
| documentation       |    25 | Linux                |
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

The pull request's all-lanes run is the authoritative runner-time and critical-path
measurement. `ci-plan` and `ci-required` are dependency-free Node programs;
`ci-required` consumes job results directly and performs no checkout or setup.
