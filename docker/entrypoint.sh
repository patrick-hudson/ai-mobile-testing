#!/usr/bin/env bash
set -euo pipefail

audit_ca=/work/certs/development-ca.crt
installed_ca=/usr/local/share/ca-certificates/ai-mobile-testing-development-ca.crt
baked_ca=/usr/local/share/ca-certificates/ai-mobile-testing-netskope-ca.crt
embedded_runner_revision=/work/.audit-runner-revision

if [[ -f "$embedded_runner_revision" ]]; then
  image_runner_revision="$(tr -d '\r\n' < "$embedded_runner_revision")"
  if [[ ! "$image_runner_revision" =~ ^image:sha256:[a-f0-9]{64}$ ]]; then
    printf '[AUDIT_BOOT] Embedded runner revision is invalid; refusing unbound execution.\n' >&2
    exit 2
  fi
  if [[ -n "${AUDIT_RUNNER_REVISION:-}" && "$AUDIT_RUNNER_REVISION" != "$image_runner_revision" ]]; then
    printf '[AUDIT_BOOT] Configured runner revision does not match the immutable image revision.\n' >&2
    exit 2
  fi
  export AUDIT_RUNNER_REVISION="$image_runner_revision"
  printf '[AUDIT_BOOT] Runner source is bound to %s.\n' "$AUDIT_RUNNER_REVISION"
fi

# Docker Desktop bind mounts retain the macOS host owner's numeric UID/GID and
# can reject chown(2), even for container root. First probe whether ordinary
# ownership transitions work. Linux bind mounts and named volumes stay on the
# image identities. Only an ownership-locked bind is mapped to its existing
# owner/group, and every collision is handled explicitly before a worker moves.
if [[ "$(id -u)" = "0" && -d /work/artifacts ]]; then
  artifact_owner_uid="$(stat -c '%u' /work/artifacts)"
  artifact_owner_gid="$(stat -c '%g' /work/artifacts)"
  current_runner_uid="$(id -u pwuser)"
  current_runner_gid="$(id -g pwuser)"
  # Every compose-run container has the same low PID inside its own namespace,
  # so a PID-derived path collides when shards share the artifact bind mount.
  # mktemp performs the name selection and directory creation atomically on the
  # shared filesystem, which keeps concurrent shard startup race-free.
  ownership_probe="$(mktemp -d -p /work/artifacts .audit-ownership-probe.XXXXXX)"
  chmod 0700 "$ownership_probe"
  ownership_transition_supported=0
  if [[ "${AUDIT_ENTRYPOINT_TEST_MODE:-0}" = "1" && "${AUDIT_ENTRYPOINT_TEST_FORCE_OWNERSHIP_LOCKED:-0}" = "1" ]]; then
    printf '[AUDIT_BOOT] Test fixture is forcing ownership-locked artifact behavior.\n'
  elif chown "$current_runner_uid:$current_runner_gid" "$ownership_probe" 2>/dev/null; then
    ownership_transition_supported=1
  fi
  if [[ "$ownership_transition_supported" = "1" ]]; then
    rmdir "$ownership_probe"
    printf '[AUDIT_BOOT] Artifact storage supports isolated ownership transitions; image worker identities retained.\n'
  else
    rmdir "$ownership_probe"
    if [[ "$artifact_owner_uid" = "0" || "$artifact_owner_gid" = "0" ]]; then
      printf '[AUDIT_BOOT] Ownership-locked artifact storage must have a non-root owner and group; refusing an unsafe world-writable fallback.\n' >&2
      exit 2
    fi

    existing_owner_name="$(getent passwd "$artifact_owner_uid" | cut -d: -f1 || true)"
    if [[ -n "$existing_owner_name" && "$existing_owner_name" != "pwuser" \
      && "$existing_owner_name" != "aiworker" && "$existing_owner_name" != "reportworker" ]]; then
      printf '[AUDIT_BOOT] Artifact UID %s belongs to image account %s; refusing an ambiguous ownership remap. Use a named volume or a bind owned by the invoking developer.\n' "$artifact_owner_uid" "$existing_owner_name" >&2
      exit 2
    fi

    next_free_uid() {
      local candidate=61000
      while getent passwd "$candidate" >/dev/null; do candidate=$((candidate + 1)); done
      printf '%s' "$candidate"
    }
    relocate_worker_uid() {
      local worker="$1"
      local replacement
      replacement="$(next_free_uid)"
      usermod --uid "$replacement" "$worker"
      chown -R "$replacement:$(id -g "$worker")" "/home/$worker"
      printf '[AUDIT_BOOT] %s UID collision moved safely to %s before runner alignment.\n' "$worker" "$replacement"
    }
    if [[ "$artifact_owner_uid" = "$(id -u aiworker)" ]]; then relocate_worker_uid aiworker; fi
    if [[ "$artifact_owner_uid" = "$(id -u reportworker)" ]]; then relocate_worker_uid reportworker; fi
    if [[ "$artifact_owner_uid" != "$(id -u pwuser)" ]]; then
      usermod --uid "$artifact_owner_uid" pwuser
    fi

    current_runner_group="$(id -gn pwuser)"
    artifact_group_name="$(getent group "$artifact_owner_gid" | cut -d: -f1 || true)"
    if [[ -n "$artifact_group_name" && "$artifact_group_name" != "$current_runner_group" ]]; then
      # Numeric GIDs are the kernel capability. Do not silently make audit
      # workers members of a pre-existing image group such as dialout. Move an
      # unused base-image group aside, and fail closed if it owns container
      # resources that would otherwise be reassigned to the audit workers.
      exact_mount_target() {
        findmnt --noheadings --raw --output TARGET --mountpoint "$1" 2>/dev/null || true
      }
      mount_options() {
        findmnt --noheadings --raw --output OPTIONS --mountpoint "$1" 2>/dev/null || true
      }
      allowed_workspace_mounts=()
      if [[ "$(exact_mount_target /work/artifacts)" = "/work/artifacts" ]]; then
        allowed_workspace_mounts+=(/work/artifacts)
      fi
      if [[ "$(exact_mount_target /work/certs)" = "/work/certs" ]]; then
        cert_mount_options="$(mount_options /work/certs)"
        case ",$cert_mount_options," in
          *,ro,*) allowed_workspace_mounts+=(/work/certs) ;;
        esac
      fi
      if [[ "$(exact_mount_target /work/tests/__screenshots__)" = "/work/tests/__screenshots__" ]]; then
        allowed_workspace_mounts+=(/work/tests/__screenshots__)
      fi
      protected_find_arguments=(-xdev '(')
      if [[ "${#allowed_workspace_mounts[@]}" -gt 0 ]]; then
        protected_find_arguments+=('(')
        first_allowed_mount=1
        for allowed_root in "${allowed_workspace_mounts[@]}"; do
          if [[ "$first_allowed_mount" = "0" ]]; then protected_find_arguments+=(-o); fi
          protected_find_arguments+=(-path "$allowed_root" -o -path "$allowed_root/*")
          first_allowed_mount=0
        done
        protected_find_arguments+=(')' -prune -o)
      fi
      protected_find_arguments+=('(' -gid "$artifact_owner_gid" -print -quit ')' ')')
      protected_group_path="$(find / "${protected_find_arguments[@]}" 2>/dev/null || true)"
      if [[ -z "$protected_group_path" ]]; then
        protected_group_path="$(find /dev -xdev -gid "$artifact_owner_gid" -print -quit 2>/dev/null || true)"
      fi
      if [[ -n "$protected_group_path" ]]; then
        printf '[AUDIT_BOOT] Artifact GID %s is already trusted by image path %s; refusing to broaden worker access. Use a named volume or a different host group.\n' "$artifact_owner_gid" "$protected_group_path" >&2
        exit 2
      fi
      replacement_gid=62000
      while getent group "$replacement_gid" >/dev/null; do replacement_gid=$((replacement_gid + 1)); done
      groupmod --gid "$replacement_gid" "$artifact_group_name"
      printf '[AUDIT_BOOT] Existing image group %s moved from host artifact GID %s to %s.\n' "$artifact_group_name" "$artifact_owner_gid" "$replacement_gid"
    fi
    if [[ "$current_runner_group" != "auditartifacts" ]]; then
      if getent group auditartifacts >/dev/null; then
        printf '[AUDIT_BOOT] Dedicated auditartifacts group already exists unexpectedly; refusing an ambiguous remap.\n' >&2
        exit 2
      fi
      groupmod --new-name auditartifacts "$current_runner_group"
    fi
    if [[ "$(getent group auditartifacts | cut -d: -f3)" != "$artifact_owner_gid" ]]; then
      groupmod --gid "$artifact_owner_gid" auditartifacts
    fi
    for worker in pwuser aiworker reportworker; do
      usermod --gid auditartifacts --groups auditartifacts "$worker"
      chown -R "$(id -u "$worker"):$artifact_owner_gid" "/home/$worker"
    done
    printf '[AUDIT_BOOT] Playwright runner UID aligned with ownership-locked artifact storage (%s).\n' "$artifact_owner_uid"
    printf '[AUDIT_BOOT] Workers aligned through dedicated auditartifacts GID %s; pre-existing image group access was not inherited.\n' "$artifact_owner_gid"
  fi
fi

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

case "${PORTAL_E2E_RUN_AS_ARTIFACT_OWNER-0}" in
  0) ;;
  1)
    if [[ "$(id -u)" != "0" ]]; then
      printf '[AUDIT_BOOT] PORTAL_E2E_RUN_AS_ARTIFACT_OWNER requires the container entrypoint to start as root.\n' >&2
      exit 2
    fi
    if [[ ! -d /work/artifacts ]]; then
      printf '[AUDIT_BOOT] PORTAL_E2E_RUN_AS_ARTIFACT_OWNER requires /work/artifacts to be a mounted directory.\n' >&2
      exit 2
    fi

    portal_e2e_owner_uid="$(stat -c '%u' /work/artifacts 2>/dev/null || true)"
    portal_e2e_owner_gid="$(stat -c '%g' /work/artifacts 2>/dev/null || true)"
    if [[ ! "$portal_e2e_owner_uid" =~ ^[0-9]+$ || ! "$portal_e2e_owner_gid" =~ ^[0-9]+$ \
      || "$portal_e2e_owner_uid" = "0" || "$portal_e2e_owner_gid" = "0" ]]; then
      printf '[AUDIT_BOOT] PORTAL_E2E_RUN_AS_ARTIFACT_OWNER requires a non-root artifact owner UID and GID.\n' >&2
      exit 2
    fi
    if ! command -v setpriv >/dev/null 2>&1; then
      printf '[AUDIT_BOOT] PORTAL_E2E_RUN_AS_ARTIFACT_OWNER requires setpriv.\n' >&2
      exit 2
    fi

    portal_e2e_home="$(mktemp -d -p /tmp portal-e2e-home.XXXXXX)"
    chown "$portal_e2e_owner_uid:$portal_e2e_owner_gid" "$portal_e2e_home"
    chmod 0700 "$portal_e2e_home"
    export HOME="$portal_e2e_home"
    # portal-e2e's child server must stay under this same non-root identity;
    # the root-supervisor-only worker identities would require setuid(2).
    unset PORTAL_RUNNER_UID PORTAL_RUNNER_GID
    unset PORTAL_AI_WORKER_UID PORTAL_AI_WORKER_GID
    unset PORTAL_REPORT_WORKER_UID PORTAL_REPORT_WORKER_GID
    printf '[AUDIT_BOOT] portal-e2e is running as artifact owner %s:%s with HOME=%s.\n' "$portal_e2e_owner_uid" "$portal_e2e_owner_gid" "$HOME"
    exec setpriv --reuid "$portal_e2e_owner_uid" --regid "$portal_e2e_owner_gid" --clear-groups --no-new-privs -- "$@"
    ;;
  *)
    printf '[AUDIT_BOOT] PORTAL_E2E_RUN_AS_ARTIFACT_OWNER must be exactly 0 or 1.\n' >&2
    exit 2
    ;;
esac

case "${PORTAL_E2E_RESTORE_ARTIFACT_OWNER-0}" in
  0) ;;
  1)
    if [[ "${PORTAL_E2E_RUN_AS_ARTIFACT_OWNER-0}" != "0" ]]; then
      printf '[AUDIT_BOOT] Portal E2E cannot both run as and restore the artifact owner.\n' >&2
      exit 2
    fi
    if [[ "$(id -u)" != "0" ]]; then
      printf '[AUDIT_BOOT] PORTAL_E2E_RESTORE_ARTIFACT_OWNER requires the isolated-worker root supervisor.\n' >&2
      exit 2
    fi
    if [[ ! -d /work/artifacts || -L /work/artifacts ]]; then
      printf '[AUDIT_BOOT] PORTAL_E2E_RESTORE_ARTIFACT_OWNER requires /work/artifacts to be a real mounted directory.\n' >&2
      exit 2
    fi

    portal_e2e_owner_uid="$(stat -c '%u' /work/artifacts 2>/dev/null || true)"
    portal_e2e_owner_gid="$(stat -c '%g' /work/artifacts 2>/dev/null || true)"
    if [[ ! "$portal_e2e_owner_uid" =~ ^[0-9]+$ || ! "$portal_e2e_owner_gid" =~ ^[0-9]+$ \
      || "$portal_e2e_owner_uid" = "0" || "$portal_e2e_owner_gid" = "0" ]]; then
      printf '[AUDIT_BOOT] PORTAL_E2E_RESTORE_ARTIFACT_OWNER requires a non-root artifact owner UID and GID.\n' >&2
      exit 2
    fi

    printf '[AUDIT_BOOT] portal-e2e retains the root supervisor for isolated workers; exact output ownership will return to %s:%s.\n' "$portal_e2e_owner_uid" "$portal_e2e_owner_gid"
    set +e
    "$@"
    portal_e2e_status=$?
    set -e
    portal_e2e_output=/work/artifacts/portal-e2e
    if [[ -e "$portal_e2e_output" ]]; then
      if [[ ! -d "$portal_e2e_output" || -L "$portal_e2e_output" ]]; then
        printf '[AUDIT_BOOT] Portal E2E output became unsafe; refusing recursive ownership restoration.\n' >&2
        exit 2
      fi
      chown -R --no-dereference "$portal_e2e_owner_uid:$portal_e2e_owner_gid" "$portal_e2e_output"
    fi
    exit "$portal_e2e_status"
    ;;
  *)
    printf '[AUDIT_BOOT] PORTAL_E2E_RESTORE_ARTIFACT_OWNER must be exactly 0 or 1.\n' >&2
    exit 2
    ;;
esac

exec "$@"
