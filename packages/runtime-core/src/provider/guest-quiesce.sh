# Exit 86 (agent::GUEST_IDENTITY_REFUSED): this guest's owner token, boot ID or engine
# identity does not match the receipt. Exit 42: the recorded engine did not exit in time.
set -eu
test "$(cat /storage/.hack-local-owner)" = "$1" || exit 86
test "$(cat /proc/sys/kernel/random/boot_id)" = "$2" || exit 86
pid=$3
start=$4
# On a resumed stop the recorded engine has exited once its PID is gone or names a later process.
if test "$5" = resume && { test ! -e "/proc/$pid/stat" || test "$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null)" != "$start"; }; then
  test ! -f /run/hack-local/docker.pid
  ! pidof dockerd
  ! pidof containerd
  sync
  printf 'quiesced\n'
  exit 0
fi
test "$(cat /run/hack-local/docker.pid)" = "$pid" || exit 86
test "$(readlink /proc/$pid/exe)" = /opt/hack-engine/dockerd || exit 86
test "$(awk '{print $22}' /proc/$pid/stat)" = "$start" || exit 86
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
