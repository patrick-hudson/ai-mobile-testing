#!/usr/bin/env bash
set -euo pipefail

queue_root=/var/lib/ai-mobile-testing/jobs
volume_roots=("$queue_root")
for optional_root in \
  /var/lib/ai-mobile-testing/shared/canonical \
  /var/lib/ai-mobile-testing/shared/exchange; do
  if [[ -e "$optional_root" ]]; then volume_roots+=("$optional_root"); fi
done
cutover_roots=(
  /var/lib/ai-mobile-testing/shared/backups
  /var/lib/ai-mobile-testing/shared/restores
)
sensitive_roots=()
for optional_root in \
  /var/lib/ai-mobile-testing/shared/credentials \
  /var/lib/ai-mobile-testing/shared/trust \
  /var/lib/ai-mobile-testing/shared/authority-floor \
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

for cutover_root in "${cutover_roots[@]}"; do
  if [[ ! -e "$cutover_root" ]]; then continue; fi
  if [[ ! -d "$cutover_root" || -L "$cutover_root" ]]; then
    printf '[SINGLE_SITE_VOLUME_INIT] Durable cutover volume must be a real directory: %s\n' "$cutover_root" >&2
    exit 2
  fi
  chown pwuser:pwuser "$cutover_root"
  chmod 2770 "$cutover_root"
done

shared_trust_root=/var/lib/ai-mobile-testing/shared/trust
if [[ -d "$shared_trust_root" ]]; then
  for marker_name in store-marker backup-marker; do
    marker_path="$shared_trust_root/$marker_name"
    if [[ ! -e "$marker_path" ]]; then
      temporary_marker="$shared_trust_root/.${marker_name}.tmp.$$"
      node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex") + "\n")' > "$temporary_marker"
      chmod 0600 "$temporary_marker"
      mv -n "$temporary_marker" "$marker_path"
      rm -f "$temporary_marker"
    fi
    if [[ ! -f "$marker_path" || -L "$marker_path" || ! "$(tr -d '\n' < "$marker_path")" =~ ^[a-f0-9]{64}$ ]]; then
      printf '[SINGLE_SITE_VOLUME_INIT] Trusted shared-store marker is invalid: %s\n' "$marker_path" >&2
      exit 2
    fi
    chown pwuser:pwuser "$marker_path"
    chmod 0600 "$marker_path"
  done
fi

if [[ -d /var/lib/ai-mobile-testing/shared/canonical ]]; then
  node scripts/init-shared-admission.mjs /var/lib/ai-mobile-testing/shared/canonical
  node scripts/init-legacy-authority-fence.mjs /var/lib/ai-mobile-testing/shared/canonical/legacy-authority
  chown -R pwuser:pwuser /var/lib/ai-mobile-testing/shared/canonical/cutover-admission
  chown -R pwuser:pwuser /var/lib/ai-mobile-testing/shared/canonical/legacy-authority
  find /var/lib/ai-mobile-testing/shared/canonical/cutover-admission -xdev -type d -exec chmod 2770 {} +
  find /var/lib/ai-mobile-testing/shared/canonical/cutover-admission -xdev -type f -exec chmod 0660 {} +
  find /var/lib/ai-mobile-testing/shared/canonical/legacy-authority -xdev -type d -exec chmod 2770 {} +
  find /var/lib/ai-mobile-testing/shared/canonical/legacy-authority -xdev -type f -exec chmod 0660 {} +
fi

if [[ -d /var/lib/ai-mobile-testing/shared/authority-floor ]]; then
  node scripts/init-shared-authority-floor.mjs
fi

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
