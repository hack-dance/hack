# Records the highest guest memory in use during this boot, with the kernel's own memory
# pressure counters. Started once per fresh boot in the agent's background mode, beside the
# memory return step. Best-effort from start to finish: a counter that cannot be read is
# recorded as `unavailable`. It must never fail or delay a start, and it writes only to the
# boot's tmpfs, never under /storage.
#
# "In use" is MemTotal minus MemAvailable, minus the memory balloon: memory the kernel
# cannot get back by dropping cache, not counting what the provider has taken back for the
# host. The provider inflates the balloon to most of the guest when the pool has been idle
# for a while and lets it go seconds later. Balloon pages are not available to the guest,
# so without the correction an idle guest that uses 0.2 GiB records a "peak" near its whole
# size. A sample every five seconds can miss a short peak, so the line also carries
# counters the kernel keeps since boot (stall time, OOM kills, major faults), which cannot
# miss a guest that ran short of memory.
#
# The balloon is read before and after the memory figures and the larger reading is
# subtracted: a balloon that grows or shrinks during a sample can then only make the
# sample smaller, never invent a peak. The balloon is counted in the kernel's base pages;
# their size is read once from the sampler's own memory map. On a kernel that does not say,
# a sample taken while the balloon holds anything is not used at all.
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
page_file=/proc/self/smaps
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

# Sets `counted` to the page count given, or to `unavailable`. Unlike `check` the result is
# safe in shell arithmetic: leading zeros are dropped (a shell reads `08` as bad octal) and
# a count of more than twelve digits, which no guest can hold, is refused before it can
# overflow a multiplication.
count() {
  check "${1-}"
  counted=$checked
  if test "$counted" != unavailable; then
    counted=${counted#"${counted%%[!0]*}"}
    case "$counted" in
      '') counted=0 ;;
      ?????????????*) counted=unavailable ;;
    esac
  fi
}

# Sets `balloon` to the pages the balloon holds now, or to 0 when the kernel does not say.
# `nr_balloon_pages` is the size itself; older kernels offer only the two event counters.
read_balloon() {
  balloon_now=
  balloon_in=
  balloon_out=
  if test -r "$vmstat_file"; then
    while read -r key value rest; do
      case "$key" in
        nr_balloon_pages) balloon_now=$value ;;
        balloon_inflate) balloon_in=$value ;;
        balloon_deflate) balloon_out=$value ;;
      esac
    done < "$vmstat_file"
  fi
  count "$balloon_now"
  balloon=$counted
  if test "$balloon" = unavailable; then
    balloon=0
    count "$balloon_in"
    balloon_in=$counted
    count "$balloon_out"
    balloon_out=$counted
    if test "$balloon_in" != unavailable && test "$balloon_out" != unavailable &&
      test "$balloon_in" -ge "$balloon_out"; then
      balloon=$((balloon_in - balloon_out))
    fi
  fi
}

# The kernel's base page size in KiB, from the first mapping of this shell: 4, 16 or 64,
# or `unknown`. Read once; it cannot change while the guest runs.
page_kib=unknown
if test -r "$page_file"; then
  while read -r key value rest; do
    case "$key" in
      KernelPageSize:)
        case "$value" in
          4 | 16 | 64) page_kib=$value ;;
        esac
        break
        ;;
    esac
  done < "$page_file"
fi

peak=0
samples=0
rounds=0
while :; do
  read_balloon
  balloon_before=$balloon
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
  read_balloon
  if test "$balloon_before" -gt "$balloon"; then
    balloon=$balloon_before
  fi
  check "$total"
  total=$checked
  check "$available"
  available=$checked
  # A balloon of unknown page size cannot be subtracted; such a sample says nothing.
  usable=yes
  if test "$balloon" -gt 0 && test "$page_kib" = unknown; then
    usable=no
  fi
  if test "$usable" = yes && test "$total" != unavailable &&
    test "$available" != unavailable && test "$total" -ge "$available"; then
    used=$((total - available))
    held=0
    if test "$balloon" -gt 0; then
      held=$((balloon * page_kib))
    fi
    if test "$held" -gt "$used"; then
      held=$used
    fi
    used=$((used - held))
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
