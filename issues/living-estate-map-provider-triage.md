# Provider-Confirmed Estate State and Triage

The map must remain useful when provider information is delayed or unavailable, while never presenting stale information as current.

## What to build

Connect Systems Map to the existing Fly Environment provider boundary. Refresh provider state when the map opens and when an Environment is selected.

Show provider-confirmed machine and volume details alongside Kestrel's known topology. Make degraded, failed, and mismatched resources immediately visible in the whole-estate view, so the default experience answers "what is broken now?"

When refresh fails, keep the last known topology on the map, show when it was last confirmed, and explain that live provider state could not be refreshed. Do not remove affected resources or replace them with an empty diagram.

## Done when

- Opening the map and selecting an Environment refreshes Fly-backed state through the existing trusted provider boundary.
- A degraded Environment visibly identifies its affected controlled resources from the bird's-eye view.
- Provider refresh failure preserves last-known topology and communicates its freshness without implying live confirmation.
- Provider credentials and sensitive values never reach the browser.
- Tests cover successful refresh, provider failure with retained topology, and mismatched or missing resources.

## Depends on

[Reusable Estate Canvas and Organization Systems Map](living-estate-map-canvas.md)
