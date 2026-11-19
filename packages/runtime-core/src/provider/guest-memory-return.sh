# Returns freed guest memory to the host sooner. Best-effort from start to finish: a missing
# knob, a refused write or a guest that never goes quiet is recorded and the script exits 0.
# It must never fail a start.
#
# 1. Free page reporting hands free blocks back to the host only from a minimum block size
#    up. The guest kernel's default is 2 MiB blocks, so free memory scattered in smaller
#    pieces stays charged to the VM. Order 2 is 16 KiB, the host's page size.
# 2. After the start-up work (image loads, installs, builds) the free memory is fragmented.
#    One compaction, once the guest has gone quiet, merges it into blocks that can be
#    reported. It waits for two quiet windows in a row and gives up after a bound.
#
# What it did is one line in the status file, for `cat` from the guest.
set -u
order_file=/sys/module/page_reporting/parameters/page_reporting_order
compact_file=/proc/sys/vm/compact_memory
stat_file=/proc/stat
status_file=/run/hack-local/memory-return.status
window_seconds=15
max_windows=240
# Busy time allowed in one window, in clock ticks: 15% of one CPU at 100 ticks a second.
quiet_ticks=$((window_seconds * 15))

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
  if test "$quiet" -ge 2; then
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
