## Mission
Guide Codex and engineers to ship reliable Kestrel runtime changes quickly with clear guardrails.

## Context Map
- [Architecture](./ARCHITECTURE.md)
- [Design Principles](./DESIGN.md)
- [Quality Score](./QUALITY_SCORE.md)
- [Reliability](./RELIABILITY.md)
- [Security](./SECURITY.md)
- [Docs Index](./docs/index.md)
- [Plans](./docs/PLANS.md)

## Execution Rules
- Keep changes small, reversible, and aligned with existing shared utilities.
- Preserve runtime contract invariants, deterministic replay semantics, and evidence-backed behavior.
- Before proposing a runtime fix, name the observed wrong behavior, the component that first made it wrong, and the existing surface that owns the repair.
- Do not treat downstream rejection as proof the downstream boundary owns the bug.
- Prefer model-visible and contract-carrying surfaces (tool descriptions, field descriptions, examples, prompts, validators, retries, and result shaping) before adding schema fields, metadata channels, abstraction layers, or boundary interfaces.
- Boundary validation is appropriate when the boundary owns the contract, or as clearly labeled defense in depth after ownership is known.
- When behavior is weak or repetitive, harden prompts, schemas, and explicit contracts before considering heuristics, thresholds, fallback ranking, retry caps, or policy tuning.
- Do not introduce or expand heuristic-based decision-making (keyword rules, score thresholds, URL/path matching, overlap rules, ranking, classification, fallback, or policy logic) without first surfacing the exact heuristic and getting approval.
- Parse and validate boundary input before use.

## Validation Gates
- Run `pnpm validate` before declaring a pull request ready. GitHub Actions runs
  this same portable gate: public-boundary validation, shared and root builds,
  workspace typechecks, and hermetic tests.
- Run `validate:process`, `validate:postgres`, `validate:chromium`, or
  `validate:audit` explicitly when changing the boundary they own.
- Use `pnpm run test-proofs:mutations -- <mutation-id>` for focused
  critical-contract iteration.

## Escalation
- Escalate when schema migrations, irreversible data moves, or policy changes are required.
- Escalate when replay baseline or canary assertions regress and the root cause is unclear.
- Escalate when autonomy policy evidence requirements cannot be satisfied.
- Escalate before shipping heuristic runtime or policy behavior that has not been explicitly approved by the user.
