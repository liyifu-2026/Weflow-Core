#!/usr/bin/env bash
set -euo pipefail

pids=()

cleanup() {
  if ((${#pids[@]} > 0)); then
    kill "${pids[@]}" 2>/dev/null || true
    wait "${pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT

node dist/apps/api/main.js &
pids+=("$!")
node dist/apps/agent-worker/main.js &
pids+=("$!")
node dist/apps/ingestion-worker/main.js &
pids+=("$!")

for port in 3100 3101 3102; do
  ready=false
  for _ in $(seq 1 30); do
    if node -e \
      'fetch(process.argv[1]).then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))' \
      "http://127.0.0.1:${port}/health/ready"; then
      ready=true
      break
    fi
    sleep 1
  done
  if [[ "$ready" != true ]]; then
    echo "health check failed on port ${port}" >&2
    exit 1
  fi
done
