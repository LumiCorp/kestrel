#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: pnpm run swe:passing [bench:swe args...]

Runs the curated SWE-bench Verified passing regression set sequentially.

Examples:
  pnpm run swe:passing
  pnpm run swe:passing -- --dry-run
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

run_swe_passing_case() {
  local instance_id="$1"
  shift

  printf '[swe-passing] running %s\n' "${instance_id}"
  pnpm run swe "${instance_id}" "$@"
}

extra_args=("$@")

run_swe_passing_case scikit-learn__scikit-learn-14141 "${extra_args[@]}"
run_swe_passing_case django__django-14089 "${extra_args[@]}"
run_swe_passing_case django__django-11066 "${extra_args[@]}"
run_swe_passing_case scikit-learn__scikit-learn-10844 "${extra_args[@]}"
run_swe_passing_case django__django-11099 "${extra_args[@]}"
run_swe_passing_case sympy__sympy-15349 "${extra_args[@]}"
run_swe_passing_case django__django-16569 "${extra_args[@]}"
run_swe_passing_case django__django-13670 "${extra_args[@]}"
run_swe_passing_case pydata__xarray-4629 "${extra_args[@]}"
run_swe_passing_case sympy__sympy-19637 "${extra_args[@]}"
run_swe_passing_case django__django-14373 "${extra_args[@]}"
run_swe_passing_case pytest-dev__pytest-6202 "${extra_args[@]}"
run_swe_passing_case pytest-dev__pytest-10051 "${extra_args[@]}"
run_swe_passing_case astropy__astropy-7671 "${extra_args[@]}"
run_swe_passing_case astropy__astropy-14995 "${extra_args[@]}"
run_swe_passing_case astropy__astropy-14309 "${extra_args[@]}"
run_swe_passing_case pallets__flask-5014 "${extra_args[@]}"
run_swe_passing_case django__django-13410 "${extra_args[@]}"
run_swe_passing_case astropy__astropy-7336 "${extra_args[@]}"
run_swe_passing_case sympy__sympy-16886 "${extra_args[@]}"
run_swe_passing_case psf__requests-2931 "${extra_args[@]}"
run_swe_passing_case astropy__astropy-12907 "${extra_args[@]}"
run_swe_passing_case pytest-dev__pytest-7571 "${extra_args[@]}"
run_swe_passing_case django__django-11133 "${extra_args[@]}"
run_swe_passing_case astropy__astropy-8707 "${extra_args[@]}"
run_swe_passing_case scikit-learn__scikit-learn-14053 "${extra_args[@]}"
run_swe_passing_case pytest-dev__pytest-5631 "${extra_args[@]}"
run_swe_passing_case sympy__sympy-12481 "${extra_args[@]}"
run_swe_passing_case django__django-13023 "${extra_args[@]}"
run_swe_passing_case scikit-learn__scikit-learn-13328 "${extra_args[@]}"
run_swe_passing_case pydata__xarray-3677 "${extra_args[@]}"
run_swe_passing_case sphinx-doc__sphinx-7889 "${extra_args[@]}"
run_swe_passing_case sympy__sympy-14711 "${extra_args[@]}"
