# Decision Verification Contract Pass

## What I worked on

Extended the v2 decision verification envelope for coding work in an additive way.

## What changed

- Extended verification shape across types/schema/compiler with optional fields:
  - `verificationSteps`
  - `expectedRepoDelta`
  - `blockedBy`
- Kept non-coding compatibility and additive semantics.
- Added compiler policy checks for coding turns:
  - coding `cannot_satisfy` now requires non-empty `verification.blockedBy`
  - blocked coding finalization now requires non-empty `verification.blockedBy`
- Updated OpenRouter phase-schema compatibility expectations for the expanded verification contract.

## Validation

- `node --import tsx --test tests/unit/compile-intent-required-capabilities.test.ts`
- `node --import tsx --test tests/unit/openrouter-phase-schema-compat.test.ts`

## Blockers and risks

- No blockers in this pass.
- Residual risk: blocked reason quality depends on model-authored `blockedBy` detail quality.

## Next recommended to-do

Add and stabilize a compact durable `react.workPlan` lifecycle so coding progress can survive compaction and guide observer finalization.
