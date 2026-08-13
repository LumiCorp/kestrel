---
id: developer-onboarding-reader
domain: docs
status: active
owner: kestrel-quality
last_verified_at: 2026-08-13
depends_on: [../../ARCHITECTURE.md, ../../DESIGN.md, ../../RELIABILITY.md, ../../SECURITY.md, ../index.md]
---

# Kestrel Developer Onboarding Reader

The [developer onboarding reader](index.html) is the repository's detailed,
source-linked introduction to Kestrel's product model, architecture, execution
paths, trust boundaries, persistence model, reliability contracts, and
contributor workflow. It is written for engineers and agents that need to
understand ownership before changing the monorepo.

Open `docs/developer-onboarding/index.html` in a browser. The reader is a
self-contained HTML document except for the SVGs in [`assets/`](assets). Use
the left navigation or search to move among its 110 reading units. A unit can
also be isolated with a query such as `index.html?focus=37`.

## What Is Included

- 110 independently planned reading units across 12 parts
- product, runtime, deployment, persistence, security, and execution maps
- developer rules and common failure modes for each concept
- source excerpts and line-ranged links into the owning repository files
- focused reader mode for linking an engineer or agent to one concept

## Documentation Status

This is an internal onboarding and architecture-navigation artifact. It does
not enter the public docs application or its navigation. The current contracts
remain in the linked code, root truth documents, package documentation, and
curated public docs sources.

The reader was last reconciled with the repository on 2026-08-13. A cited
excerpt is orientation, not authority when it conflicts with newer owning
source.

## Maintenance Contract

When a change affects a concept represented here:

1. Update the affected reader unit's explanation, developer rule, and failure
   mode.
2. Update its diagram, table, flow, or record anatomy to encode the new
   relationship precisely.
3. Refresh all cited line ranges and verify that every repository-relative link
   resolves from this folder.
4. Check the complete reader at desktop width and the affected focused unit at
   a narrow reader width.

Run the portable structural and citation check from the repository root:

```bash
node docs/developer-onboarding/check.mjs
```

Keep the HTML portable. Do not add workstation-specific `file://` paths,
external runtime dependencies, secrets, live credentials, or generated
execution evidence.
