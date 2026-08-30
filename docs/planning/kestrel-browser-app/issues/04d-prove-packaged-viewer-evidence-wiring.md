# Prove packaged viewer evidence wiring

## Failed behavior

Issue 04a's tests construct `LocalCoreDesktopBrowserViewerEventSink` directly and inject synthetic events. They do not construct the packaged `DesktopBrowserService` or drive lifecycle transitions through its production composition, so deleting the actual `viewerEvents` wiring would leave the evidence tests green.

## Affected flow

`createPackagedDesktopBrowserService` owns packaged Browser composition. The Local Core API test seam owns proof of that composition. The repair is proof-oriented and must not add a second event path or weaken the metadata-only sink.

## Repair requirements

- Exercise the real packaged Browser service composition with staged engine and Chrome executable fixtures.
- Obtain the composed Browser service through a production-shaped Local Core seam rather than constructing the sink directly.
- Drive representative request, acceptance, lease, disconnect or return, authorization-loss, and cleanup transitions through the service.
- Close the composed service and prove accepted records flush to the real diagnostic store.
- Retain hostile structural-field and unique password/MFA sentinel assertions against the durable representation.

## Done when

- Removing `viewerEvents` from packaged composition fails the test.
- Real service transitions create the expected ordered metadata-only records.
- Viewer input, frames, secrets, URLs, engine, proxy, and debugging data remain absent.
- Sink failure is silent and non-fatal through the production composition.
- Focused Local Core API, Desktop Browser service, diagnostic-store, and secret-redaction tests pass.

## Depends on

None.
