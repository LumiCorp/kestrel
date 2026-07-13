---
id: kestrel-one-gateway-authority-rollout
domain: operations
status: active
owner: kestrel-one
last_verified_at: 2026-07-12
depends_on:
  - SECURITY.md
  - RELIABILITY.md
  - deploy/fly/kestrel-one-runner/README.md
---

# Kestrel One gateway authority rollout

This runbook deploys only the gateway credential and managed-model authority work. The web release commit must be based on `d9c8cda4` plus reviewed gateway-only follow-up commits.

The rollout follows the repository's [security requirements](../../SECURITY.md), [reliability requirements](../../RELIABILITY.md), and [source-built Fly image contract](../../deploy/fly/kestrel-one-runner/README.md).

> Do not deploy current `main` through this runbook. Commit `0a859b61` added the backward-incompatible Threads/Projects migration `0013_threads_projects.sql`. Production still uses `chats` and `messages`; that cutover requires a writer stop, a restorable database snapshot, migration verification, and snapshot-based rollback.

## Fixed production targets

- Vercel project: `lumi-kestrel/kestrel-one`
- Production alias: `https://kestrel-one-green.vercel.app`
- Fly app: `kestrel-one-runner`
- Fly config: `deploy/fly/kestrel-one-runner/fly.toml`
- Pre-rollout Vercel rollback deployment: `dpl_2SjStYiWxaxp6mQ9VrfjyDsqPrRj`
- Pre-rollout Fly rollback image: `registry.fly.io/kestrel-one-runner:deployment-01KX8W98FNCFD36AFVAJ20VX1Z`

Record the live deployment ID and image digest again immediately before rollout. If either differs, use the newly observed values below rather than these historical references.

## 1. Prepare and validate the gateway release

Use a clean worktree on the gateway release branch. Record the exact source revision and prove that the Threads migration is absent.

```bash
RELEASE_SHA="$(git rev-parse HEAD)"
git merge-base --is-ancestor d9c8cda4 "$RELEASE_SHA"
test ! -e apps/web/lib/db/migrations/0013_threads_projects.sql
git status --short

CI=true pnpm install --frozen-lockfile
CI=true pnpm run governance:check
CI=true pnpm run test
CI=true pnpm run prompt-suite
CI=true pnpm run evals:release-check
```

Build and smoke the source-derived runner image. The final image must contain the deployed runtime and registry protocol dependency, not links back into the builder workspace.

```bash
IMAGE="kestrel-one-runner:${RELEASE_SHA}"
docker build \
  --file deploy/fly/kestrel-one-runner/Dockerfile \
  --build-arg "KESTREL_GIT_SHA=${RELEASE_SHA}" \
  --tag "$IMAGE" \
  .
EXPECTED_GIT_SHA="$RELEASE_SHA" \
  deploy/fly/kestrel-one-runner/smoke.sh "$IMAGE"
```

## 2. Record the live rollback state

```bash
fly status --app kestrel-one-runner --json
fly secrets list --app kestrel-one-runner --json
vercel inspect https://kestrel-one-green.vercel.app --scope lumi-kestrel
```

Record the current Vercel deployment ID, Fly image reference and digest, machine and volume IDs, and gateway counts from the next step.

## 3. Configure the broker and keyring

Link the clean release worktree to the existing Vercel project. Generate one broker token shared by Vercel and Fly, plus a 32-byte AES key used only by Vercel. These shell variables must never be printed or committed.

```bash
vercel link --yes --project kestrel-one --scope lumi-kestrel

BROKER_TOKEN="$(openssl rand -base64 48 | tr -d '\n')"
ACTIVE_KEY_ID="prod-v1"
ACTIVE_KEY="$(openssl rand -base64 32 | tr -d '\n')"
KEYRING="$(printf '{"%s":"%s"}' "$ACTIVE_KEY_ID" "$ACTIVE_KEY")"

printf '%s' "$BROKER_TOKEN" | vercel env add KESTREL_ONE_CREDENTIAL_BROKER_TOKEN production --sensitive --force --yes --scope lumi-kestrel
printf '%s' "$ACTIVE_KEY_ID" | vercel env add KESTREL_GATEWAY_CREDENTIAL_ACTIVE_KEY_ID production --sensitive --force --yes --scope lumi-kestrel
printf '%s' "$KEYRING" | vercel env add KESTREL_GATEWAY_CREDENTIAL_KEYS production --sensitive --force --yes --scope lumi-kestrel

printf 'KESTREL_ONE_CREDENTIAL_BROKER_TOKEN=%s\n' "$BROKER_TOKEN" |
  fly secrets import --stage --app kestrel-one-runner
```

Keep Fly's existing `OPENROUTER_API_KEY`; unmanaged profiles and the rollback image still use it.

## 4. Prove that no credential migration is required

Pull the new Production environment into a temporary ignored file and run the aggregate database preflight.

```bash
vercel env pull .env.production.local --environment=production --yes --scope lumi-kestrel
set -a
source .env.production.local
set +a

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc "
select json_build_object(
  'gateways', count(*),
  'storedCredentials', count(*) filter (where coalesce(trim(api_key), '') <> ''),
  'environmentSources', count(*) filter (where coalesce(trim(api_key_env_var), '') <> ''),
  'dualSources', count(*) filter (
    where coalesce(trim(api_key), '') <> ''
      and coalesce(trim(api_key_env_var), '') <> ''
  ),
  'encryptedCredentials', count(*) filter (where api_key like 'kgc:v1:%'),
  'plaintextCredentials', count(*) filter (
    where coalesce(trim(api_key), '') <> ''
      and api_key not like 'kgc:v1:%'
  )
) from ai_gateways;
"

pnpm --filter @kestrel/kestrel-one exec tsx scripts/migrate-gateway-credentials.ts --dry-run
pnpm --filter @kestrel/kestrel-one exec tsx scripts/migrate-gateway-credentials.ts --verify
```

Expected production state is one gateway, zero stored credentials, one environment source, zero dual sources, and zero plaintext credentials. Do not run the mutating migration. If plaintext or dual-source rows appear, stop this rollout and use a controlled migration window.

## 5. Deploy Fly first

The single machine owns the single attached volume, so the immediate replacement causes a brief runner interruption.

```bash
fly deploy . \
  --app kestrel-one-runner \
  --config deploy/fly/kestrel-one-runner/fly.toml \
  --dockerfile Dockerfile \
  --ignorefile deploy/fly/kestrel-one-runner/Dockerfile.dockerignore \
  --build-arg "KESTREL_GIT_SHA=${RELEASE_SHA}" \
  --image-label "gateway-${RELEASE_SHA}" \
  --strategy immediate \
  --yes

fly status --app kestrel-one-runner --json
fly secrets list --app kestrel-one-runner --json
```

Require one healthy machine, the unchanged volume attachment, the staged broker secret in deployed state, and an image revision/digest tied to `RELEASE_SHA`.

## 6. Build and verify a non-aliased Vercel candidate

```bash
vercel pull --yes --environment=production --scope lumi-kestrel
vercel build --prod --scope lumi-kestrel
CANDIDATE_URL="$(vercel deploy --prebuilt --prod --skip-domain --scope lumi-kestrel)"
```

Candidate health must be ready before promotion:

```bash
curl --fail --silent "$CANDIDATE_URL/api/health" |
  jq -e '.status == "healthy" and .checks.gatewayCredentialAuthority.ready == true'
```

An unauthenticated lease must return `401`, not `404`, and include `Cache-Control: no-store`.

```bash
curl --silent --show-error --dump-header - --output /dev/null \
  --request POST \
  --header 'content-type: application/json' \
  --data '{"version":"gateway-credential-lease-v1","gatewayId":"probe","rawModelId":"probe"}' \
  "$CANDIDATE_URL/api/kestrel/gateway-credentials/lease"
```

Resolve the known approved production model without printing credentials, then make an authenticated in-memory lease probe. The probe output is deliberately redacted.

```bash
IFS='|' read -r GATEWAY_ID RAW_MODEL_ID < <(
  psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -AtF '|' -c "
    select g.id, m.raw_model_id
    from ai_gateways g
    join ai_gateway_models m on m.gateway_id = g.id
    where g.enabled and m.approved and m.modality = 'language'
    order by m.is_default desc, m.raw_model_id
    limit 1
  "
)

printf '{"version":"gateway-credential-lease-v1","gatewayId":"%s","rawModelId":"%s"}' \
  "$GATEWAY_ID" "$RAW_MODEL_ID" |
  curl --fail --silent --show-error \
    --request POST \
    --header 'content-type: application/json' \
    --header "authorization: Bearer $BROKER_TOKEN" \
    --data-binary @- \
    "$CANDIDATE_URL/api/kestrel/gateway-credentials/lease" |
  node -e '
    let body = "";
    process.stdin.on("data", (chunk) => { body += chunk; });
    process.stdin.on("end", () => {
      const lease = JSON.parse(body);
      if (lease.version !== "gateway-credential-lease-v1") throw new Error("wrong lease version");
      if (!lease.gatewayId || !lease.rawModelId || !lease.expiresAt) throw new Error("incomplete lease");
      process.stdout.write(JSON.stringify({
        version: lease.version,
        gatewayId: lease.gatewayId,
        rawModelId: lease.rawModelId,
        provider: lease.provider,
        protocol: lease.protocol,
        expiresAt: lease.expiresAt,
        hasApiKey: lease.apiKey !== null,
      }) + "\n");
    });
  '
```

## 7. Promote and prove model authority

```bash
vercel promote "$CANDIDATE_URL" --scope lumi-kestrel
```

Start a real authenticated chat using the approved model whose raw ID is currently `openai/gpt-5-mini`. Require all of the following:

1. Inline profile `model`, `agentStageConfig.modelByStage.agent.loop`, and `modelCredential.rawModelId` match the selected raw model.
2. Runtime progress and model provenance name that raw model, never `z-ai/glm-5.2`.
3. Fly logs contain `kestrel.credential_cache_miss` for the selected gateway/raw model.
4. A second chat within 30 seconds contains `kestrel.credential_cache_hit` for the same gateway/raw model and no second miss.

Cache entries never live longer than five minutes and may refresh up to 30 seconds early. Do not assert that every request across the entire five-minute interval is a hit.

## 8. Monitor for 30 minutes

Watch Vercel health and runtime errors, Fly broker/cache logs, broker rejection counts, and chat completion/persistence. The rollout is complete only after a clean 30-minute window.

Clear local secret variables and remove the pulled temporary environment file after verification.

```bash
unset BROKER_TOKEN ACTIVE_KEY ACTIVE_KEY_ID KEYRING
rm -f .env.production.local
```

## Rollback

- Fly failure before Vercel promotion: redeploy the recorded pre-rollout Fly image. The staged broker secret is harmless to the old runner.
- Candidate failure: do not promote it.
- Failure after promotion: `vercel rollback <recorded-pre-rollout-deployment-id> --scope lumi-kestrel`.
- The gateway-only path does not mutate the database, so it does not require database restore.
- If migration `0013_threads_projects.sql` has been applied, stop using this rollback procedure and execute the separate Threads/Projects snapshot-restore plan.
