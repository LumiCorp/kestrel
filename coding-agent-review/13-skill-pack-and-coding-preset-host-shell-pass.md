# Skill Pack and Coding Preset Host-Shell Alignment Pass

## What I worked on

Aligned coding posture in skill-pack/profile narrowing and operator coding preset/task-template language.

## What changed

- Updated `cli/runtime/skillPacks.ts`:
  - code skill pack now preserves `dev.shell.*` tools when they are already present in the active profile allowlist
  - narrowing behavior is still profile-constrained; no policy bypass or hidden elevation
  - internal runtime tools remain always included
- Updated `src/operatorShell.ts` coding preset/task-template copy to explicitly promise:
  - workspace inspection
  - implementation
  - validation
  - host-shell workflows when permitted
- Kept coding preset in `act.safe` and left investigation/review/orchestration posture unchanged.

## Validation

- `node --import tsx --test tests/unit/skill-packs.test.ts`
- `node --import tsx --test tests/unit/operator-shell-coding-preset.test.ts`

## Blockers and risks

- No blockers in this pass.
- Residual risk: profile configs that omit `dev.shell.*` remain intentionally shell-disabled for coding tasks.

## Next recommended to-do

Run and evaluate coding-focused scene/regression slices that explicitly exercise implement + verify + blocked paths end-to-end under the updated contracts.
