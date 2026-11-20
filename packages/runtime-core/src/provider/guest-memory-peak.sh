# Records the highest guest memory in use during this boot, with the kernel's own memory
# pressure counters. Started once per fresh boot in the agent's background mode, beside the
# memory return step. Best-effort from start to finish: a counter that cannot be read is
# recorded as `unavailable`. It must never fail or delay a start, and it writes only to the
# boot's tmpfs, never under /storage.
#
# "In use" is MemTotal minus MemAvailable: memory the kernel cannot get back by dropping
# cache. A sample every five seconds can miss a short peak, so the line also carries
# counters the kernel keeps since boot (stall time, OOM kills, major faults), which cannot
# miss a guest that ran short of memory.
#
# Every sample is read with shell builtins. The loop starts one process per sample, `sleep`.
# The host reads the one-line status file; it is rewritten on every sample.
set -u
# Identity first, as every guest script: another pool's guest or a later boot is left alone.
test "$(cat /storage/.hack-local-owner 2>/dev/null)" = "${1-}" || exit 0
test "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" = "${2-}" || exit 0

meminfo_file=/proc/meminfo
pressure_file=/proc/pressure/memory
vmstat_file=/proc/vmstat
status_file=/run/hack-local/memory-peak.status
# At most one sampler per boot: /run/hack-local is a tmpfs made at boot.
marker_file=/run/hack-local/memory-peak.started
interval_seconds=5
# 0 samples until the guest stops.
max_rounds=0

if ! (set -C; : > "$marker_file") 2>/dev/null; then
  exit 0
fi

# Sets `checked` to the decimal number given, or to `unavailable`. A function that sets a
# variable, where `$(...)` would start a process.
check() {
  case "${1-}" in
    '' | *[!0-9]*) checked=unavailable ;;
    *) checked=$1 ;;
  esac
}

peak=0
samples=0
rounds=0
while :; do
  total=
  available=
  if test -r "$meminfo_file"; then
    while read -r key value rest; do
      case "$key" in
        MemTotal:) total=$value ;;
        MemAvailable:)
          available=$value
          break
          ;;
      esac
    done < "$meminfo_file"
  fi
  check "$total"
  total=$checked
  check "$available"
  available=$checked
  if test "$total" != unavailable && test "$available" != unavailable &&
    test "$total" -ge "$available"; then
    used=$((total - available))
    samples=$((samples + 1))
    if test "$used" -gt "$peak"; then
      peak=$used
    fi
  fi

  some=
  full=
  if test -r "$pressure_file"; then
    while read -r kind ten sixty three_hundred stalled rest; do
      case "$kind" in
        some) some=${stalled#total=} ;;
        full) full=${stalled#total=} ;;
      esac
    done < "$pressure_file"
  fi

  oom=
  major=
  if test -r "$vmstat_file"; then
    while read -r key value rest; do
      case "$key" in
        oom_kill) oom=$value ;;
        pgmajfault) major=$value ;;
      esac
    done < "$vmstat_file"
  fi

  check "$some"
  some=$checked
  check "$full"
  full=$checked
  check "$oom"
  oom=$checked
  check "$major"
  major=$checked
  # One short write. A reader that catches the file empty treats it as no reading.
  {
    printf 'memory-peak-v1 peak_kib=%s samples=%s total_kib=%s some_us=%s full_us=%s oom_kill=%s pgmajfault=%s\n' \
      "$peak" "$samples" "$total" "$some" "$full" "$oom" "$major" > "$status_file"
  } 2>/dev/null

  rounds=$((rounds + 1))
  if test "$max_rounds" -gt 0 && test "$rounds" -ge "$max_rounds"; then
    exit 0
  fi
  sleep "$interval_seconds"
done
