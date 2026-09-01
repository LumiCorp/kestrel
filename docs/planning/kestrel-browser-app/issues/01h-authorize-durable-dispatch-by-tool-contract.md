# Authorize durable dispatch by tool contract

## Failed behavior

Commit `4e33f46b9` discovers the durable external-effect dispatch protocol by scanning input-adapter metadata. Any prepared call can self-assert that metadata. A non-Browser mutation such as `fs.write_text` can therefore turn a conservatively unknown claimed effect into retryable `not_started`, risking duplicate delivery.

## Affected flow

`src/io/ToolInvocationSupport.ts` parses dispatch opt-in and `src/effects/EffectRunner.ts` changes recovery semantics from that decision. The registered tool descriptor/runtime adapter is the trusted owner of protocol capability; model-derived or prepared input metadata is not.

## Repair requirements

- Authorize the stronger dispatch protocol from a trusted registered tool/runtime contract bound to the exact prepared tool identity.
- Reject or ignore self-asserted adapter metadata from tools that are not explicitly registered for the protocol.
- Keep every non-adopting external-effect tool terminal and unknown after an ambiguous claim/throw.
- Keep Browser `CLAIMED -> DISPATCHED` recovery and exact-result replay behavior introduced by 01d.

## Done when

- A spoofed `fs.write_text`, Email, MCP, or other non-adopter cannot acquire Browser retry semantics.
- A registered Browser mutation still distinguishes claimed-before-dispatch from durably dispatched-without-result across restart.
- Focused registry, prepared-call integrity, effect recovery, and compatibility suites pass.

## Depends on

None.
