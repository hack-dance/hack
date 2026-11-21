# Returns freed guest memory to the host sooner. Started once per fresh boot in the agent's
# background mode, after the engine answers. Best-effort from start to finish: a missing
# knob, a refused write or a guest that never goes quiet is recorded and the script exits 0.
# It must never fail or delay a start, and it writes nothing under /storage.
#
# 1. Free page reporting hands free blocks back to the host only from a minimum block size
#    up. The guest kernel's default is 2 MiB blocks, so free memory scattered in smaller
#    pieces stays charged to the VM. Order 2 is 16 KiB, the host's page size.
# 2. After the start-up work (image loads, installs, builds) the free memory is fragmented.
#    One compaction, once the guest has gone quiet, merges it into blocks that can be
#    reported. It waits for six quiet windows in a row (90 s) and gives up after 15 minutes.
#    The wait is longer than the provider agent's own page-cache trim, which needs one quiet
#    minute: compacting before that trim leaves the cache's memory to be freed afterwards,
#    fragmented again.
#
# What it did is one line in the status file, for `cat` from the guest.
set -u
# Identity first, as every guest script: another pool's guest or a later boot is left alone.
test "$(cat /storage/.hack-local-owner 2>/dev/null)" = "${1-}" || exit 0
test "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" = "${2-}" || exit 0

order_file=/sys/module/page_reporting/parameters/page_reporting_order
compact_file=/proc/sys/vm/compact_memory
stat_file=/proc/stat
status_file=/run/hack-local/memory-return.status
# At most one compaction per boot: /run/hack-local is a tmpfs made at boot.
marker_file=/run/hack-local/memory-return.started
window_seconds=15
max_windows=60
quiet_windows=6
# Busy time allowed in one window, in clock ticks: 15% of one CPU at 100 ticks a second.
quiet_ticks=$((window_seconds * 15))

if ! (set -C; : > "$marker_file") 2>/dev/null; then
  exit 0
fi

order=unavailable
if test -w "$order_file"; then
  if (printf '2\n' > "$order_file") 2>/dev/null; then
    order=$(cat "$order_file" 2>/dev/null || printf unknown)
  else
    order=refused
  fi
fi

# User, nice, system, interrupt, soft-interrupt and steal ticks, all CPUs together.
busy_ticks() {
  awk '$1 == "cpu" { printf "%d\n", $2 + $3 + $4 + $7 + $8 + $9; exit }' "$stat_file" 2>/dev/null
}

record() {
  line="memory-return-v1 order=$order compaction=$1 windows=$2"
  if (printf '%s\n' "$line" > "$status_file.tmp" && mv "$status_file.tmp" "$status_file") 2>/dev/null; then
    :
  fi
  printf '%s\n' "$line"
}

if ! test -w "$compact_file"; then
  record unavailable 0
  exit 0
fi

windows=0
quiet=0
previous=$(busy_ticks)
while test "$windows" -lt "$max_windows"; do
  sleep "$window_seconds"
  windows=$((windows + 1))
  current=$(busy_ticks)
  for ticks in "$previous" "$current"; do
    case "$ticks" in
      '' | *[!0-9]*) record unreadable "$windows"; exit 0 ;;
    esac
  done
  if test $((current - previous)) -lt "$quiet_ticks"; then
    quiet=$((quiet + 1))
  else
    quiet=0
  fi
  previous=$current
  if test "$quiet" -ge "$quiet_windows"; then
    if (printf '1\n' > "$compact_file") 2>/dev/null; then
      record done "$windows"
    else
      record refused "$windows"
    fi
    exit 0
  fi
done
record gave-up "$windows"
exit 0
