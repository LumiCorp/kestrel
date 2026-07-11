#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
CLI_NAMES=(kestrel ks kcron)

cd "${REPO_ROOT}"

resolve_pnpm_home() {
  if [[ -n "${PNPM_HOME:-}" ]]; then
    printf '%s\n' "${PNPM_HOME}"
    return 0
  fi

  local configured
  configured="$(pnpm config get global-bin-dir 2>/dev/null || true)"
  if [[ -n "${configured}" && "${configured}" != "undefined" ]]; then
    printf '%s\n' "${configured}"
    return 0
  fi

  case "$(uname -s)" in
    Darwin)
      printf '%s\n' "${HOME}/Library/pnpm"
      ;;
    Linux)
      printf '%s\n' "${HOME}/.local/share/pnpm"
      ;;
    *)
      printf '%s\n' "${HOME}/.pnpm"
      ;;
  esac
}

install_bin_shims() {
  local pnpm_home target source
  pnpm_home="$(resolve_pnpm_home)"

  mkdir -p "${pnpm_home}"

  for target in "${CLI_NAMES[@]}"; do
    source="$(resolve_cli_source "${target}")"
    chmod +x "${source}"
    ln -sf "${source}" "${pnpm_home}/${target}"
    test -x "${pnpm_home}/${target}"
  done

  echo "[kestrel] installed CLI shims to ${pnpm_home}"
}

verify_bin_shims() {
  local pnpm_home target source actual
  pnpm_home="$(resolve_pnpm_home)"

  for target in "${CLI_NAMES[@]}"; do
    source="$(resolve_cli_source "${target}")"
    actual="$(readlink "${pnpm_home}/${target}")"
    if [[ "${actual}" != "${source}" ]]; then
      echo "[kestrel] ${target} points to ${actual}; expected ${source}" >&2
      return 1
    fi
    test -x "${pnpm_home}/${target}"
  done

  echo "[kestrel] verified CLI shims"
}

warn_if_pnpm_home_not_on_path() {
  local pnpm_home
  pnpm_home="$(resolve_pnpm_home)"

  case ":${PATH:-}:" in
    *":${pnpm_home}:"*)
      return 0
      ;;
    *)
      echo
      echo "[kestrel] warning: ${pnpm_home} is not on PATH"
      echo "Add it to your shell profile before using the installed commands directly."
      ;;
  esac
}

resolve_cli_source() {
  case "$1" in
    kcron)
      printf '%s\n' "${REPO_ROOT}/bin/kcron.js"
      ;;
    *)
      printf '%s\n' "${REPO_ROOT}/bin/kestrel.js"
      ;;
  esac
}

echo "[kestrel] building CLI"
if pnpm build; then
  echo "[kestrel] build complete"
else
  echo "[kestrel] build failed; continuing with source-backed CLI shims"
fi

echo "[kestrel] installing source-backed CLI shims"
install_bin_shims
verify_bin_shims
warn_if_pnpm_home_not_on_path

echo
echo "Installed CLI entrypoints:"
for target in "${CLI_NAMES[@]}"; do
  echo "  ${target}"
done
echo
echo "Try:"
echo "  cd /path/to/project"
echo "  kestrel"
echo
echo "If the commands are not found, ensure your pnpm bin directory is on PATH."
echo "Expected bin directory:"
echo "  $(resolve_pnpm_home)"
