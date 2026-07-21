# Kestrel One

Kestrel One is the hosted team product for durable agent work. It brings
conversations, shared project context, files, Knowledge, artifacts, access
control, and managed model access into one application while the Kestrel runner
service remains the canonical execution boundary.

This app is built with Next.js 16, PostgreSQL, Redis, object storage, and the
public Kestrel packages. It lives at `apps/web` in the monorepo.

> Kestrel One is available to invited Beta organizations. This README is for
> contributors and operators running the application from source. Product users
> should start with the [Kestrel One guide](../docs/content/apps/web.mdx).

## Product Model

- **Organizations** own membership, billing, model access, Knowledge, and
  administrative policy.
- **Environments** own execution capacity, installed Apps/MCP services, and
  environment-scoped credentials.
- **Projects** group members, instructions, files, Knowledge context, Apps, and
  related Threads.
- **Threads** are durable conversations and work histories, either standalone
  or attached to a Project.
- **Turns and runs** execute through the Kestrel runner boundary and preserve
  progress, tool activity, interactions, terminal results, and artifacts.

`app/route-ownership.manifest.ts` is the source of truth for route ownership,
access, and unauthorized behavior. Product code must not infer authority from
the visual route alone.

## Capabilities

- durable standalone and Project Threads
- Projects with revisioned context, members, files, Apps, and Knowledge
- organization-scoped Knowledge ingestion, OCR/import, search, and citations
- sharing and persisted artifacts
- organization model gateways and feature-gated managed deployments
- email/password, passkeys, 2FA, invitations, password reset, and API keys
- organization-owned billing controls when explicitly enabled
- administrative diagnostics, logs, stats, sandbox, model, and access surfaces
- mobile companion APIs over the same hosted Thread and Project state

## Quick Start

For the complete local stack, use the app's orchestrated development command
from the repository root:

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @kestrel/kestrel-one dev:all
```

Requirements: Docker with Docker Compose, PostgreSQL client tools (`psql`), and
`curl`. Replace the placeholder `BETTER_AUTH_SECRET` in `.env.local` before
starting.

`dev:all`:
- starts Docker Compose infra (`pgvector` Postgres, Redis, MinIO)
- verifies service health and pgvector availability
- applies migrations
- applies the local Environment runtime schema migrations
- ensures the dev admin exists
- generates the checked-in RAG fixtures
- starts a local Environment runtime on `127.0.0.1:43106`
- starts the app on `127.0.0.1:43103` using webpack-backed, polling watch mode for local stability
- starts and supervises the durable turn worker so queued thread turns run locally

It uses `.env.example` as a baseline for local defaults, then overlays `.env`
and `.env.local` when present. When no override is provided, `REDIS_URL` points
at the bundled Compose Redis instance. Never commit the populated override.

Hosted Environments are enabled by default for the deployment and for organizations without an explicit rollout override. The local `dev:all` flow selects the local Environment runtime, which needs no Fly credentials, signing keys, image references, or backup keys. Deployed instances use the Fly runtime by default and fail closed unless its immutable image, ticket-key, backup-key, and service-token values are complete. Set `KESTREL_ENVIRONMENTS_ENABLED=false` only as an emergency or staged-rollout off switch.

The local Environment runtime uses a separate `kestrel_runtime` database in the bundled Postgres service so its runtime schema cannot collide with Kestrel One's application schema. Set `KESTREL_RUNNER_DATABASE_URL` only when you intentionally want a different local runtime database.

For local browser flows, `DEV_AUTH_BYPASS=true` only works on `localhost`/`127.0.0.1`. API routes still require a real session or API key, so smoke tests and direct HTTP clients continue to receive `401`/`403` when appropriate.

Kestrel One declares exact released versions of `@kestrel-agents/sdk` and `@kestrel-agents/next`. Repository-root commands build the matching workspace packages before invoking the app, while Kestrel One's own scripts contain no sibling-package filters or source imports. `pnpm run check:kestrel-boundary` enforces that standalone contract.

Public-repo defaults:
- `dev:all` seeds a local-only admin for development, but there is no automatic first-user production admin bootstrap.
- Billing is opt-in. Set `NEXT_PUBLIC_BILLING_ENABLED=true` only after configuring all required Stripe env vars for org-owned subscriptions.
- `ADMIN_USER_IDS` is empty by default; no hardcoded public admin IDs ship with the repo.

## RunPod Serverless models

Administrators can add an existing RunPod Serverless vLLM endpoint from
`/admin/gateways`. Supply its endpoint ID and either paste a credential for
encrypted storage or configure `RUNPOD_API_KEY`. Kestrel derives the canonical
`https://api.runpod.ai/v2/{endpointId}/openai/v1` URL; arbitrary endpoints and
RunPod Pod lifecycle management are not supported by the unmanaged gateway
flow.

Managed RunPod deployments are separately gated by
`RUNPOD_MANAGED_DEPLOYMENTS_ENABLED`. When enabled, platform administrators can
qualify immutable digest-pinned Serverless vLLM profiles, enable organization
quotas, and allow entitled members to launch organization-owned endpoints from
those profiles. Managed endpoints remain unavailable until the expected model passes
the same streaming and tool-result validation as externally configured RunPod
gateways. Raw Pods, arbitrary images, user-controlled infrastructure fields, and
customer billing are outside this release.

Synced models start unapproved. Each language model must pass the admin
connection test, which verifies OpenAI-compatible streaming plus a complete
tool-call/tool-result round trip, before it can be approved for chat.

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
CRON_SECRET=replace-with-random-secret
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
- `/threads`
- `/threads/new`
- `/threads/[id]`
- `/projects`
- `/projects/[id]`
- `/projects/[id]/threads/new`
- `/search`
- `/model-deployments`
- `/knowledge`
- `/knowledge/import`
- `/dashboard/*`
- `/admin/*`
- `/debug/*`
- `/shared/[token]`

Removed from the supported core product surface:
- legacy chat-shaped page routes
- `/device/*`
- `/oauth/authorize`
- legacy `(chat)/api/*` compatibility routes

## Canonical APIs

- `/api/threads`
- `/api/threads/[id]`
- `/api/threads/[id]/share`
- `/api/threads/[id]/stream`
- `/api/threads/[id]/uploads`
- `/api/projects`
- `/api/projects/[id]`
- `/api/projects/[id]/context`
- `/api/projects/[id]/files`
- `/api/projects/[id]/members`
- `/api/model-deployments`
- `/api/model-deployments/[id]`
- `/api/model-deployments/access`
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
- `/api/runtime/apps`
- `/api/admin/*`

## Project Structure

```text
app/
  (auth)/              authentication pages
  (workspace)/         authenticated Threads, Projects, search, and model deployments
  dashboard/           account, orgs, org billing, personal API keys
  knowledge/           Kestrel One knowledge dashboard
  admin/               operational admin pages
  shared/              public shared threads
  api/                 canonical API surface

components/
  admin/               shared admin and operational UI
  chatbot/             thread conversation UI
  ui/                  shared design system primitives

content/
  admin-docs/          local markdown docs rendered in-app

drizzle/
  schema.ts            auth + Kestrel One schema

lib/
  agent/               Kestrel One thread and agent runtime
  artifacts/           artifact persistence and helpers
  auth.ts              authentication server config
  auth-client.ts       authentication client config
  files/               thread and project upload storage helpers
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
pnpm --filter @kestrel/kestrel-one typecheck:self
pnpm --filter @kestrel/kestrel-one test:unit
pnpm --filter @kestrel/kestrel-one test:knowledge-rag:unit
pnpm --filter @kestrel/kestrel-one smoke:local
```

The portable Chromium contract retains two full journeys: completed persisted
turn reload and waiting-prompt reload/resume. Database behavior is proved at
the PostgreSQL boundary, and API policy is proved by fast route tests. Run
`pnpm validate` at the repository root for pull-request readiness.

## Docs

Admin docs describe the remaining deployment-managed bot adapters. Agent-facing
services and capabilities are discovered and governed through `/apps`, while
GitHub webhook handling and Discord messaging continue to use the same
organization-scoped knowledge snapshots as web chat.

Additional references:

- `content/admin-docs/knowledge-library.md` for operator guidance on storage, queueing, and troubleshooting
- `docs/knowledge-library-user-guide.md` for the upload/search/citation user workflow
