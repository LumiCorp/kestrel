#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: pnpm run tb2-passing [tb2 args...]

Runs the curated Terminal-Bench 2.0 passing regression set sequentially.

Examples:
  pnpm run tb2-passing
  pnpm run tb2-passing -- --dry-run
USAGE
}

if [[ "${1:-}" == "--" ]]; then
  shift
fi

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

cd "${REPO_ROOT}"

run_tb2_passing_case() {
  local task_id="$1"
  shift

  printf '[tb2-passing] running %s\n' "${task_id}"
  pnpm run tb2 "${task_id}" "$@"
}

extra_args=("$@")

run_tb2_passing_case cobol-modernization --artifact /app/program.py "${extra_args[@]}"
run_tb2_passing_case fix-git "${extra_args[@]}"
run_tb2_passing_case prove-plus-comm "${extra_args[@]}"
