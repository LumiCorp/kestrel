# Enforce secret-safe Browser results

## Failed behavior

The Browser output boundary accepts a `normalizedOrigin` containing a path, query, or fragment and copies it into durable audit evidence. Browser service errors can also carry page, response, or form details into the audit record and model-visible failure. An ordinary dependency error becomes `TOOL_EXECUTION_FAILED`, which is outside the pinned Browser failure set.

A Browser session can pass the JSON Schema while violating the stricter `BrowserSessionV1` timestamp rules. Audit projection parses the session after output validation and throws. The external effect then terminates without a durable normalized result and cannot replay correctly.

## Affected flow

This defect blocks [Register the Browser App and stable tool contract](01-register-the-browser-app-and-tool-contract.md) in integration commit `114c49840`.

`BrowserServicePort` returns host output or throws. The checked-in fixture validates structural JSON. `tools/browser/modules.ts`, `tools/toolResult.ts`, and `src/browser/contracts.ts` then normalize, project, and persist the result. Origin fields are treated as arbitrary non-empty strings, host error details are not restricted to Browser metadata, and session semantic validation occurs inside audit projection after schema acceptance.

The complete repair boundary includes the checked-in output schemas, semantic result parsing, Browser result normalization, audit projection, failure normalization, model presentation, and sentinel regression tests.

## Repair requirements

- Validate every Browser result semantically before it can be persisted, audited, or rendered.
- A normalized origin must contain only scheme, host, and non-default port. It must not retain username, password, path, query, or fragment.
- Browser failures must normalize to the pinned failure-code set with bounded metadata-only messages and details.
- Page contents, request or response bodies, screenshots, form values, fill or type values, credentials, and takeover input must not enter results, audit evidence, traces, or model-visible errors.
- Audit projection must not throw after the result has passed the Browser result boundary.
- Preserve deterministic continuation, artifact presentation, pending-download metadata, and the untrusted-content boundary.

## Done when

- Sentinel tests prove URL queries, form text, page or response content, and host error details are absent from durable audit and model-visible output.
- A host result with a non-origin URL is rejected or normalized before persistence.
- Every thrown host error becomes one permitted Browser failure with bounded safe metadata.
- Session timestamp-order violations fail within normal result validation and produce replayable typed evidence.
- Focused schema, normalizer, audit, result, and replay suites pass.

## Depends on

None.
