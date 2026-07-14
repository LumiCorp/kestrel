# Compose-First Local Dev Design

## Summary

Adopt a single local development model for Kestrel One:

- Docker Compose owns all shared infra: pgvector Postgres, Redis, and MinIO.
- The Next.js app still runs on the host for fast reloads.
- `.env.local` points at the Compose-managed localhost services.
- `pnpm dev:all` becomes the canonical startup path.
- `pnpm smoke:local` validates the same stack without fallback behavior.

## Runtime Model

- Compose services:
  - Postgres with pgvector on `127.0.0.1:58432`
  - Redis on `127.0.0.1:56379`
  - MinIO on `127.0.0.1:59000`
- Host process:
  - Next dev server on `127.0.0.1:3100`

## Configuration

`.env.local` should define:

- `POSTGRES_URL` and `DATABASE_URL`
- `REDIS_URL`
- `STORAGE_PROVIDER=local-s3`
- `STORAGE_BUCKET`, `STORAGE_ENDPOINT`, `STORAGE_REGION`
- `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`
- `STORAGE_FORCE_PATH_STYLE=true`
- `NEXT_PUBLIC_APP_URL` and `BETTER_AUTH_URL`
- existing AI credentials and dev admin settings

## Orchestration

`pnpm dev:all` should:

1. Load local env
2. Require Docker
3. Start Compose infra
4. Wait for Postgres, Redis, and MinIO readiness
5. Verify pgvector availability
6. Run migrations
7. Seed the dev admin
8. Generate RAG fixtures
9. Start Next
10. Wait for `/api/health`
11. Start and supervise the durable turn worker

`pnpm smoke:local` should:

1. Require Docker
2. Confirm Compose infra is up
3. Validate Postgres, Redis, MinIO, and pgvector
4. Validate app health and auth guard behavior

## Failure Behavior

- Missing Docker: fail immediately with a direct instruction.
- Missing pgvector: fail before migrations with a precise message.
- MinIO or Redis unavailable: fail before app startup.
- No fallback to ad hoc local infra in this mode.
