#!/usr/bin/env bash
set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${REPO_ROOT}"

export CI="${CI:-true}"

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
export HF_HOME="${HF_HOME:-${TMPDIR:-/tmp}/kestrel-hf}"
export HF_HUB_CACHE="${HF_HUB_CACHE:-${HF_HOME}/hub}"
export DOCKER_CONFIG="${DOCKER_CONFIG:-${TMPDIR:-/tmp}/kestrel-docker}"
if [[ -z "${DOCKER_HOST:-}" && -S "${HOME}/.docker/run/docker.sock" ]]; then
  export DOCKER_HOST="unix://${HOME}/.docker/run/docker.sock"
fi

exec node --import tsx scripts/swe-verified-bench.ts "$@"
