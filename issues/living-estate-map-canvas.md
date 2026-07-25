# Reusable Estate Canvas and Organization Systems Map

Owners and admins need a whole-estate view before they can triage it. Deliver the map as a reusable canvas module, then use it in Organization management for Kestrel-owned infrastructure.

## What to build

Create a reusable systems-canvas experience using the existing `@xyflow/react` foundation, rather than a page-specific diagram. It must support the map's shared interaction model: pan, zoom, fit-to-estate, icon-based nodes, relationship lines, selection, and a details panel.

Add **Systems Map** to Organization management. It shows the whole estate grouped by Environment and region, with Kestrel gateway, Workspaces, machines, and volumes. Selecting a node shows its known state and links to the existing Runtime, Workspaces, and Activity surfaces.

Use Kestrel's existing Environment and Workspace records as the initial authoritative topology. Preserve the current owner/admin access boundary. Show a useful empty estate and existing Environment-creation path when nothing has been provisioned.

## Done when

- An owner or admin can open Systems Map from Organization management and understand the complete Kestrel-controlled estate in one canvas.
- The canvas is reusable outside this page and does not contain lifecycle actions or editable diagram behavior.
- Environment, gateway, Workspace, machine, and volume relationships are visible with clear icons and selectable details.
- Empty, unauthorized, and normal estate states have focused coverage.
- Existing Organization management behavior remains intact.
