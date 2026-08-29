#!/usr/bin/env bash
set -euo pipefail

queue_root=/var/lib/ai-mobile-testing/jobs
volume_roots=("$queue_root")
for optional_root in /var/lib/ai-mobile-testing/shared/canonical /var/lib/ai-mobile-testing/shared/exchange; do
  if [[ -e "$optional_root" ]]; then volume_roots+=("$optional_root"); fi
done
sensitive_roots=()
for optional_root in \
  /var/lib/ai-mobile-testing/shared/credentials \
  /var/lib/ai-mobile-testing/shared/secrets/ordinary-a \
  /var/lib/ai-mobile-testing/shared/secrets/ordinary-b \
  /var/lib/ai-mobile-testing/shared/secrets/performance; do
  if [[ -e "$optional_root" ]]; then sensitive_roots+=("$optional_root"); fi
done

for volume_root in "${volume_roots[@]}"; do
  if [[ ! -d "$volume_root" || -L "$volume_root" ]]; then
    printf '[SINGLE_SITE_VOLUME_INIT] Shared runner volume must be a real directory: %s\n' "$volume_root" >&2
    exit 2
  fi

  unsafe_symlink="$(find "$volume_root" -xdev -type l -print -quit)"
  if [[ -n "$unsafe_symlink" ]]; then
    printf '[SINGLE_SITE_VOLUME_INIT] Shared runner volume contains an unsafe symlink: %s\n' "$unsafe_symlink" >&2
    exit 2
  fi

  chown -R pwuser:pwuser "$volume_root"
  find "$volume_root" -xdev -type d -exec chmod 2770 {} +
  find "$volume_root" -xdev -type f -exec chmod 0660 {} +
done

for volume_root in "${sensitive_roots[@]}"; do
  if [[ ! -d "$volume_root" || -L "$volume_root" ]]; then
    printf '[SINGLE_SITE_VOLUME_INIT] Credential volume must be a real directory: %s\n' "$volume_root" >&2
    exit 2
  fi
  unsafe_symlink="$(find "$volume_root" -xdev -type l -print -quit)"
  if [[ -n "$unsafe_symlink" ]]; then
    printf '[SINGLE_SITE_VOLUME_INIT] Credential volume contains an unsafe symlink: %s\n' "$unsafe_symlink" >&2
    exit 2
  fi
  chown -R pwuser:pwuser "$volume_root"
  find "$volume_root" -xdev -type d -exec chmod 0700 {} +
  find "$volume_root" -xdev -type f -exec chmod 0600 {} +
done
printf '[SINGLE_SITE_VOLUME_INIT] Durable queues and private shared-control volumes are ready for isolated non-root workers.\n'
