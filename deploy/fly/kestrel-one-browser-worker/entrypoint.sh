#!/usr/bin/env bash
set -euo pipefail

gateway_host="${KESTREL_BROWSER_EGRESS_GATEWAY_HOST:-}"
if [[ ! "$gateway_host" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.vm\.[a-z0-9][a-z0-9-]{0,62}\.internal$ ]]; then
  printf 'hosted Browser worker gateway host is missing or invalid\n' >&2
  exit 1
fi

mapfile -t gateway_addresses < <(
  getent ahosts "$gateway_host" \
    | awk '{ print $1 }' \
    | sort -u
)
if (( ${#gateway_addresses[@]} == 0 )); then
  printf 'hosted Browser worker gateway host did not resolve\n' >&2
  exit 1
fi
gateway_address="${gateway_addresses[0]}"
mapfile -t resolver_addresses < <(
  awk '$1 == "nameserver" { print $2 }' /etc/resolv.conf \
    | sort -u
)
if (( ${#resolver_addresses[@]} == 0 )); then
  printf 'hosted Browser worker has no configured DNS resolver\n' >&2
  exit 1
fi
gateway_port="${KESTREL_BROWSER_EGRESS_GATEWAY_PORT:-}"
if [[ "$gateway_port" != "43109" ]]; then
  printf 'hosted Browser worker gateway port is missing or invalid\n' >&2
  exit 1
fi

rules_file="$(mktemp /tmp/kestrel-browser-egress.XXXXXX)"
cleanup() {
  rm -f -- "$rules_file"
}
trap cleanup EXIT

{
  printf 'table inet kestrel_browser_egress {\n'
  printf '  chain output {\n'
  printf '    type filter hook output priority filter; policy drop;\n'
  printf '    udp dport 53 drop\n'
  printf '    tcp dport 53 drop\n'
  for address in "${resolver_addresses[@]}"; do
    if [[ "$address" == *:* ]]; then
      printf '    ip6 daddr %s drop\n' "$address"
    elif [[ "$address" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
      printf '    ip daddr %s drop\n' "$address"
    else
      printf 'hosted Browser worker DNS resolver address is invalid\n' >&2
      exit 1
    fi
  done
  printf '    oifname "lo" accept\n'
  printf '    ct state established,related accept\n'
  printf '    icmpv6 type { nd-router-solicit, nd-router-advert, nd-neighbor-solicit, nd-neighbor-advert } accept\n'
  if [[ "$gateway_address" == *:* ]]; then
    printf '    ip6 daddr %s tcp dport %s accept\n' "$gateway_address" "$gateway_port"
  elif [[ "$gateway_address" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then
    printf '    ip daddr %s tcp dport %s accept\n' "$gateway_address" "$gateway_port"
  else
    printf 'hosted Browser worker gateway address is invalid\n' >&2
    exit 1
  fi
  printf '  }\n'
  printf '}\n'
} >"$rules_file"

/usr/sbin/nft --check --file "$rules_file"
/usr/sbin/nft --file "$rules_file"
cleanup
trap - EXIT

export KESTREL_BROWSER_EGRESS_GATEWAY_ADDRESS="$gateway_address"

exec /usr/bin/setpriv \
  --reuid=10001 \
  --regid=10001 \
  --init-groups \
  --bounding-set=-all \
  --inh-caps=-all \
  --ambient-caps=-all \
  --no-new-privs \
  node /app/dist/src/browser/hostedWorkerMain.js
