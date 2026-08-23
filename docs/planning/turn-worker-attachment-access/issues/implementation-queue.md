# Turn Worker Attachment Access Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free frontier. Move issues between states as implementation and review change the graph.

## Ready

- [Resolve each active turn's attachments at the web storage boundary](02-add-turn-attachment-resolver.md)

## In progress

None.

## Blocked

- [Run hosted turns with verified remote attachments and safe failures](03-run-hosted-turns-with-remote-attachments.md) — blocked by [Resolve each active turn's attachments at the web storage boundary](02-add-turn-attachment-resolver.md)

## Implemented

- [Make blob availability durable across every byte consumer](01-enforce-durable-blob-availability.md)

## Done

None.
