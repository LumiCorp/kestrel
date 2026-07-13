---
id: kestrel-one-environment-cutover-2026-07-13
domain: apps
status: active
owner: kestrel-one
last_verified_at: 2026-07-13
depends_on:
  - ../../apps/web/lib/environments/config.ts
  - ../../apps/web/lib/environments/cutover-readiness.ts
  - ../../apps/web/scripts/hosted-environment-preflight.ts
  - ../references/kestrel-one-environment-canary-evidence.md
---

# Kestrel One Environment Cutover

This runbook moves Kestrel One from its hosted global runner to
organization-owned Environments without changing Project, Thread, session, or
run identity. It deliberately separates schema migration, dark deployment,
Environment provisioning, GitHub OAuth proof, and execution cutover.

## Current Verified Baseline

- The production alias resolves to deployment
  `dpl_2kBBapN6rvcfH9kbz8nnjMqXRKNB`, built from commit `a3c2db92` before the
  Environment routes landed.
- The Fly canary evidence is recorded in
  [Kestrel One Environment canary evidence](../references/kestrel-one-environment-canary-evidence.md).
- The production project still has `KESTREL_RUNNER_SERVICE_URL` and
  `KESTREL_RUNNER_SERVICE_TOKEN` and does not yet have the complete Environment
  or GitHub OAuth configuration.
- `BETTER_AUTH_URL`, `NEXT_PUBLIC_APP_URL`, and `AI_AGENT_SITE_URL` all resolve
  to the verified canonical origin `https://kestrel-one-green.vercel.app`.
  Vercel resolves that alias to the current production deployment and the
  origin returns HTTP 200.
- The authenticated Fly organization is `personal`. Its only retained App is
  the legacy `kestrel-one-runner`; no managed organization Environment exists
  yet.
- A read-only production schema probe on 2026-07-13 confirmed that none of the
  required `environments`, `environment_workspaces`,
  `organization_feature_flags`, `user_tool_connections`,
  `user_tool_connection_resources`, or `github_action_approvals` relations
  exist yet. Migrations `0014` through `0017` remain one unapplied set.
- `apps/web` runs database migrations as the first part of `pnpm build`.
  Therefore, authorizing a production deployment also authorizes every pending
  migration unless migrations are applied explicitly first.
- Current production builds fail unless `KESTREL_ENVIRONMENTS_ENABLED` is
  explicitly `false` for preparation or `true` for cutover.

## Invariants

1. Take and verify a recoverable database backup before migration `0014`.
2. Keep `KESTREL_ENVIRONMENTS_ENABLED=false` and retain both legacy runner
   values during the dark deployment and Environment provisioning phases.
3. Use one Kestrel-owned GitHub **OAuth App**, not a GitHub App installation.
   Its callback is `<canonical-origin>/api/auth/callback/github`.
4. Never pull production secrets into a repository file. Vercel withholds
   sensitive values from `vercel env run`, so only the cloud production build
   preflight is authoritative for the complete secret set.
5. Enable the organization flag while the deployment flag is still false. This
   permits readiness inspection without routing user execution remotely.
6. Remove the legacy runner values only from the configuration used by the
   cutover deployment. The currently serving dark deployment retains its own
   legacy configuration until the new deployment is promoted.
7. Do not promote unless the final cutover preflight reports zero relational
   drift, zero active Environment executions, and a ready default Environment
   for every enabled organization.

## Phase 1: Provision Configuration Without Enabling Execution

Add these production values to the linked `lumi-kestrel/kestrel-one` project:

- `CRON_SECRET`
- `FLY_API_TOKEN`
- `KESTREL_FLY_ORGANIZATION_SLUG`
- `KESTREL_ENVIRONMENT_TICKET_PRIVATE_KEY`
- `KESTREL_ENVIRONMENT_TICKET_PUBLIC_KEY`
- `KESTREL_ENVIRONMENT_ROUTER_IMAGE`
- `KESTREL_WORKSPACE_RUNTIME_IMAGE`
- `KESTREL_WORKSPACE_BACKUP_KEY`
- `KESTREL_WORKSPACE_BACKUP_KEY_ID`
- `KESTREL_ONE_APP_URL`
- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `KESTREL_ENVIRONMENTS_ENABLED=false`

The ticket keys must be one matching Ed25519 pair. The backup key must be one
base64-encoded 32-byte key with a stable key ID. Both Fly images must use the
immutable digests recorded in the canary evidence. `KESTREL_ONE_APP_URL`,
`BETTER_AUTH_URL`, and `NEXT_PUBLIC_APP_URL` must have the same origin.

Create `FLY_API_TOKEN` as a bounded-expiry organization token scoped to the
`personal` Fly organization. Do not copy the operator's personal Fly login
token into Vercel. Create the GitHub credentials from one Kestrel-owned OAuth
App whose authorization callback is
`https://kestrel-one-green.vercel.app/api/auth/callback/github`.

Keep the existing credential-broker, tool-token, and gateway-encryption values.
Keep both legacy runner values during this phase.

## Phase 2: Authorize and Apply Migrations

Migration authorization covers `0014_hosted_environments.sql` through
`0017_github_action_approvals.sql`. After confirming the database backup:

```sh
vercel env run -e production --cwd apps/web -- pnpm db:migrate
```

The migration command does not receive the sensitive Environment values and is
not a configuration preflight. The subsequent unpromoted production build runs
the authoritative preparation preflight inside Vercel. That gate validates
runtime configuration, OAuth origins, and the presence of the Environment,
user OAuth, organization feature flag, and GitHub approval-ledger relations. It
intentionally permits the legacy runner when the deployment flag is false.

Stop if migration fails, a required relation is absent, or the backup cannot be
restored. Do not attempt the production deployment as a migration retry.

## Phase 3: Deploy Dark and Provision the Default Environment

Create an unpromoted production deployment while
`KESTREL_ENVIRONMENTS_ENABLED=false` and the legacy runner remains configured:

```sh
vercel --prod --skip-domain --cwd apps/web --scope lumi-kestrel
```

The production build must pass the hosted preparation preflight before Next.js
compilation. Inspect the returned deployment and its build logs. Promote it to
the canonical aliases only after that gate passes:

```sh
vercel inspect <candidate-url> --cwd apps/web --scope lumi-kestrel
vercel promote <candidate-url> --cwd apps/web --scope lumi-kestrel
```

Verify the authenticated `/admin/environments` surface, existing chat
execution through the legacy runner, and the GitHub linking surface. As an
organization administrator:

1. create an Environment in the explicitly selected Fly region;
2. wait for the gateway to become ready;
3. set it as the organization default;
4. enable the organization `hosted_environments` flag; and
5. confirm the rollout remains ineffective because the deployment flag is
   still false.

The reconciliation cron may provision the Environment during this phase, but
no Project or Thread execution may resolve through it yet.

## Phase 4: Prove User-Linked GitHub OAuth

Link GitHub from the signed-in user's settings page. GitHub is account linking,
not a Kestrel login method. Use an accessible repository for which the user has
pull and push permission, then run:

```sh
KESTREL_ONE_CANARY_URL=<canonical-origin> \
KESTREL_ONE_CANARY_COOKIE=<authenticated-cookie> \
KESTREL_ONE_CANARY_REPOSITORY=<owner/repository> \
pnpm --filter @kestrel/kestrel-one canary:github:oauth
```

The proof must show the linked provider login, synchronized repository
selection, and the actor's current pull and push permissions. The broad OAuth
token must remain encrypted in Kestrel One and absent from all Workspace,
Machine, response, and log surfaces. This OAuth canary does not claim that a
Git proxy fetch or candidate-bound push occurred; those are post-cutover
Workspace proofs.

## Phase 5: Preflight and Execute Cutover

Update the production project configuration for the next deployment:

1. set `KESTREL_ENVIRONMENTS_ENABLED=true`;
2. remove `KESTREL_RUNNER_SERVICE_URL`; and
3. remove `KESTREL_RUNNER_SERVICE_TOKEN`.

These changes do not alter the already-running dark deployment. Create another
unpromoted production deployment and retain the dark deployment ID as the
rollback target:

```sh
vercel --prod --skip-domain --cwd apps/web --scope lumi-kestrel
```

Because the deployment flag is now true, the cloud build runs the full cutover
preflight. It must report `ready: true` and reject any legacy runner value,
missing secret, missing migration relation, invalid binding, unready default
Environment, or active Environment execution. Inspect the candidate, then use
`vercel promote <candidate-url>` to assign the production aliases.

## Phase 6: Post-Cutover Evidence

Prove all of the following before declaring the cutover complete:

- a Project Thread and a standalone Thread retain their existing identities;
- each resolves through the enabled organization's default Environment;
- the first run lazily provisions the correct persistent Workspace;
- wake feedback progresses through queued, provisioning or waking, connecting,
  and ready states without reporting a false ready state;
- file editing, audited PTY input, candidate preview, private application
  supervision, managed-worktree isolation, and fingerprinted promotion work
  against that Workspace;
- stop and start preserve the filesystem;
- a user-linked repository can fetch and push only through the policy-enforcing
  Git proxy and action broker;
- the designated canary Thread has `issue.write` configured in `ask` mode, and
  the non-mutating approval-ledger canary succeeds:

  ```sh
  KESTREL_ONE_CANARY_URL=<canonical-origin> \
  KESTREL_ONE_CANARY_COOKIE=<authenticated-cookie> \
  KESTREL_ONE_CANARY_REPOSITORY=<owner/repository> \
  KESTREL_ONE_CANARY_THREAD_ID=<workspace-backed-thread-id> \
  pnpm --filter @kestrel/kestrel-one canary:github:approval
  ```

  The canary must emit the exact structured issue request, persist the
  initiating user's denial in the approval ledger, and leave the GitHub
  mutation unauthorized. It deliberately does not create an issue.
- denied, revoked, cross-tenant, and missing-consent GitHub requests fail
  closed; and
- no hosted execution reads either legacy runner value.

If any proof fails, roll back to the retained dark deployment, restore the two
legacy project values for subsequent builds, set
`KESTREL_ENVIRONMENTS_ENABLED=false`, and leave the organization flag disabled
until the failure is understood.
