#!/usr/bin/env bash
set -euo pipefail

mkdir -p test-results
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-kestrel-one-product-contract}"
export KESTREL_TURN_WORKER_READY_FILE="${KESTREL_TURN_WORKER_READY_FILE:-/tmp/kestrel-one-product-contract-worker.ready}"

cleanup() {
  docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -f "$KESTREL_TURN_WORKER_READY_FILE"
}

trap cleanup EXIT INT TERM
rm -f "$KESTREL_TURN_WORKER_READY_FILE"
docker compose down --volumes --remove-orphans >/dev/null 2>&1 || true
docker compose up -d --wait --wait-timeout 60 postgres
for database_name in kestrel_product_contract kestrel_product_runtime; do
  docker compose exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS ${database_name} WITH (FORCE)"
  docker compose exec -T postgres psql -U postgres -d postgres -v ON_ERROR_STOP=1 -c "CREATE DATABASE ${database_name}"
done
./scripts/dev-all.sh 2>&1 | tee test-results/product-dev-all.log
