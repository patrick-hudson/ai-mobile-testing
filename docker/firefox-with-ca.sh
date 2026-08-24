#!/usr/bin/env bash
set -euo pipefail

ca_certificate=${PLAYWRIGHT_FIREFOX_CA_CERT:-/usr/local/share/ca-certificates/ai-mobile-testing-netskope-ca.crt}
certificate_nickname='ai-mobile-testing development CA'
profile_directory=

arguments=("$@")
for ((argument_index = 0; argument_index < ${#arguments[@]}; argument_index += 1)); do
  case "${arguments[$argument_index]}" in
    -profile|--profile)
      next_index=$((argument_index + 1))
      if ((next_index < ${#arguments[@]})); then
        profile_directory=${arguments[$next_index]}
      fi
      ;;
    -profile=*|--profile=*)
      profile_directory=${arguments[$argument_index]#*=}
      ;;
  esac
done

if [[ -z "$profile_directory" ]]; then
  printf '[AUDIT_FIREFOX_TLS] Refusing to launch: Playwright did not supply a Firefox profile.\n' >&2
  exit 64
fi

profile_directory=$(realpath -m -- "$profile_directory")
case "$profile_directory" in
  /tmp/playwright_firefoxdev_profile-*) ;;
  *)
    printf '[AUDIT_FIREFOX_TLS] Refusing unexpected Firefox profile path: %s\n' "$profile_directory" >&2
    exit 64
    ;;
esac

if [[ ! -r "$ca_certificate" ]]; then
  printf '[AUDIT_FIREFOX_TLS] Refusing to launch: CA certificate is unreadable at %s.\n' "$ca_certificate" >&2
  exit 66
fi

shopt -s nullglob
firefox_candidates=(/ms-playwright/firefox-*/firefox/firefox)
if ((${#firefox_candidates[@]} != 1)); then
  printf '[AUDIT_FIREFOX_TLS] Expected exactly one bundled Firefox binary; found %d.\n' "${#firefox_candidates[@]}" >&2
  exit 69
fi
firefox_executable=${firefox_candidates[0]}

mkdir -p -- "$profile_directory"
if [[ ! -f "$profile_directory/cert9.db" ]]; then
  certutil -N --empty-password -d "sql:$profile_directory"
fi
certutil -A \
  -d "sql:$profile_directory" \
  -n "$certificate_nickname" \
  -t 'CT,CT,' \
  -i "$ca_certificate"
certutil -L -d "sql:$profile_directory" -n "$certificate_nickname" >/dev/null

printf '[AUDIT_FIREFOX_TLS] Imported the configured development CA into the isolated Playwright Firefox profile; TLS verification remains enabled.\n' >&2
exec "$firefox_executable" "$@"
