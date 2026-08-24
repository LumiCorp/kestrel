# Bind exact-result outcome activation

Status: repair required

Exact effect-result reads must require canonical equality across the prepared activation, result activation, and nested outcome activation. Matching only `contractRevision` permits a different tool/source/registry/scope to be replayed under the prepared outer envelope.

Completion: enforce the full activation join in protocol and store parsing and add malformed wire plus durable-store regressions.
