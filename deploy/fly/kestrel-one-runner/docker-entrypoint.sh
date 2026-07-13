#!/bin/sh
set -eu

if [ "$(id -u)" -eq 0 ]; then
  if [ -n "${KESTREL_HOME:-}" ]; then
    rm -f -- "$KESTREL_HOME/core/lock.json" "$KESTREL_HOME/core/api.sock"
  fi
  install -d -o kestrel -g kestrel /data
  chown kestrel:kestrel /data
  exec gosu kestrel "$@"
fi

exec "$@"
