#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

APP_URL="${APP_URL:-http://127.0.0.1:43103}"

resolve_docker_bin() {
  if command -v docker >/dev/null 2>&1; then
    command -v docker
    return 0
  fi

  if [[ -x "/Applications/Docker.app/Contents/Resources/bin/docker" ]]; then
    printf '/Applications/Docker.app/Contents/Resources/bin/docker\n'
    return 0
  fi

  return 1
}

load_env_file() {
  local file="$1"
  if [[ -f "$file" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

load_env_file ".env.example"
load_env_file ".env"
load_env_file ".env.local"

if [[ -d "/Applications/Docker.app/Contents/Resources/bin" ]]; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:${PATH}"
fi

DATABASE_URL="${POSTGRES_URL:-${DATABASE_URL:-}}"
MINIO_ENDPOINT="${STORAGE_ENDPOINT:-http://127.0.0.1:${LOCAL_MINIO_API_PORT:-59000}}"
MINIO_HEALTH_URL="${MINIO_ENDPOINT%/}/minio/health/live"

DOCKER_BIN="$(resolve_docker_bin || true)"
if [[ -z "${DOCKER_BIN}" ]]; then
  echo "Docker is required for the Compose-based local stack."
  exit 1
fi

if [[ -z "${DATABASE_URL}" ]]; then
  echo "DATABASE_URL or POSTGRES_URL is required for local smoke checks"
  exit 1
fi

echo "==> Verifying Docker infra containers"
"${DOCKER_BIN}" compose ps postgres redis minio

echo "==> Checking Postgres readiness"
psql "$DATABASE_URL" -c 'select 1' >/dev/null

echo "==> Checking pgvector availability"
HAS_VECTOR="$(
  psql "$DATABASE_URL" -tA -c \
    "select exists(select 1 from pg_available_extensions where name = 'vector')" \
    2>/dev/null || true
)"
if [[ "${HAS_VECTOR}" != "t" ]]; then
  echo "Configured Postgres does not have the pgvector extension available."
  exit 1
fi

echo "==> Checking Redis readiness"
"${DOCKER_BIN}" compose exec -T redis redis-cli ping | grep -q PONG

echo "==> Checking MinIO readiness"
curl -fsS "${MINIO_HEALTH_URL}" >/dev/null

echo "==> Checking app health endpoint at ${APP_URL}/api/health"
HTTP_CODE="$(curl -sS -o /tmp/unified-health.json -w "%{http_code}" "${APP_URL}/api/health")"
if [[ "${HTTP_CODE}" != "200" ]]; then
  echo "Health check failed with status ${HTTP_CODE}"
  cat /tmp/unified-health.json || true
  exit 1
fi

echo "==> Checking auth guard behavior on protected endpoints"
SOURCES_CODE="$(curl -sS -o /tmp/unified-sources.json -w "%{http_code}" "${APP_URL}/api/sources")"
if [[ "${SOURCES_CODE}" != "401" ]]; then
  echo "Expected 401 for unauthenticated /api/sources, got ${SOURCES_CODE}"
  cat /tmp/unified-sources.json || true
  exit 1
fi

STATS_CODE="$(curl -sS -o /tmp/unified-stats-me.json -w "%{http_code}" "${APP_URL}/api/stats/me")"
if [[ "${STATS_CODE}" != "401" ]]; then
  echo "Expected 401 for unauthenticated /api/stats/me, got ${STATS_CODE}"
  cat /tmp/unified-stats-me.json || true
  exit 1
fi

echo "Local Compose infra + API smoke checks passed."
