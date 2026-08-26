# Align the V2 approval prompt with its strict decisions

## Failed behavior

The V2 prompt tells users to reply `approve` or `deny`, while its strict input
schema accepts only `approve_once` or `decline`. Text, accessibility, Mobile,
and generic protocol clients can follow the published prompt and submit a
response the interaction rejects.

## Affected work

[Persist the exact tool invocation before approval](01-persist-prepared-invocation.md),
commit `20f1c39fe`, especially
`agents/reference-react/src/steps/acter/policyGates.ts` and
`src/runtime/assistantResponseContract.ts`.

## Repair requirements

The V2 prompt, response schema, and response parser must publish and accept the
same strict Issue 01 vocabulary: `decline` and `approve_once`. Do not expose
`remember_approval` before Issue 03, and preserve V1 behavior.

## Done when

- A client following the V2 prompt can submit each advertised decision.
- Focused contract tests compare prompt guidance with the V2 schema vocabulary.
- The affected issue's original outcome and constraints still hold.

## Depends on

None.
