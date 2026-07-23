# Knowledge Library

The Knowledge Library is the organization’s shared, document-backed retrieval system. GitHub is an App/workspace integration, not a Knowledge source.

## Local infra

Local development expects these services from `docker-compose.yml`:

- Postgres from `pgvector/pgvector:pg16`
- Redis for background jobs and existing chat/runtime features
- MinIO for S3-compatible object storage
- `minio-init` to create the `unified-app-storage` bucket

Recommended local entrypoint:

```bash
pnpm dev:all
```

That script starts Compose, waits for Postgres, Redis, and MinIO, verifies `pgvector`, runs migrations, seeds the dev admin, generates RAG fixtures, and launches Next.js.

## Storage model

- Chat attachments and uploaded knowledge documents both go through the shared `StorageAdapter`.
- Local development uses `STORAGE_PROVIDER=local-s3`, which points the adapter at MinIO.
- Production can switch to `s3` or `r2` without changing the rest of the document pipeline.
- App-owned download routes remain canonical even when a backend can generate signed URLs.

## Document lifecycle

1. A user uploads a file from `/knowledge`, or promotes a chat attachment into shared knowledge.
2. The original file is stored in object storage.
3. A `knowledge_documents` row is created in Postgres.
4. A `knowledge_ingestion_runs` job is queued with `pg-boss`.
5. The worker extracts text, chunks it, embeds it, and writes `knowledge_document_chunks`.
6. Chat retrieval uses `searchKnowledgeDocuments` and returns grouped excerpts with `/api/knowledge/documents/[id]/download` references.

## Document states

- `uploaded`: the object is stored and waiting to be processed
- `processing`: the ingestion worker is active
- `ready`: searchable and citation-ready
- `partial`: stored and partially indexed, usually with warnings
- `failed`: stored but not indexed successfully

## Permissions

- Any active org member can upload shared documents.
- The uploader can reindex or delete their own documents.
- Admins can manage every document in the active organization.
- Any org member can open document reference links that belong to their active organization.
- Chat-attachment promotion only accepts uploads owned by the current user.

## Troubleshooting

If uploads succeed but indexing does not:

- Check `/knowledge` for the latest document status and reindex if needed.
- Verify Postgres has `pgvector` available and migrations have been applied.
- Verify MinIO is healthy and the `unified-app-storage` bucket exists.

If search returns weak results:

- Confirm the document reached `ready` or `partial`.
- Inspect extraction warnings for sparse or empty text.
- Reindex after correcting a source document.
- Use the fixture suite in `tests/fixtures/knowledge-rag` to validate retrieval behavior before debugging live data.
