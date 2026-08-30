# Carry full-size hosted viewer frames

## Failed behavior

The Browser engine accepts a PNG viewer frame up to 20 MiB raw, and the Router
and Web tiers allow 28 MiB serialized responses. The worker nevertheless sends
`/v1/viewer` through the generic 20 MiB JSON writer. Base64 expansion therefore
rejects otherwise valid frames above roughly 15 MiB and the Web tier
misclassifies the failure as authority loss.

## Affected flow

`/v1/viewer` is a dedicated transient frame transport, not the ordinary App
relay. Its worker, Router, Web client, and WebSocket bounds must derive from one
20 MiB raw-frame contract while retaining smaller control-message bounds.

## Repair requirements

- Define one shared 20 MiB raw PNG frame maximum and one derived serialized
  envelope maximum that includes base64 expansion and bounded JSON overhead.
- Use the dedicated viewer response bound only for validated frame responses.
  Keep ordinary worker control responses and the ordinary App relay at their
  existing independent bounds.
- Reject raw frames above 20 MiB before base64 transport. Do not compress, retry,
  downscale, chunk, or fall back to another transport.
- Treat an oversized frame as a bounded frame error and release viewer authority
  according to the settled lifecycle; never retain a partial or queued frame.
- Add exact boundary tests at 20 MiB raw, one byte over, and serialized envelope
  overhead through worker, Router, Web service, and WebSocket send admission.

## Done when

- Every valid raw PNG frame through 20 MiB can traverse the dedicated hosted
  viewer path.
- A frame one byte over the raw limit is rejected deterministically without a
  second transport or retry.
- The ordinary 20 MiB App relay/control contract is unchanged.
- Focused size-boundary and transport tests pass.

## Depends on

[Bound and prioritize hosted viewer transport](06c-bound-and-prioritize-hosted-viewer-transport.md).
