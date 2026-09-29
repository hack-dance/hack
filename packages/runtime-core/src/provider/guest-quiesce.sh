set -eu
test "$(cat /storage/.hack-local-owner)" = "$1"
test "$(cat /proc/sys/kernel/random/boot_id)" = "$2"
pid=$3
start=$4
if test "$5" = resume && test ! -e "/proc/$pid/stat"; then
  test ! -f /run/hack-local/docker.pid
  ! pidof dockerd
  ! pidof containerd
  sync
  printf 'quiesced\n'
  exit 0
fi
test "$(cat /run/hack-local/docker.pid)" = "$pid"
test "$(readlink /proc/$pid/exe)" = /opt/hack-engine/dockerd
test "$(awk '{print $22}' /proc/$pid/stat)" = "$start"
kill -TERM "$pid"
for attempt in $(seq 1 300); do
  if test ! -e "/proc/$pid/stat"; then sync; printf 'quiesced\n'; exit 0; fi
  if test "$(awk '{print $22}' /proc/$pid/stat)" != "$start"; then sync; printf 'quiesced\n'; exit 0; fi
  if test "$(awk '{print $3}' /proc/$pid/stat)" = Z; then
    sync
    printf 'quiesced-zombie-awaiting-agent-reap\n'
    exit 0
  fi
  sleep 0.1
done
exit 42
