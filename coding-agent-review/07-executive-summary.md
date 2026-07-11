# Executive Summary

## What the current agent is

`reference-react` is a strong reference implementation of Kestrel’s runtime philosophy:

- explicit step graph
- typed structured outputs
- schema-checked compilation
- controlled execution
- explicit waiting and finalization
- replayability and inspectability

In the CLI/runtime path it can already access coding-relevant tools, including filesystem tools, `code.execute`, and `dev.shell.*`.

## What it is not

It is not yet a serious software-engineering agent.

The missing pieces are not primarily more tools or a different runtime loop. The missing pieces are:

- coding-specialized prompt doctrine
- a durable engineering work artifact
- engineering-specific observer convergence
- explicit verification expectations
- a coding-shaped final-report contract

## Top 5 changes

1. Add coding-specialized prompt decomposition across extractor, planner, thinker, and observer.
2. Extend extractor and decision schemas with coding-specific task and verification fields.
3. Add a durable `react.workPlan`-style artifact for implementation and verification reconciliation.
4. Upgrade observer and finalize behavior to judge engineering completion, not just evidence sufficiency.
5. Align coding posture in skill packs and presets so code tasks can use `dev.shell.*` when policy allows.

## Easiest vs hardest

### Easiest

- prompt decomposition
- coding-oriented final output contract
- skill-pack and preset alignment

### Hardest

- durable work-plan artifact
- observer convergence upgrade for implementation and verification
- any runtime-enforced verification policy that avoids becoming heuristic

## Recommendation

Evolve `reference-react`. Do not replace it.

The architecture is already the right one for a serious coding agent. The smallest aligned path is to create a coding-specialized prompt-and-contract profile on top of the existing step graph, compiler, execution controller, and replay model.

A separate coding-specialized reference agent only becomes necessary if the team wants materially different step topology. The current evidence does not justify that yet. The current topology is good enough; the behavior layer is what needs to change.
