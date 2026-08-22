# OpenRouter Model Economics Repair Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free frontier. Move issues between states as implementation and review change the graph.

## Ready

- None.

## In progress

None.

## Blocked

- None.

## Done

- [Approve exact OpenRouter models with provider-backed economics](01-approve-exact-openrouter-models.md)
- [Repair OpenRouter admission errors and race guards](05-repair-openrouter-admission-boundary.md)
- [Keep ineligible hosted models out of runtime selection](02-enforce-hosted-model-runtime-eligibility.md)
- [Assign disclosed defaults only through eligible provider adapters](03-add-provider-declared-economics-fallbacks.md)
- [Repair legacy model profiles without losing default intent](04-repair-legacy-model-economics-state.md)
