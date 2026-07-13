```text
+------------------------------------------------------------------+
|  _  __        _             _             ___                     |
| | |/ /___ ___| |_ _ _ ___  | |   ___ ___ / _ \ _ _  ___          |
| | ' </ -_|_-<  _| '_/ -_) | |__/ _ / _ \\ (_) | ' \/ -_)         |
| |_|\_\___/__/\__|_| \___| |____\___\___/\___/|_||_\___|         |
|                                                                  |
|                Lumi Corp Starter Application Template             |
+------------------------------------------------------------------+
```

# Kestrel One

Kestrel One is Lumi Corp's application platform: one Next.js application that combines:
- account, organization, org billing, passkey, 2FA, and personal API-key flows
- Chatbot-style conversation UX with canonical chat APIs
- Knowledge-agent source management, sync, snapshot, document upload/RAG, and admin operations

Built with **Next.js 16**, **PostgreSQL**, **Redis**, and **shadcn/ui**.

In the Kestrel monorepo, this app lives at `apps/web` and uses the Kestrel runner service as the canonical chat execution boundary. The imported local AI SDK loop remains only as legacy migration scaffolding for non-chat surfaces that still depend on it.

## Features

- Email and password authentication
- Organizations, roles, and active-org context
- Passkeys, 2FA, password reset, and email verification
- Personal API keys
- Organization-owned Stripe billing controls in the Organizations surface
- Chat, sharing, uploads/files, and artifacts
- Knowledge source management, OCR/import, sync, snapshot state, and org-shared document upload
- Admin users, Stripe ops diagnostics, logs, stats, sandbox, API keys, docs, and agent configuration

## Quick Start

```bash
pnpm install
pnpm run web:dev
```

`pnpm dev:all`:
- starts Docker Compose infra (`pgvector` Postgres, Redis, MinIO)
- verifies service health and pgvector availability
- applies migrations
- ensures the dev admin exists
- generates the checked-in RAG fixtures
- starts the app on `127.0.0.1:43103` using webpack-backed, polling watch mode for local stability

It now uses `.env.example` as a baseline for local defaults, then overlays `.env` and `.env.local` when present. Keep a real `BETTER_AUTH_SECRET` in `.env.local` before committing or deploying.

For local browser flows, `DEV_AUTH_BYPASS=true` only works on `localhost`/`127.0.0.1`. API routes still require a real session or API key, so smoke tests and direct HTTP clients continue to receive `401`/`403` when appropriate.

Kestrel One declares exact released versions of `@kestrel-agents/sdk` and `@kestrel-agents/next`. Repository-root commands build the matching workspace packages before invoking the app, while Kestrel One's own scripts contain no sibling-package filters or source imports. `pnpm run check:kestrel-boundary` enforces that standalone contract.

Public-repo defaults:
- `pnpm dev:all` seeds a local-only admin for development, but there is no automatic first-user production admin bootstrap.
- Billing is opt-in. Set `NEXT_PUBLIC_BILLING_ENABLED=true` only after configuring all required Stripe env vars for org-owned subscriptions.
- `ADMIN_USER_IDS` is empty by default; no hardcoded public admin IDs ship with the repo.

## Local Dev

```bash
# optional: initialize a writable local env override
cp .env.example .env.local

# start the app from the monorepo root
pnpm run web:dev

# run smoke checks against Compose infra + app
pnpm smoke:local

# run the knowledge RAG fixture suite
pnpm test:knowledge-rag:unit

# clear stale Next.js/Turbopack + TS cache after moving or renaming the repo
pnpm clean
```

Default local infra:

```env
LOCAL_POSTGRES_PORT=58432
LOCAL_REDIS_PORT=56379
LOCAL_MINIO_API_PORT=59000
LOCAL_MINIO_CONSOLE_PORT=59001
POSTGRES_URL=postgresql://postgres:postgres@127.0.0.1:58432/better_auth
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:58432/better_auth
REDIS_URL=redis://127.0.0.1:56379
STORAGE_PROVIDER=local-s3
STORAGE_BUCKET=unified-app-storage
STORAGE_REGION=us-east-1
STORAGE_ENDPOINT=http://127.0.0.1:59000
STORAGE_ACCESS_KEY_ID=minioadmin
STORAGE_SECRET_ACCESS_KEY=minioadmin
STORAGE_FORCE_PATH_STYLE=true
BETTER_AUTH_URL=http://127.0.0.1:43103
NEXT_PUBLIC_APP_URL=http://127.0.0.1:43103
KESTREL_ENVIRONMENTS_ENABLED=true
KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY=replace-with-ed25519-private-key-pem
KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY=replace-with-ed25519-public-key-pem
FLY_API_TOKEN=FlyV1...
KESTREL_FLY_ORGANIZATION_SLUG=your-fly-organization
KESTREL_ENVIRONMENT_ROUTER_IMAGE=registry.fly.io/kestrel-environment-router@sha256:...
KESTREL_WORKSPACE_RUNTIME_IMAGE=registry.fly.io/kestrel-workspace@sha256:...
KESTREL_MCP_GATEWAY_URL=https://mcp.internal.example/mcp
KESTREL_MCP_CREDENTIAL_ACTIVE_KEY_ID=primary
KESTREL_MCP_CREDENTIAL_KEYS={"primary":"replace-with-base64-32-byte-key"}
KESTREL_ONE_PROFILE_ID=kestrel-one
NEXT_PUBLIC_BILLING_ENABLED=false
```

Requirements:
- Docker with Docker Compose
- PostgreSQL client tools (`psql`)
- curl

## Document Knowledge Infra

Uploaded knowledge uses a separate org-scoped document pipeline from the existing GitHub/YouTube snapshot sync.

- Raw binaries are stored through the shared `StorageAdapter`.
- Local development defaults to MinIO via `STORAGE_PROVIDER=local-s3`.
- Metadata, ingestion runs, chunks, and embeddings live in Postgres with `pgvector`.
- `pg-boss` is used for queued document ingestion and reindexing.
- Chat uses the `searchKnowledgeDocuments` tool to retrieve grouped excerpts and app-owned download links.

Document lifecycle:

1. Upload a file from `/knowledge` or promote a chat attachment.
2. Store the original object in MinIO/S3-compatible storage.
3. Create a `knowledge_documents` row and queue an ingestion run.
4. Extract text by media type, chunk, embed, and persist chunk provenance.
5. Surface citations back to chat with `/api/knowledge/documents/[id]/download` links.

Operational statuses:

- `uploaded`: stored but not yet being processed
- `processing`: an ingestion run is active
- `ready`: extracted and searchable
- `partial`: stored and partially indexed, usually with warnings
- `failed`: stored but indexing failed

## Route Model

- `/`
- `/sign-in`
- `/forget-password`
- `/reset-password`
- `/two-factor`
- `/two-factor/otp`
- `/accept-invitation/[id]`
- `/chat`
- `/chat/[id]`
- `/knowledge`
- `/knowledge/import`
- `/dashboard/*`
- `/admin/*`
- `/debug/*`
- `/shared/[token]`

Removed from the supported core product surface:
- `/device/*`
- `/oauth/authorize`
- legacy `(chat)/api/*` compatibility routes

## Canonical APIs

- `/api/chats`
- `/api/chats/[id]`
- `/api/chats/[id]/share`
- `/api/chats/[id]/stream`
- `/api/upload/[chatId]`
- `/api/files/[...pathname]`
- `/api/messages/[id]/feedback`
- `/api/messages/[id]/speech`
- `/api/shared/[token]`
- `/api/sources`
- `/api/sources/[id]`
- `/api/sources/ocr`
- `/api/sync`
- `/api/sync/[source]`
- `/api/knowledge/documents`
- `/api/knowledge/documents/[id]`
- `/api/knowledge/documents/[id]/reindex`
- `/api/knowledge/documents/[id]/download`
- `/api/knowledge/documents/promote`
- `/api/knowledge/documents/search`
- `/api/sandbox/shell`
- `/api/sandbox/snapshot`
- `/api/snapshot/status`
- `/api/snapshot/config`
- `/api/snapshot/sync`
- `/api/stats`
- `/api/stats/me`
- `/api/stats/usage`
- `/api/agent-config`
- `/api/agent-config/public`
- `/api/tools/runtime`
- `/api/admin/*`

## Project Structure

```text
app/
  (auth)/              authentication pages
  (chat)/              authenticated chat pages
  dashboard/           account, orgs, org billing, personal API keys
  knowledge/           Kestrel One knowledge dashboard
  admin/               operational admin pages
  shared/              public shared chats
  api/                 canonical API surface

components/
  admin/               shared admin and operational UI
  chatbot/             main chat UI
  ui/                  shared design system primitives

content/
  admin-docs/          local markdown docs rendered in-app

drizzle/
  schema.ts            auth + Kestrel One schema

lib/
  agent/               Kestrel One chat and agent runtime
  artifacts/           artifact persistence and helpers
  auth.ts              authentication server config
  auth-client.ts       authentication client config
  files/               transient chat upload storage helpers
  storage/             shared object-storage adapter and provider selection
  knowledge/           knowledge APIs, auth guards, sync, document ingestion, sandbox, snapshot helpers

scripts/
  dev-all.sh           Compose-first local dev orchestrator
  create-dev-admin.ts  dev user/org seeding
  smoke-local.sh       local infra + API smoke checks
```

## Auth Scope

Enabled:
- organizations
- passkeys
- 2FA
- API keys
- Stripe-backed organization subscriptions when billing is explicitly enabled and configured
- multi-session
- admin role support

Not part of the final core product:
- social auth providers
- device authorization
- OAuth consent UI
- SSO/OIDC/SAML runtime flows

## Testing

```bash
pnpm run web:typecheck
pnpm run web:test
pnpm --filter @kestrel/kestrel-one test:knowledge-rag:unit
pnpm --filter @kestrel/kestrel-one smoke:local
```

The Playwright suite covers authenticated chat, admin, knowledge, sharing, API-key flows, and the checked-in knowledge RAG fixture corpus.

## Docs

Admin docs now complement the live bot setup surface at `/admin/tools`. GitHub webhook handling and Discord guild/gateway configuration both run against the same org-scoped knowledge snapshots used by web chat.

Additional references:

- `../../docs/references/kestrel-one-production-readiness-evidence.md` for repo-grounded readiness evidence across auth, runner, storage, Redis, Postgres, pgvector, billing, and knowledge-tool audit surfaces
- `content/admin-docs/knowledge-library.md` for operator guidance on storage, queueing, and troubleshooting
- `docs/knowledge-library-user-guide.md` for the upload/search/citation user workflow
