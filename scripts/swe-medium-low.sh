#!/usr/bin/env bash
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: pnpm run swe:medium-low [bench:swe args...]

Runs SWE-bench Verified Cohort D medium-low candidates sequentially.
These instances come from the Verified "15 min - 1 hour" difficulty bucket.

Examples:
  pnpm run swe:medium-low
  pnpm run swe:medium-low -- --dry-run
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

run_swe_medium_low_case() {
  local instance_id="$1"
  shift

  printf '[swe-medium-low] running %s\n' "${instance_id}"
  pnpm run swe "${instance_id}" "$@"
}

extra_args=("$@")
tasks=(
  pytest-dev__pytest-10051
  psf__requests-6028
  pylint-dev__pylint-4604
  mwaskom__seaborn-3069
  pydata__xarray-2905
  scikit-learn__scikit-learn-10297
  sphinx-doc__sphinx-10466
  matplotlib__matplotlib-14623
  astropy__astropy-13236
  sympy__sympy-11618
  django__django-10973
  pytest-dev__pytest-5840
  pylint-dev__pylint-4661
  pydata__xarray-3095
  scikit-learn__scikit-learn-10908
)

is_dry_run_requested() {
  local arg
  for arg in "$@"; do
    if [[ "${arg}" == "--dry-run" ]]; then
      return 0
    fi
  done
  return 1
}

summarize_swe_output() {
  local output_file="$1"
  local exit_code="$2"

  if grep -q "Kestrel run produced an empty patch" "${output_file}"; then
    printf 'FAIL empty_patch exit=%s' "${exit_code}"
  elif grep -q "Instances resolved: 1" "${output_file}"; then
    printf 'PASS resolved exit=%s' "${exit_code}"
  elif grep -q "Instances unresolved: 1" "${output_file}"; then
    printf 'FAIL unresolved exit=%s' "${exit_code}"
  elif [[ "${exit_code}" == "0" ]]; then
    printf 'DONE exit=0'
  else
    printf 'FAIL exit=%s' "${exit_code}"
  fi
}

results=()
overall=0
dry_run=0
if is_dry_run_requested "${extra_args[@]}"; then
  dry_run=1
fi

for task_id in "${tasks[@]}"; do
  output_file="$(mktemp -t swe-medium-low.XXXXXX)"
  run_swe_medium_low_case "${task_id}" "${extra_args[@]}" 2>&1 | tee "${output_file}"
  task_status="${PIPESTATUS[0]}"

  if (( dry_run == 1 )); then
    results+=("DRY_RUN ${task_id}")
  else
    readable_summary="$(summarize_swe_output "${output_file}" "${task_status}")"
    results+=("${readable_summary} ${task_id}")
    if [[ "${readable_summary}" != PASS* ]]; then
      overall=1
    fi
  fi

  rm -f "${output_file}"
done

printf '\n[swe-medium-low] summary\n'
for result in "${results[@]}"; do
  printf '[swe-medium-low] %s\n' "${result}"
done

exit "${overall}"
