# Owner and Admin Work Context on the Estate Map

Owners and admins need operational accountability without turning the map into a view of private conversation content.

## What to build

Add people context to Systems Map. Selecting a member shows their related Projects, active work count, failed work count, and total Thread count. The view should make the relationship between a person, their Projects, and active Kestrel work understandable from the estate diagram.

Do not expose Thread titles, message content, or historical run details. Keep the map focused on current operational context and preserve the existing owner/admin visibility boundary.

## Done when

- An owner or admin can select a member and see their related Projects plus aggregate Thread and work counts.
- The map does not reveal Thread titles, messages, or run-history detail.
- Member relationships remain scoped to the active Organization.
- Empty and inactive member states are understandable.
- Tests cover organization isolation and aggregate-only person context.

## Depends on

[Reusable Estate Canvas and Organization Systems Map](living-estate-map-canvas.md)
