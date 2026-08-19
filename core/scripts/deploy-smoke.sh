#!/usr/bin/env bash
set -euo pipefail

host="${HEALTH_HOST:-127.0.0.1}"
core_port="${CORE_PORT:-3100}"
agent_port="${AGENT_WORKER_HEALTH_PORT:-3101}"
ingestion_port="${INGESTION_WORKER_HEALTH_PORT:-3102}"

for endpoint in \
  "http://${host}:${core_port}/health/ready" \
  "http://${host}:${agent_port}/health/ready" \
  "http://${host}:${ingestion_port}/health/ready"; do
  curl --fail --silent --show-error --max-time 5 "$endpoint" >/dev/null
  echo "ready: $endpoint"
done
