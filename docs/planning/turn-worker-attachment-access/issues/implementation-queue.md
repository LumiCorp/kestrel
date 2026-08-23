# Turn Worker Attachment Access Implementation Queue

Each issue appears in one state. `Ready` is the current dependency-free frontier. Move issues between states as implementation and review change the graph.

## Ready

None.

## In progress

None.

## Blocked

- [Resolve each active turn's attachments at the web storage boundary](02-add-turn-attachment-resolver.md) — blocked by [Make blob availability durable across every byte consumer](01-enforce-durable-blob-availability.md)
- [Run hosted turns with verified remote attachments and safe failures](03-run-hosted-turns-with-remote-attachments.md) — blocked by [Resolve each active turn's attachments at the web storage boundary](02-add-turn-attachment-resolver.md)

## Implemented

- [Make blob availability durable across every byte consumer](01-enforce-durable-blob-availability.md)
- [Inventory file availability through a valid blob join](04-repair-availability-inventory-join.md)
- [Register the blob availability migration with the deployed runner](05-register-availability-migration.md)
- [Expose audited operator repair for missing file blobs](06-expose-audited-blob-repair.md)

## Done

None.
