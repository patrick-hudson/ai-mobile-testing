#!/usr/bin/env bash
set -euo pipefail

audit_ca=/work/certs/development-ca.crt
installed_ca=/usr/local/share/ca-certificates/ai-mobile-testing-development-ca.crt
baked_ca=/usr/local/share/ca-certificates/ai-mobile-testing-netskope-ca.crt

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
