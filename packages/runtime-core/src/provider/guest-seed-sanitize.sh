set -eu
export LC_ALL=C
# Last guest step of a prepared-base seed build: prove there is no application state, stop the
# engine cleanly, remove per-pool identity, and sync. Bound to this seed's owner and boot.
test "$(cat /storage/.hack-local-owner)" = "$1"
test "$(cat /proc/sys/kernel/random/boot_id)" = "$2"
if test -d /storage/docker/containers && test -n "$(ls -A /storage/docker/containers)"; then
  printf 'Seed has containers.\n' >&2
  exit 91
fi
if test -d /storage/docker/volumes; then
  for entry in /storage/docker/volumes/* /storage/docker/volumes/.[!.]*; do
    test -e "$entry" || test -L "$entry" || continue
    case "${entry##*/}" in
      metadata.db | backingFsBlockDev) ;;
      *) printf 'Seed has volumes.\n' >&2; exit 92 ;;
    esac
  done
fi
# A stopped engine may stay a zombie (its parent does not reap it), which `kill -0` still sees.
running() {
  test -r "/proc/$1/stat" || return 1
  state="$(sed 's/^.*) //' "/proc/$1/stat" | cut -d ' ' -f 1)"
  test "$state" != Z
}
pid="$(cat /run/hack-local/docker.pid)"
kill -TERM "$pid"
tries=0
while running "$pid"; do
  tries=$((tries + 1))
  if test "$tries" -gt 300; then
    printf 'Seed engine did not stop.\n' >&2
    exit 93
  fi
  sleep 0.1
done
rm -f /storage/docker/engine-id /storage/hack-local-dockerd.log
rm -rf /storage/docker/network/files /storage/docker/buildkit /storage/docker/tmp
# Engine runtime residue (`/run` is on the overlay disk here, not tmpfs) and host-probe caches.
# The engine recreates these at its next start; images live in the overlay2 graph driver.
rm -rf /storage/docker/containerd /run/docker /run/containerd /opt/containerd /run/blkid /run/mount
rm -f /storage/.hack-local-owner
sync
printf 'prepared-seed-sanitized-v1\n'
