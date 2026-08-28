#!/usr/bin/env bash
set -euo pipefail

queue_root=/var/lib/ai-mobile-testing/jobs

if [[ ! -d "$queue_root" || -L "$queue_root" ]]; then
  printf '[SINGLE_SITE_VOLUME_INIT] Queue volume must be a real directory.\n' >&2
  exit 2
fi

queue_symlink="$(find "$queue_root" -xdev -type l -print -quit)"
if [[ -n "$queue_symlink" ]]; then
  printf '[SINGLE_SITE_VOLUME_INIT] Queue volume contains an unsafe symlink: %s\n' "$queue_symlink" >&2
  exit 2
fi

chown -R pwuser:pwuser "$queue_root"
find "$queue_root" -xdev -type d -exec chmod 2770 {} +
find "$queue_root" -xdev -type f -exec chmod 0660 {} +
printf '[SINGLE_SITE_VOLUME_INIT] Durable queue ownership and setgid collaboration are ready for the root portal and non-root Playwright workers.\n'
