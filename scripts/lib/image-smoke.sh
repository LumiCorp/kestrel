#!/usr/bin/env bash

smoke_container_port() {
  local container="$1"
  local port="$2"
  docker port "$container" "${port}/tcp" | tail -1 | awk -F: '{ print $NF }'
}

smoke_wait_http() {
  local container="$1"
  local url="$2"
  local output_file="$3"
  local expected_status="${4:-200}"
  local attempts="${5:-30}"
  local status=""
  for _ in $(seq 1 "$attempts"); do
    if [[ "$(docker inspect --format '{{.State.Running}}' "$container" 2>/dev/null || true)" != "true" ]]; then
      printf 'Smoke container %s exited before readiness\n' "$container" >&2
      docker logs "$container" >&2 || true
      return 1
    fi
    status="$(curl --silent --output "$output_file" --write-out '%{http_code}' "$url" || true)"
    if [[ "$status" == "$expected_status" ]]; then
      return 0
    fi
    sleep 1
  done
  printf 'Smoke endpoint %s did not reach HTTP %s (last status %s)\n' "$url" "$expected_status" "$status" >&2
  [[ -f "$output_file" ]] && { printf 'Last response:\n' >&2; sed -n '1,200p' "$output_file" >&2; }
  docker logs "$container" >&2 || true
  return 1
}
