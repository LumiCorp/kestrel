---
id: kestrel-one-production-readiness-evidence
domain: apps
status: active
owner: kestrel-one
last_verified_at: 2026-06-30
depends_on:
  - ../../apps/web/README.md
  - ../../apps/web/app/__tests__/route-ownership.manifest.test.ts
  - ../../apps/web/lib/billing/config.test.ts
  - ../../apps/web/lib/billing/access.test.ts
  - ../../apps/web/lib/db/runtime.test.ts
  - ../../apps/web/lib/agent/kestrel-runtime-streaming-proof.test.ts
  - ../../apps/web/lib/agent/kestrel-knowledge-tool-observability.test.ts
---

# Kestrel-One Production Readiness Evidence

This note records the current production-readiness evidence for
[Kestrel-One](../../apps/web/README.md). It is evidence for the
remaining backlog closeout, not a claim that every deployment environment is
already configured.

## Runtime Boundary

- Chat execution uses the Kestrel runner-service boundary as the canonical path,
  with legacy local AI SDK loop usage kept as migration scaffolding.
- Streaming proof covers primary stream, reconnect, failed/cancelled terminal
  text, and persisted final-answer behavior in
  `apps/web/lib/agent/kestrel-runtime-streaming-proof.test.ts`.
- Route ownership tests verify runner-bound APIs are classified and protected in
  `apps/web/app/__tests__/route-ownership.manifest.test.ts`.

## Readiness Surfaces

| Area | Current Evidence | Validation |
| --- | --- | --- |
| Auth | Better Auth server/client config, authenticated route manifest, API key support, passkey/2FA routes. | `app/__tests__/route-ownership.manifest.test.ts`; `lib/auth.ts`; `lib/auth-client.ts`. |
| Runner | App README documents runner-service execution; runtime streaming proof covers terminal states and persistence. | `lib/agent/kestrel-runtime-streaming-proof.test.ts`. |
| Storage | README documents `STORAGE_PROVIDER=local-s3`, MinIO/S3 object storage, and document download routes. | `lib/storage/*`; knowledge document route tests. |
| Redis | README local setup starts Redis with the app infra stack. | `docker-compose.yml`; `scripts/bootstrap.ts`. |
| Postgres | README local setup starts pgvector Postgres; runtime DB error classification exists. | `lib/db/runtime.test.ts`; `lib/db/migrate.ts`. |
| pgvector | Knowledge document chunks and embeddings are stored in Postgres with pgvector. | `lib/knowledge/documents/retrieval.test.ts`; `tests/fixtures/knowledge-rag/fixture-corpus.test.ts`. |
| Billing | Billing is explicitly config-gated and organization-role guarded. | `lib/billing/config.test.ts`; `lib/billing/access.test.ts`; admin billing page. |
| Knowledge Tool Audit | Knowledge search logs tenant/org, correlation, query length, result count, latency, and failure class without default query text logging. | `lib/agent/kestrel-knowledge-tool-observability.test.ts`. |

## Closeout Checks

Use these checks when closing Kestrel-One readiness work:

```bash
pnpm run web:test
pnpm run web:typecheck
pnpm run check:docs
```

If a deployment readiness claim depends on live infrastructure, verify it with
the Kestrel-One bootstrap/smoke scripts in the target environment rather than
promoting this repo evidence as deployment proof.
