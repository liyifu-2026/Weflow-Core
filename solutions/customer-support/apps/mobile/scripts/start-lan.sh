#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${REACT_NATIVE_PACKAGER_HOSTNAME:-}" ]]; then
  if command -v ip >/dev/null 2>&1; then
    REACT_NATIVE_PACKAGER_HOSTNAME="$(ip route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([^ ]*\).*/\1/p' | head -n 1)"
  fi
fi

if [[ -z "${REACT_NATIVE_PACKAGER_HOSTNAME:-}" ]]; then
  REACT_NATIVE_PACKAGER_HOSTNAME="$(hostname -I 2>/dev/null | awk '{print $1}')"
fi

if [[ -z "${REACT_NATIVE_PACKAGER_HOSTNAME:-}" ]]; then
  echo "Unable to determine the LAN IP. Set REACT_NATIVE_PACKAGER_HOSTNAME manually." >&2
  exit 1
fi

export REACT_NATIVE_PACKAGER_HOSTNAME
export EXPO_PACKAGER_HOSTNAME="${EXPO_PACKAGER_HOSTNAME:-$REACT_NATIVE_PACKAGER_HOSTNAME}"
export EXPO_PUBLIC_ALLOW_INSECURE_HTTP="${EXPO_PUBLIC_ALLOW_INSECURE_HTTP:-true}"

echo "Expo Metro host: ${REACT_NATIVE_PACKAGER_HOSTNAME}"
exec expo start --host lan "$@"
