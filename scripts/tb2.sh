#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: pnpm run tb2 <task-id> [bench:terminal:harbor args...]
       pnpm run tb2 --full [bench:terminal:harbor args...]

Runs a Terminal-Bench 2.0 Harbor CLI adapter task after loading .env. Kestrel
benchmark runs require OPENROUTER_API_KEY and optionally use OPENROUTER_MODEL.

Examples:
  pnpm run tb2 cobol-modernization --dry-run
  pnpm run tb2 --full --dry-run
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

caller_openrouter_model="${OPENROUTER_MODEL-}"
caller_openrouter_model_set=0
if [[ "${OPENROUTER_MODEL+x}" == "x" ]]; then
  caller_openrouter_model_set=1
fi

if [[ -f "${REPO_ROOT}/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  . "${REPO_ROOT}/.env"
  set +a
fi

if [[ "${caller_openrouter_model_set}" == "1" ]]; then
  export OPENROUTER_MODEL="${caller_openrouter_model}"
else
  unset OPENROUTER_MODEL
fi

exec pnpm run bench:terminal:harbor -- "$@"
