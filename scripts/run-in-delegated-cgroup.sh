#!/usr/bin/env bash
set -euo pipefail

if (( $# == 0 )); then
  echo 'usage: run-in-delegated-cgroup.sh COMMAND [ARG ...]' >&2
  exit 64
fi

quota_root=${DSH_SELF_EVOLVING_CGROUP_ROOT:-}
if [[ -z "$quota_root" ]]; then
  echo 'DSH_SELF_EVOLVING_CGROUP_ROOT is required' >&2
  exit 64
fi
quota_root=$(realpath -e -- "$quota_root")
case "$quota_root" in
  /sys/fs/cgroup/*) ;;
  *)
    echo 'delegated cgroup root must be beneath /sys/fs/cgroup' >&2
    exit 64
    ;;
esac

if (( EUID != 0 )); then
  script_path=$(realpath -e -- "$0")
  exec sudo env -i \
    "PATH=$PATH" \
    "HOME=$HOME" \
    "CI=${CI:-true}" \
    "DSH_SELF_EVOLVING_CGROUP_ROOT=$quota_root" \
    "DSH_SELF_EVOLVING_RUN_UID=$(id -u)" \
    "DSH_SELF_EVOLVING_RUN_GID=$(id -g)" \
    /bin/bash "$script_path" "$@"
fi

run_uid=${DSH_SELF_EVOLVING_RUN_UID:-}
run_gid=${DSH_SELF_EVOLVING_RUN_GID:-}
if [[ ! "$run_uid" =~ ^[1-9][0-9]*$ ]] || [[ ! "$run_gid" =~ ^[0-9]+$ ]]; then
  echo 'non-root numeric DSH_SELF_EVOLVING_RUN_UID/RUN_GID are required' >&2
  exit 64
fi

executor="$quota_root/executor-$BASHPID"
mkdir -- "$executor"

cleanup() {
  local attempt
  if [[ -e "$executor/cgroup.kill" ]]; then
    printf '1\n' > "$executor/cgroup.kill" 2>/dev/null || true
  fi
  for (( attempt = 0; attempt < 100; attempt += 1 )); do
    if rmdir -- "$executor" 2>/dev/null; then
      return 0
    fi
    sleep 0.01
  done
  echo "failed to remove executor cgroup: $executor" >&2
  return 1
}
trap 'cleanup >/dev/null 2>&1 || true' EXIT

set +e
(
  printf '%s\n' "$BASHPID" > "$executor/cgroup.procs"
  exec setpriv \
    --reuid="$run_uid" \
    --regid="$run_gid" \
    --init-groups \
    -- \
    "$@"
)
command_status=$?
set -e

cleanup
trap - EXIT
exit "$command_status"
