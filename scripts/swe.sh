#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: pnpm run swe <instance-id> [bench:swe args...]

Runs one SWE-bench Verified instance after loading .env and defaulting
KESTREL_SWE_PYTHON to the dedicated .venv-swebench interpreter.

Examples:
  pnpm run swe astropy__astropy-12907
  pnpm run swe astropy__astropy-12907 --dry-run
  pnpm run swe astropy__astropy-12907 --instances-jsonl /path/to/verified.jsonl
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

instance_id="${1}"
shift

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

export KESTREL_SWE_PYTHON="${KESTREL_SWE_PYTHON:-.venv-swebench/bin/python}"

exec bash scripts/bench-swe.sh run --instance-id "${instance_id}" "$@"
