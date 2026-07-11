#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: pnpm run tb2-codex <task-id> [bench:terminal:codex args...]
       pnpm run tb2-codex --full [bench:terminal:codex args...]

Runs a Terminal-Bench 2.0 Harbor task with Codex CLI as the installed agent.

Examples:
  pnpm run tb2-codex overfull-hbox --dry-run
  KESTREL_TBENCH_CODEX_MODEL=gpt-5.4 pnpm run tb2-codex overfull-hbox
USAGE
}

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ "${1:-}" == "" ]]; then
  usage >&2
  exit 2
fi

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

cd "${REPO_ROOT}"

if [[ -f "${REPO_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "${REPO_ROOT}/.env"
  set +a
fi

exec pnpm run bench:terminal:codex -- "$@"
