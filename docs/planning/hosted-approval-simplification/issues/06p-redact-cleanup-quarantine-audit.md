# Redact cleanup quarantine audit

## Failed behavior

The append-only cleanup quarantine event copies arbitrary malformed result
output and error objects. The JSON sanitizer repairs malformed JSON structure
but does not redact credentials, authorization headers, provider tokens, URLs,
or unbounded payloads, so sensitive data can become permanently replayable.

## Affected work

[Serialize cleanup release and audit quarantine](06o-serialize-cleanup-release-and-audit-quarantine.md),
commit `f0340470d`, especially
`buildPreparedApprovalCleanupDoneEvidenceQuarantineEvent` and run-event
metadata persistence.

## Repair requirements

Persist only bounded non-sensitive audit evidence: exact effect/result identity,
status, original timestamp, validation reason, canonical hash, byte/shape
summary, and explicitly safe release-invocation identifier when it is a string.
Never persist raw malformed output, raw error, URLs, authorization/API-key/token
fields, or unbounded nested content. Apply the same projection in in-memory and
PostgreSQL paths before append.

## Done when

- Authorization, token, API-key, URL, provider payload, and error-message
  secrets are absent from append-only audit and replay.
- Oversized/nested/cyclic/invalid-Unicode inputs produce bounded deterministic
  hash/size/shape evidence.
- Safe identity, timestamp, validation reason, and optional release ID remain
  sufficient to diagnose quarantine after reset and successful retry.
- Focused audit tests cover sensitive keys/values and size bounds.

## Depends on

[Serialize cleanup release and audit quarantine](06o-serialize-cleanup-release-and-audit-quarantine.md).
