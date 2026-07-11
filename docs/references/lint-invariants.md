---
id: lint-invariants
domain: docs
status: active
owner: kestrel-quality
last_verified_at: 2026-06-30
depends_on:
  - architecture-rules.json
  - ../index.md
  - ../../src/governance/invariants.ts
---

# Lint Invariants

These invariants are the lightweight policy rules enforced by `pnpm run check:invariants`. They are designed to keep boundary, error, and operator-facing contracts mechanically visible in code review.

## Invariants

- `structured-logging`: source in `src/**/*.ts` should prefer structured log payloads with explicit fields instead of ambiguous string-only logging.
- `max-file-size`: TypeScript source should stay under the maximum line threshold checked by the invariant runner to preserve legibility and reviewability.
- `parse-boundary`: boundary-facing code in `src/io`, `src/effects`, and `tools` must visibly parse or validate unknown external input before using it.
- `normalized-error-shape`: runtime, app, and tool code should expose machine-readable `code` and `message` fields instead of ad hoc thrown errors.
- `route-triage-contract`: canonical operator triage fields must remain present in the governance contract.

## Enforcement

- Command: `pnpm run check:invariants`
- Included in bundle: `pnpm run governance:check`
- Rule source: [src/governance/invariants.ts](https://github.com/LumiCorp/kestrel/blob/main/src/governance/invariants.ts)
- Runner script: [scripts/check-invariants.ts](https://github.com/LumiCorp/kestrel/blob/main/scripts/check-invariants.ts)

## Severity Model

- Each invariant declares a default severity.
- Some repo paths upgrade warnings to errors where the contract is considered release-critical.
- `check:invariants` exits non-zero only for error-level violations.

## Scope Notes

- The invariant runner scans TypeScript files in `src/`, `tools/`, and `apps/web/`.
- Generated desktop/CLI artifacts and ignored runtime/benchmark artifact roots such as `runs/`, `jobs/`, `logs/`, `output/`, `.kestrel/`, `.external/`, and `.cli-package/` are excluded from invariant scanning.
- This document is an index of the active invariant set; the exact rule implementation lives in the source files above.
