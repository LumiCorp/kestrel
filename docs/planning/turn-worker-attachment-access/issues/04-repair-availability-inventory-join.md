# Inventory file availability through a valid blob join

## Failed behavior

Thread file inventory selects `file_blobs` availability and object fields without joining `file_blobs`. PostgreSQL rejects the query with a missing `FROM`-clause entry, so the inventory path fails for every caller, including durable turn setup that reads inventory-related file context.

## Affected work

This blocks [Make blob availability durable across every byte consumer](01-enforce-durable-blob-availability.md), introduced in local commit `74135b144`. The owning path is `apps/web/lib/files/service.ts:listThreadFileInventory`, which now projects `schema.fileBlobs.*` and calls the shared availability check.

## Repair requirements

The inventory query must return the file and shared blob fields through a valid `kestrelFiles.blobId = fileBlobs.id` relationship. It must continue enforcing Thread authorization and effective availability, preserve ordering and limits, and keep missing or temporary blob outcomes distinct.

## Done when

- Thread inventory executes successfully against PostgreSQL with the availability projection enabled.
- A PostgreSQL regression test covers the joined query and proves a missing shared blob blocks inventory without deleting file or grant evidence.
- Durable turn paths that depend on file inventory no longer fail with a SQL missing-`FROM` error.
- The original issue 01 availability and non-destructive state guarantees remain intact.

## Depends on

None.
