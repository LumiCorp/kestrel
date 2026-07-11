# ASCII Hero Design

## Goal

Create a reusable ASCII rendering module for the landing page hero. The first scene uses a procedurally generated platonic solid instead of an impossible object or external 3D asset.

## Approach

- Build a standalone renderer under `lib/ascii-renderer`.
- Render a shaded platonic solid into an offscreen canvas.
- Convert the rendered frame into ASCII using shape-aware glyph matching.
- Animate by generating a sequence of frames and replaying them in a client component.

## Renderer Model

- Precompute glyph shape vectors from a curated ASCII set using region sampling.
- Sample each output cell using the same region layout.
- Match sampled vectors to the nearest glyph vector.
- Apply light contrast enhancement so edges and lit faces separate more clearly.

## Scene

- Use a procedurally generated icosahedron as the first hero scene.
- Apply slow rotation and subtle bobbing.
- Use filled faces with simple directional lighting rather than wireframe output.

## Landing Integration

- Keep the hero text sparse.
- Treat the ASCII object as the visual statement piece.
- Use a client component to generate and play frames while keeping the module reusable for later scenes.
