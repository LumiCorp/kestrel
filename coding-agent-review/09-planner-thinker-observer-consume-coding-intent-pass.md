# Planner/Thinker/Observer Coding-Intent Consumption Pass

## What I worked on

Consumed the extractor coding-intent contract in planner, thinker, and observer without changing step topology.

## What changed

- Planner now uses coding intent to:
  - prefer repo-grounding actions first for broad/unknown `implement` scope
  - avoid mutation promotion when `mutationIntent=read_only`
  - preserve verification expectations via `decisionVerification.verificationSteps`
  - preserve direct promotion for explicit safe cases
- Thinker prompt and transition behavior now include coding-specific ordering and verification rules.
- Observer prompt and transition behavior now include coding convergence guards for implementation/verification state.
- Added coding-aware prompt/schema hints for thinker and observer output shape.

## Validation

- `node --import tsx --test tests/unit/planner-tool-intent.test.ts`
- `node --import tsx --test tests/unit/thinker-bypass.test.ts`
- `node --import tsx --test tests/unit/observer-recovery.test.ts`

## Blockers and risks

- No blockers in this pass.
- Residual risk: coding intent quality is still bounded by extractor grounding quality for ambiguous user requests.

## Next recommended to-do

Extend the decision verification contract so coding turns can carry explicit `verificationSteps`, `expectedRepoDelta`, and `blockedBy` with compiler enforcement for blocked outcomes.
