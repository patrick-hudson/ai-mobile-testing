#!/usr/bin/env bash
set -euo pipefail

image="${AUDIT_IDENTITY_TEST_IMAGE:-quitting7oh-release-audit:local}"
prefix="audit-identity-self-test-$$"
volumes=("$prefix-ai" "$prefix-report" "$prefix-root" "$prefix-protected-artifacts" "$prefix-protected-image" "$prefix-certs" "$prefix-parallel" "$prefix-queue")
repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
portal_e2e_bind_fixture=""

cleanup() {
  docker volume rm "${volumes[@]}" >/dev/null 2>&1 || true
  if [[ -n "$portal_e2e_bind_fixture" && -d "$portal_e2e_bind_fixture" ]]; then
    rm -f "$portal_e2e_bind_fixture/owner-proof.txt"
    rm -rf "$portal_e2e_bind_fixture/portal-e2e"
    rmdir "$portal_e2e_bind_fixture"
  fi
}
trap cleanup EXIT

initialize_volume() {
  local volume="$1"
  local owner="$2"
  docker volume create "$volume" >/dev/null
  docker run --rm --entrypoint chown -v "$volume:/work/artifacts" "$image" "$owner" /work/artifacts
}

run_locked_fixture() {
  local volume="$1"
  shift
  docker run --rm \
    -e AUDIT_ENTRYPOINT_TEST_MODE=1 \
    -e AUDIT_ENTRYPOINT_TEST_FORCE_OWNERSHIP_LOCKED=1 \
    -v "$volume:/work/artifacts" \
    "$image" "$@"
}

run_locked_fixture_with_readonly_certs() {
  local volume="$1"
  local cert_volume="$2"
  shift 2
  docker run --rm \
    -e AUDIT_ENTRYPOINT_TEST_MODE=1 \
    -e AUDIT_ENTRYPOINT_TEST_FORCE_OWNERSHIP_LOCKED=1 \
    -v "$volume:/work/artifacts" \
    -v "$cert_volume:/work/certs:ro" \
    "$image" "$@"
}

# portal-e2e is the sole compose service that opts into running as the numeric
# owner of the artifact bind. Use a real host directory so the proof covers
# both the effective process identity and host-visible output ownership.
mkdir -p "$repository_root/artifacts"
portal_e2e_bind_fixture="$(mktemp -d -p "$repository_root/artifacts" .portal-e2e-owner-test.XXXXXX)"
artifact_parent_uid="$(stat -c '%u' "$repository_root/artifacts")"
artifact_parent_gid="$(stat -c '%g' "$repository_root/artifacts")"
if [[ "$artifact_parent_uid" = "0" || "$artifact_parent_gid" = "0" ]]; then
  printf 'Docker portal-e2e ownership self-test requires the repository artifacts directory to have a non-root numeric owner and group.\n' >&2
  exit 1
fi
if [[ "$(stat -c '%u:%g' "$portal_e2e_bind_fixture")" != "$artifact_parent_uid:$artifact_parent_gid" ]]; then
  if [[ "$(stat -c '%u' "$portal_e2e_bind_fixture")" = "$artifact_parent_uid"
    && "$(id -u)" = "$artifact_parent_uid"
    && " $(id -G) " = *" $artifact_parent_gid "* ]]; then
    chgrp "$artifact_parent_gid" "$portal_e2e_bind_fixture"
  elif [[ "$(id -u)" = "0" ]]; then
    chown "$artifact_parent_uid:$artifact_parent_gid" "$portal_e2e_bind_fixture"
  else
    printf 'Docker portal-e2e ownership self-test cannot align its bind fixture with the artifacts directory owner.\n' >&2
    exit 1
  fi
fi

docker run --rm \
  -e PORTAL_E2E_RUN_AS_ARTIFACT_OWNER=1 \
  -v "$portal_e2e_bind_fixture:/work/artifacts" \
  "$image" sh -eu -c '
    artifact_uid="$(stat -c %u /work/artifacts)"
    artifact_gid="$(stat -c %g /work/artifacts)"
    test "$(id -u)" = "$artifact_uid"
    test "$(id -g)" = "$artifact_gid"
    test "$(id -G)" = "$artifact_gid"
    case "$HOME" in /tmp/portal-e2e-home.*) ;; *) exit 1 ;; esac
    test -d "$HOME"
    test -w "$HOME"
    test "$(stat -c %u:%g "$HOME")" = "$artifact_uid:$artifact_gid"
    : > "$HOME/write-proof"
    test -z "${PORTAL_RUNNER_UID+x}"
    test -z "${PORTAL_RUNNER_GID+x}"
    test -z "${PORTAL_AI_WORKER_UID+x}"
    test -z "${PORTAL_AI_WORKER_GID+x}"
    test -z "${PORTAL_REPORT_WORKER_UID+x}"
    test -z "${PORTAL_REPORT_WORKER_GID+x}"
    printf "%s:%s\n" "$(id -u)" "$(id -g)" > /work/artifacts/owner-proof.txt
  '
test "$(cat "$portal_e2e_bind_fixture/owner-proof.txt")" = "$artifact_parent_uid:$artifact_parent_gid"
test "$(stat -c '%u:%g' "$portal_e2e_bind_fixture/owner-proof.txt")" = "$artifact_parent_uid:$artifact_parent_gid"
test -r "$portal_e2e_bind_fixture/owner-proof.txt"
test -w "$portal_e2e_bind_fixture/owner-proof.txt"

set +e
docker run --rm \
  -e PORTAL_E2E_RESTORE_ARTIFACT_OWNER=1 \
  -v "$portal_e2e_bind_fixture:/work/artifacts" \
  "$image" sh -eu -c '
    test "$(id -u)" = 0
    test -n "${PORTAL_RUNNER_UID:-}"
    test -n "${PORTAL_AI_WORKER_UID:-}"
    test -n "${PORTAL_REPORT_WORKER_UID:-}"
    test "$PORTAL_RUNNER_UID" != "$PORTAL_AI_WORKER_UID"
    test "$PORTAL_RUNNER_UID" != "$PORTAL_REPORT_WORKER_UID"
    mkdir /work/artifacts/portal-e2e
    printf root-supervised > /work/artifacts/portal-e2e/restore-proof.txt
    exit 7
  '
restore_status=$?
set -e
test "$restore_status" = 7
test "$(cat "$portal_e2e_bind_fixture/portal-e2e/restore-proof.txt")" = root-supervised
test "$(stat -c '%u:%g' "$portal_e2e_bind_fixture/portal-e2e/restore-proof.txt")" = "$artifact_parent_uid:$artifact_parent_gid"

set +e
invalid_opt_in_output="$(docker run --rm \
  -e PORTAL_E2E_RUN_AS_ARTIFACT_OWNER=yes \
  -v "$portal_e2e_bind_fixture:/work/artifacts" \
  "$image" true 2>&1)"
invalid_opt_in_status=$?
set -e
test "$invalid_opt_in_status" = 2
case "$invalid_opt_in_output" in
  *"PORTAL_E2E_RUN_AS_ARTIFACT_OWNER must be exactly 0 or 1"*) ;;
  *) printf 'Invalid portal-e2e artifact-owner opt-in returned the wrong diagnostic:\n%s\n' "$invalid_opt_in_output" >&2; exit 1 ;;
esac

set +e
invalid_restore_output="$(docker run --rm \
  -e PORTAL_E2E_RESTORE_ARTIFACT_OWNER=yes \
  -v "$portal_e2e_bind_fixture:/work/artifacts" \
  "$image" true 2>&1)"
invalid_restore_status=$?
set -e
test "$invalid_restore_status" = 2
case "$invalid_restore_output" in
  *"PORTAL_E2E_RESTORE_ARTIFACT_OWNER must be exactly 0 or 1"*) ;;
  *) printf 'Invalid portal-e2e ownership-restore opt-in returned the wrong diagnostic:\n%s\n' "$invalid_restore_output" >&2; exit 1 ;;
esac

initialize_volume "${volumes[0]}" 1002:55555
run_locked_fixture "${volumes[0]}" sh -eu -c '
  test "$(id -u pwuser)" = 1002
  test "$(id -u aiworker)" != 1002
  test "$(stat -c %u /home/aiworker)" = "$(id -u aiworker)"
  test "$(id -g pwuser)" = 55555
  test "$(id -g aiworker)" = 55555
  test "$(id -g reportworker)" = 55555
  test "$(getent group auditartifacts | cut -d: -f3)" = 55555
'

initialize_volume "${volumes[1]}" 1003:20
initialize_volume "${volumes[5]}" 0:20
run_locked_fixture_with_readonly_certs "${volumes[1]}" "${volumes[5]}" sh -eu -c '
  test "$(id -u pwuser)" = 1003
  test "$(id -u reportworker)" != 1003
  test "$(stat -c %u /home/reportworker)" = "$(id -u reportworker)"
  test "$(id -g pwuser)" = 20
  test "$(getent group auditartifacts | cut -d: -f3)" = 20
  test "$(getent group dialout | cut -d: -f3)" != 20
  test "$(id -Gn pwuser)" = auditartifacts
'

# Compose shards share one artifact mount while each entrypoint sees the same
# container-local PID. Start enough containers together to prove the ownership
# probe uses an atomic unique directory rather than a namespace-local PID.
initialize_volume "${volumes[6]}" 1004:55556
parallel_pids=()
for _parallel_index in {1..8}; do
  docker run --rm -v "${volumes[6]}:/work/artifacts" "$image" true &
  parallel_pids+=("$!")
done
parallel_status=0
for parallel_pid in "${parallel_pids[@]}"; do
  if ! wait "$parallel_pid"; then parallel_status=1; fi
done
test "$parallel_status" = 0
test -z "$(docker run --rm --entrypoint sh -v "${volumes[6]}:/work/artifacts" "$image" -eu -c 'find /work/artifacts -maxdepth 1 -type d -name ".audit-ownership-probe.*" -print -quit')"

# The portal supervisor is root so it can launch isolated worker identities,
# while Single-site browser workers are deliberately non-root. Exercise the
# real queue implementation across those identities; mode-only mount probes
# cannot catch a root-created 0700 job directory.
docker volume create "${volumes[7]}" >/dev/null
docker run --rm \
  -v "${volumes[7]}:/var/lib/ai-mobile-testing/jobs" \
  "$image" bash docker/init-single-site-volumes.sh
docker run --rm \
  -e AUDIT_JOB_QUEUE_ROOT=/var/lib/ai-mobile-testing/jobs \
  -v "${volumes[7]}:/var/lib/ai-mobile-testing/jobs" \
  "$image" node scripts/docker-queue-identity-self-test.mjs submit
docker run --rm --user pwuser \
  -e AUDIT_JOB_QUEUE_ROOT=/var/lib/ai-mobile-testing/jobs \
  -v "${volumes[7]}:/var/lib/ai-mobile-testing/jobs" \
  "$image" node scripts/docker-queue-identity-self-test.mjs claim
docker run --rm \
  -e AUDIT_JOB_QUEUE_ROOT=/var/lib/ai-mobile-testing/jobs \
  -v "${volumes[7]}:/var/lib/ai-mobile-testing/jobs" \
  "$image" node scripts/docker-queue-identity-self-test.mjs verify

initialize_volume "${volumes[2]}" 0:0
set +e
root_drop_output="$(docker run --rm \
  -e PORTAL_E2E_RUN_AS_ARTIFACT_OWNER=1 \
  -v "${volumes[2]}:/work/artifacts" \
  "$image" true 2>&1)"
root_drop_status=$?
set -e
test "$root_drop_status" = 2
case "$root_drop_output" in
  *"requires a non-root artifact owner UID and GID"*) ;;
  *) printf 'Root-owned portal-e2e privilege-drop fixture returned the wrong diagnostic:\n%s\n' "$root_drop_output" >&2; exit 1 ;;
esac

set +e
root_output="$(run_locked_fixture "${volumes[2]}" true 2>&1)"
root_status=$?
set -e
test "$root_status" = 2
case "$root_output" in
  *"refusing an unsafe world-writable fallback"*) ;;
  *) printf 'Root-owned fail-closed fixture returned the wrong diagnostic:\n%s\n' "$root_output" >&2; exit 1 ;;
esac

initialize_volume "${volumes[3]}" 12004:20
initialize_volume "${volumes[4]}" 0:20
set +e
protected_output="$(docker run --rm \
  -e AUDIT_ENTRYPOINT_TEST_MODE=1 \
  -e AUDIT_ENTRYPOINT_TEST_FORCE_OWNERSHIP_LOCKED=1 \
  -v "${volumes[3]}:/work/artifacts" \
  -v "${volumes[4]}:/work/protected-identity-fixture" \
  "$image" true 2>&1)"
protected_status=$?
set -e
test "$protected_status" = 2
case "$protected_output" in
  *"Artifact GID 20 is already trusted by image path /work/protected-identity-fixture"*) ;;
  *) printf 'Protected image-path fixture returned the wrong diagnostic:\n%s\n' "$protected_output" >&2; exit 1 ;;
esac

printf 'Docker entrypoint identity self-test passed: portal-e2e host ownership, privilege drop, isolated-worker supervision, exact ownership restoration, concurrent shared-mount probes, cross-identity durable queue writes, auxiliary UID collisions, arbitrary and privileged GIDs, artifact-root exclusion, declared read-only certificate mounts, protected image-path rejection, home ownership, dedicated group mapping, and root-owned fail-closed behavior are enforced.\n'
