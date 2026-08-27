# Require immutable cleanup intent for all result statuses

## Failed behavior

Stores require cleanup intent only when one initial raw status read says DONE.
A stateful status accessor can return FAILED for the guard and DONE during
generic persistence, recording release success without validation or release.
Real EffectRunner failure paths omit cleanup intent. The intent object itself is
also read repeatedly, and the shared test store ignores it.

## Affected work

[Bind cleanup persistence to one pre-await evidence snapshot](06z5-bind-cleanup-persistence-snapshot.md),
commit `a3ae6bdcb`, especially `EffectStore.saveEffectResult`, EffectRunner
failure persistence, and the shared test store.

## Repair requirements

Require explicit cleanup intent for every result written against a durable
cleanup effect, including FAILED results. Snapshot intent authority once before
use. Materialize DONE and FAILED cleanup results into isolated stable forms and
persist only that materialization. Update every real cleanup failure caller and
make the shared test store enforce equivalent intent semantics.

## Done when

- Missing intent cannot persist any cleanup result regardless of stateful raw
  status or post-call mutation.
- Cleanup FAILED results remain durably FAILED and preserve bounded error
  evidence without becoming DONE.
- Stateful intent getters cannot switch the selected cleanup effect.
- Production and shared test stores enforce the same contract.

## Depends on

[Bind cleanup persistence to one pre-await evidence snapshot](06z5-bind-cleanup-persistence-snapshot.md).
