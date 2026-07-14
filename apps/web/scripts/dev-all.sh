#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HOST="${DEV_ALL_HOST:-127.0.0.1}"
PORT="${DEV_ALL_PORT:-43103}"
HEALTH_URL="http://${HOST}:${PORT}/api/health"
RUNNER_HOST="${KESTREL_RUNNER_SERVICE_HOST:-127.0.0.1}"
RUNNER_PORT="${KESTREL_RUNNER_SERVICE_PORT:-43106}"
RUNNER_HEALTH_URL="http://${RUNNER_HOST}:${RUNNER_PORT}/health"
RUNNER_DATABASE_NAME="kestrel_runtime"
RUNNER_DATABASE_MANAGED="false"

log() {
  printf '[dev:all] %s\n' "$*"
}

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
    log "Loading $(basename "$file")"
    set -a
    # shellcheck disable=SC1090
    source "$file"
    set +a
  fi
}

load_env_file ".env.example"
load_env_file ".env"
load_env_file ".env.local"

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-kestrel-one}"

if [[ -d "/Applications/Docker.app/Contents/Resources/bin" ]]; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:${PATH}"
fi

export NEXT_PUBLIC_APP_URL="${NEXT_PUBLIC_APP_URL:-http://${HOST}:${PORT}}"
export BETTER_AUTH_URL="${BETTER_AUTH_URL:-http://${HOST}:${PORT}}"
export DEV_AUTH_BYPASS="${DEV_AUTH_BYPASS:-true}"
export STORAGE_PROVIDER="${STORAGE_PROVIDER:-local-s3}"
export REDIS_URL="${REDIS_URL:-redis://127.0.0.1:${LOCAL_REDIS_PORT:-56379}}"
export KESTREL_ENVIRONMENT_RUNTIME="${KESTREL_ENVIRONMENT_RUNTIME:-local}"
export KESTREL_RUNNER_SERVICE_HOST="$RUNNER_HOST"
export KESTREL_RUNNER_SERVICE_PORT="$RUNNER_PORT"
export KESTREL_LOCAL_ENVIRONMENT_RUNNER_URL="${KESTREL_LOCAL_ENVIRONMENT_RUNNER_URL:-http://${RUNNER_HOST}:${RUNNER_PORT}}"
export KESTREL_LOCAL_ENVIRONMENT_RUNNER_TOKEN="${KESTREL_LOCAL_ENVIRONMENT_RUNNER_TOKEN:-kestrel-one-local-dev-runner}"
export KESTREL_RUNNER_SERVICE_TOKEN="$KESTREL_LOCAL_ENVIRONMENT_RUNNER_TOKEN"

if [[ "${AI_AGENT_API_KEY:-}" == "sk_your_provider_key" ]]; then
  log "Ignoring placeholder AI_AGENT_API_KEY from env defaults"
  unset AI_AGENT_API_KEY
fi

if [[ -z "${BETTER_AUTH_SECRET:-}" || "${BETTER_AUTH_SECRET}" == "your-secret-key-here" ]]; then
  export BETTER_AUTH_SECRET="local-dev-only-better-auth-secret-please-change"
fi

MINIO_ENDPOINT="${STORAGE_ENDPOINT:-http://127.0.0.1:${LOCAL_MINIO_API_PORT:-59000}}"
MINIO_HEALTH_URL="${MINIO_ENDPOINT%/}/minio/health/live"

DATABASE_URL="${POSTGRES_URL:-${DATABASE_URL:-}}"
if [[ -z "$DATABASE_URL" ]]; then
  log "DATABASE_URL or POSTGRES_URL is required"
  exit 1
fi

if [[ -z "${KESTREL_RUNNER_DATABASE_URL:-}" ]]; then
  KESTREL_RUNNER_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:${LOCAL_POSTGRES_PORT:-58432}/${RUNNER_DATABASE_NAME}"
  export KESTREL_RUNNER_DATABASE_URL
  RUNNER_DATABASE_MANAGED="true"
fi

require_command() {
  local command_name="$1"
  local install_hint="$2"

  if ! command -v "$command_name" >/dev/null 2>&1; then
    log "${command_name} is required. ${install_hint}"
    exit 1
  fi
}

wait_for_command() {
  local description="$1"
  local attempts="$2"
  shift 2

  local count=0
  until "$@" >/dev/null 2>&1; do
    count=$((count + 1))
    if [[ "$count" -ge "$attempts" ]]; then
      log "${description} did not become ready"
      return 1
    fi
    sleep 1
  done
}

require_pgvector() {
  local has_vector
  has_vector="$(
    psql "$DATABASE_URL" -tA -c \
      "select exists(select 1 from pg_available_extensions where name = 'vector')" \
      2>/dev/null || true
  )"

  if [[ "$has_vector" != "t" ]]; then
    log "The configured Postgres does not have the pgvector extension available."
    log "Use the bundled docker compose Postgres service from docker-compose.yml."
    return 1
  fi
}

cleanup() {
  local pid
  for pid in "${TURN_WORKER_PID:-}" "${APP_PID:-}" "${RUNNER_PID:-}"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done
}

monitor_app_processes() {
  while true; do
    if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
      log "Next.js exited; stopping the local stack"
      wait "$APP_PID"
      return $?
    fi

    if ! kill -0 "$TURN_WORKER_PID" >/dev/null 2>&1; then
      log "Durable turn worker exited; stopping the local stack"
      wait "$TURN_WORKER_PID"
      return $?
    fi

    if ! kill -0 "$RUNNER_PID" >/dev/null 2>&1; then
      log "Local Environment runtime exited; stopping the local stack"
      wait "$RUNNER_PID"
      return $?
    fi

    sleep 1
  done
}

trap cleanup EXIT INT TERM

require_command "psql" "Install the PostgreSQL client tools and try again."
require_command "curl" "Install curl and try again."
DOCKER_BIN="$(resolve_docker_bin || true)"
if [[ -z "${DOCKER_BIN}" ]]; then
  log "docker is required. Install Docker Desktop or another Docker runtime and try again."
  exit 1
fi

log "Starting docker compose infra"
"${DOCKER_BIN}" compose up -d postgres redis minio minio-init

log "Waiting for Postgres"
wait_for_command "Postgres" 60 psql "$DATABASE_URL" -c 'select 1'

log "Checking pgvector availability"
require_pgvector

log "Waiting for Redis"
wait_for_command "Redis" 60 "${DOCKER_BIN}" compose exec -T redis redis-cli ping

log "Waiting for MinIO"
wait_for_command "MinIO" 60 curl -fsS "$MINIO_HEALTH_URL"

log "Applying database migrations"
pnpm db:migrate

log "Applying local Environment runtime migrations"
if [[ "$RUNNER_DATABASE_MANAGED" == "true" ]] && \
  [[ "$(psql "$DATABASE_URL" -tAc "SELECT 1 FROM pg_database WHERE datname = '${RUNNER_DATABASE_NAME}'")" != "1" ]]; then
  psql "$DATABASE_URL" -c "CREATE DATABASE ${RUNNER_DATABASE_NAME}"
fi
KESTREL_DISABLE_DOTENV=1 DATABASE_URL="$KESTREL_RUNNER_DATABASE_URL" \
  pnpm --dir "$ROOT_DIR/../.." run db:migrate

log "Ensuring local admin account exists"
pnpm create-dev-admin

log "Generating checked-in RAG fixtures"
pnpm fixtures:rag

log "Starting local Environment runtime on ${RUNNER_HOST}:${RUNNER_PORT}"
DATABASE_URL="$KESTREL_RUNNER_DATABASE_URL" \
  pnpm --dir "$ROOT_DIR/../.." run runner:service &
RUNNER_PID=$!

attempts=0
until curl -fsS "$RUNNER_HEALTH_URL" >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if ! kill -0 "$RUNNER_PID" >/dev/null 2>&1; then
    log "Local Environment runtime exited before becoming healthy"
    wait "$RUNNER_PID"
    exit 1
  fi
  if [[ "$attempts" -ge 60 ]]; then
    log "Local Environment runtime did not become healthy at ${RUNNER_HEALTH_URL}"
    exit 1
  fi
  sleep 1
done

log "Starting Next.js on ${HOST}:${PORT} with webpack + polling dev mode"
WATCHPACK_POLLING=true CHOKIDAR_USEPOLLING=true \
  pnpm exec next dev --webpack --hostname "$HOST" --port "$PORT" &
APP_PID=$!

attempts=0
until curl -fsS "$HEALTH_URL" >/dev/null 2>&1; do
  attempts=$((attempts + 1))
  if ! kill -0 "$APP_PID" >/dev/null 2>&1; then
    log "Next.js exited before becoming healthy"
    wait "$APP_PID"
    exit 1
  fi
  if [[ "$attempts" -ge 60 ]]; then
    log "Application did not become healthy at ${HEALTH_URL}"
    exit 1
  fi
  sleep 1
done

log "Starting durable turn worker"
pnpm worker:turns &
TURN_WORKER_PID=$!

log "Ready at http://${HOST}:${PORT}"
monitor_app_processes
