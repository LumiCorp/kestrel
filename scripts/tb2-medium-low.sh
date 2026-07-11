#!/usr/bin/env bash
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'USAGE'
Usage: pnpm run tb2-medium-low [tb2 args...]

Runs the proposed Terminal-Bench 2.0 medium-low candidate set sequentially.
Set KESTREL_TB2_MIN_FREE_GB to override the 20GiB disk preflight threshold.
Set KESTREL_TB2_SKIP_PREFLIGHT=1 to skip Docker and disk preflight checks.

Examples:
  pnpm run tb2-medium-low
  pnpm run tb2-medium-low -- --dry-run
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

run_tb2_medium_low_case() {
  local task_id="$1"
  shift

  printf '[tb2-medium-low] running %s\n' "${task_id}"
  pnpm run tb2 "${task_id}" "$@"
}

current_time_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

is_dry_run_requested() {
  local arg
  for arg in "$@"; do
    if [[ "${arg}" == "--dry-run" ]]; then
      return 0
    fi
  done
  return 1
}

existing_df_path() {
  local candidate="$1"
  while [[ ! -e "${candidate}" && "${candidate}" != "/" ]]; do
    candidate="$(dirname "${candidate}")"
  done
  printf '%s\n' "${candidate}"
}

available_kb_for_path() {
  local target_path
  target_path="$(existing_df_path "$1")"
  df -Pk "${target_path}" | awk 'NR == 2 { print $4 }'
}

tb2_preflight_reason() {
  if [[ "${KESTREL_TB2_SKIP_PREFLIGHT:-}" == "1" ]]; then
    return 0
  fi
  if ! docker info >/dev/null 2>&1; then
    printf 'infra_docker_unhealthy'
    return 1
  fi

  local min_free_gb="${KESTREL_TB2_MIN_FREE_GB:-20}"
  if [[ ! "${min_free_gb}" =~ ^[0-9]+$ ]]; then
    printf 'infra_invalid_min_free_gb:%s' "${min_free_gb}"
    return 1
  fi

  local min_free_kb=$((min_free_gb * 1024 * 1024))
  local path_label path_value available_kb
  for path_label in repo_jobs harbor_cache; do
    if [[ "${path_label}" == "repo_jobs" ]]; then
      path_value="${REPO_ROOT}/jobs"
    else
      path_value="${HARBOR_CACHE_DIR:-${HOME:-${REPO_ROOT}}/.cache/harbor}"
    fi
    available_kb="$(available_kb_for_path "${path_value}")"
    if [[ -z "${available_kb}" || ! "${available_kb}" =~ ^[0-9]+$ ]]; then
      printf 'infra_disk_check_failed:%s' "${path_label}"
      return 1
    fi
    if (( available_kb < min_free_kb )); then
      printf 'infra_low_disk:%s:%sKiB_available:%sGiB_required' "${path_label}" "${available_kb}" "${min_free_gb}"
      return 1
    fi
  done
  return 0
}

tb2_result_summary() {
  local since_ms="$1"
  local task_id="$2"
  pnpm exec tsx scripts/tb2-result-summary.ts --since-ms "${since_ms}" --task "${task_id}"
}

extra_args=("$@")
tasks=(
  caffe-cifar-10
  crack-7z-hash
  mteb-leaderboard
  raman-fitting
  constraints-scheduling
  kv-store-grpc
  mteb-retrieve
  pytorch-model-recovery
)

results=()
overall=0
dry_run=0
if is_dry_run_requested "${extra_args[@]}"; then
  dry_run=1
fi

for task_index in "${!tasks[@]}"; do
  task_id="${tasks[task_index]}"
  if (( dry_run == 0 )); then
    preflight_reason="$(tb2_preflight_reason)"
    if [[ -n "${preflight_reason}" ]]; then
      for remaining_index in "${!tasks[@]}"; do
        if (( remaining_index < task_index )); then
          continue
        fi
        results+=("SKIP_INFRA ${tasks[remaining_index]} reason=${preflight_reason}")
      done
      overall=1
      break
    fi
  fi

  started_at_ms="$(current_time_ms)"
  if run_tb2_medium_low_case "${task_id}" "${extra_args[@]}"; then
    task_status=0
  else
    task_status=$?
    overall=1
  fi

  if (( dry_run == 1 )); then
    results+=("DRY_RUN ${task_id}")
    continue
  fi

  summary_output="$(tb2_result_summary "${started_at_ms}" "${task_id}")"
  printf '%s\n' "${summary_output}"
  readable_summary="$(printf '%s\n' "${summary_output}" | awk '/^\[tb2-result-summary\] / { sub(/^\[tb2-result-summary\] /, ""); print }' | tail -n 1)"
  summary_status="${readable_summary%% *}"
  if [[ "${summary_status}" != "PASS" ]]; then
    overall=1
  fi
  if [[ "${task_status}" != "0" && "${summary_status}" == "PASS" ]]; then
    results+=("FAIL ${task_id} exit=${task_status} ${readable_summary}")
  else
    results+=("${readable_summary}")
  fi
done

printf '\n[tb2-medium-low] summary\n'
for result in "${results[@]}"; do
  printf '[tb2-medium-low] %s\n' "${result}"
done

exit "${overall}"
