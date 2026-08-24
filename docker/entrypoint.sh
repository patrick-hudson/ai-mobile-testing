#!/usr/bin/env bash
set -euo pipefail

audit_ca=/work/certs/development-ca.crt
installed_ca=/usr/local/share/ca-certificates/ai-mobile-testing-development-ca.crt
baked_ca=/usr/local/share/ca-certificates/ai-mobile-testing-netskope-ca.crt
portal_runner_uid="$(id -u pwuser)"
portal_runner_gid="$(id -g pwuser)"
portal_ai_worker_uid="$(id -u aiworker)"
portal_ai_worker_gid="$(id -g aiworker)"
portal_report_worker_uid="$(id -u reportworker)"
portal_report_worker_gid="$(id -g reportworker)"

if [[ -n "${PORTAL_RUNNER_UID:-}" && "$PORTAL_RUNNER_UID" != "$portal_runner_uid" ]]; then
  printf '[AUDIT_BOOT] PORTAL_RUNNER_UID must match the image pwuser identity (%s).\n' "$portal_runner_uid" >&2
  exit 2
fi
if [[ -n "${PORTAL_RUNNER_GID:-}" && "$PORTAL_RUNNER_GID" != "$portal_runner_gid" ]]; then
  printf '[AUDIT_BOOT] PORTAL_RUNNER_GID must match the image pwuser identity (%s).\n' "$portal_runner_gid" >&2
  exit 2
fi
export PORTAL_RUNNER_UID="$portal_runner_uid"
export PORTAL_RUNNER_GID="$portal_runner_gid"

if [[ -n "${PORTAL_AI_WORKER_UID:-}" && "$PORTAL_AI_WORKER_UID" != "$portal_ai_worker_uid" ]]; then
  printf '[AUDIT_BOOT] PORTAL_AI_WORKER_UID must match the image aiworker identity (%s).\n' "$portal_ai_worker_uid" >&2
  exit 2
fi
if [[ -n "${PORTAL_AI_WORKER_GID:-}" && "$PORTAL_AI_WORKER_GID" != "$portal_ai_worker_gid" ]]; then
  printf '[AUDIT_BOOT] PORTAL_AI_WORKER_GID must match the image aiworker identity (%s).\n' "$portal_ai_worker_gid" >&2
  exit 2
fi
if [[ "$portal_ai_worker_uid" = "$portal_runner_uid" || "$portal_ai_worker_gid" != "$portal_runner_gid" ]]; then
  printf '[AUDIT_BOOT] aiworker must use a distinct UID and the shared run-artifact GID.\n' >&2
  exit 2
fi
export PORTAL_AI_WORKER_UID="$portal_ai_worker_uid"
export PORTAL_AI_WORKER_GID="$portal_ai_worker_gid"

if [[ -n "${PORTAL_REPORT_WORKER_UID:-}" && "$PORTAL_REPORT_WORKER_UID" != "$portal_report_worker_uid" ]]; then
  printf '[AUDIT_BOOT] PORTAL_REPORT_WORKER_UID must match the image reportworker identity (%s).\n' "$portal_report_worker_uid" >&2
  exit 2
fi
if [[ -n "${PORTAL_REPORT_WORKER_GID:-}" && "$PORTAL_REPORT_WORKER_GID" != "$portal_report_worker_gid" ]]; then
  printf '[AUDIT_BOOT] PORTAL_REPORT_WORKER_GID must match the image reportworker identity (%s).\n' "$portal_report_worker_gid" >&2
  exit 2
fi
if [[ "$portal_report_worker_uid" = "$portal_runner_uid" || "$portal_report_worker_uid" = "$portal_ai_worker_uid" || "$portal_report_worker_gid" != "$portal_runner_gid" ]]; then
  printf '[AUDIT_BOOT] reportworker must use a distinct UID and the shared run-artifact GID.\n' >&2
  exit 2
fi
export PORTAL_REPORT_WORKER_UID="$portal_report_worker_uid"
export PORTAL_REPORT_WORKER_GID="$portal_report_worker_gid"

if [[ -f "$audit_ca" ]]; then
  if ! cmp -s "$audit_ca" "$baked_ca"; then
    install -m 0644 "$audit_ca" "$installed_ca"
    update-ca-certificates >/dev/null
  fi
  export NODE_EXTRA_CA_CERTS="$audit_ca"
  export PLAYWRIGHT_FIREFOX_CA_CERT="$audit_ca"
  printf '[AUDIT_BOOT] Netskope/development CA trust is active from %s. TLS verification remains enabled.\n' "$audit_ca"
else
  printf '[AUDIT_BOOT] The image-baked Netskope CA trust is active. TLS verification remains strict unless an individual run records the explicit candidate bypass.\n'
fi

exec "$@"
