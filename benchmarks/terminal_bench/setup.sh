#!/bin/bash
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl nodejs npm python3 python3-pytest

npm install -g node@22.23.1 pnpm@9.12.2
hash -r
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'

if ! command -v uv >/dev/null 2>&1; then
  cat >/usr/local/bin/uv <<'UV_SHIM'
#!/usr/bin/env bash
set -euo pipefail

PYTHON_BIN="${UV_SHIM_PYTHON:-/usr/bin/python3}"
command="${1:-}"
case "${command}" in
  init)
    if [[ ! -f pyproject.toml ]]; then
      cat >pyproject.toml <<'PYPROJECT'
[project]
name = "terminal-bench-task"
version = "0.0.0"
requires-python = ">=3.11"
dependencies = []
PYPROJECT
    fi
    ;;
  add)
    shift
    for dependency in "$@"; do
      if [[ "${dependency}" == "pytest" ]]; then
        "${PYTHON_BIN}" -c 'import pytest'
      fi
    done
    ;;
  run)
    shift
    if [[ "${1:-}" == "pytest" ]]; then
      shift
      exec "${PYTHON_BIN}" -m pytest "$@"
    fi
    exec "$@"
    ;;
  *)
    echo "uv compatibility shim supports: init, add, run" >&2
    exit 2
    ;;
esac
UV_SHIM
  chmod +x /usr/local/bin/uv
fi

rm -rf /opt/kestrel
mkdir -p /opt/kestrel
tar -xzf /installed-agent/kestrel.tar.gz -C /opt/kestrel

cd /opt/kestrel
CI=true pnpm install --frozen-lockfile --prod=false
node -e 'require.resolve("tsx")'

chmod +x /installed-agent/cli_task_runner.py
