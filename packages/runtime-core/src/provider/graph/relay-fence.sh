# One boot-local lock and monotonic fence per slot; never one tombstone per attempt.
serial=${9}; slot=${10}
fence_write() {
 (set -C; printf '%s %s %s\n' "$serial" "$allocation" "$1" > "$control/pending")
 mv "$control/pending" "$control/state"
}
if test "$serial" -ne 0; then
 controls=/run/hack-local/relay-slots
 test ! -L "$controls"
 if test ! -e "$controls"; then mkdir -m 700 "$controls"; fi
 private_dir "$controls"
 control="$controls/slot-$slot"
 test ! -L "$control"
 if test ! -e "$control"; then mkdir -m 700 "$control"; fi
 private_dir "$control"
 if test ! -e "$control/lock" && test ! -L "$control/lock"; then
  (set -C; : > "$control/lock") || test -e "$control/lock"
 fi
 private_file "$control/lock"
 exec 9<> "$control/lock"
 flock -w 7 9
 seen=0; previous=-; phase=empty
 if test -e "$control/state" || test -L "$control/state"; then
  private_file "$control/state"
  fields=$(cat "$control/state")
  # Fixed fields are validated before numeric comparisons or paths are used.
  set -- $fields
  test "$#" = 3
  seen=$1; previous=$2; phase=$3
  case "$seen" in ''|*[!0-9]*) exit 1;; esac
  test "$seen" -gt 0
  case "$previous" in *[!0-9a-f]*) exit 1;; esac
  test "${#previous}" = 32
  case "$phase" in preparing|discarding|discarded|launching|closing|cancelled|stopped) :;; *) exit 1;; esac
 fi
 test "$serial" -ge "$seen"
 if test "$serial" -eq "$seen"; then test "$previous" = "$allocation"; fi
 # Resume only complete, canonical writes along known transitions.
 # The old command cannot still run while this slot lock is held. Never replay a start.
 if test -e "$control/pending" || test -L "$control/pending"; then
  case "$action" in stop|remove) :;; *) exit 1;; esac
  private_file "$control/pending"
  set -- $(cat "$control/pending")
  test "$#" = 3; test "$1" = "$serial"; test "$2" = "$allocation"
  next=$3
  printf '%s %s %s\n' "$serial" "$allocation" "$next" | cmp -s - "$control/pending"
  if test "$serial" -eq "$seen"; then
   test "$previous" = "$allocation"
   case "$phase:$next" in
    preparing:launching|preparing:discarding|discarding:discarding|discarding:discarded|discarded:discarded|launching:closing|closing:closing|closing:stopped|stopped:closing) :;;
    *) exit 1;;
   esac
  else
   # A first publication precedes all allocation effects. Cancel only an empty slot.
   test "$action" = stop; test "$serial" -gt "$seen"
   case "$phase" in empty|cancelled|stopped|discarded) :;; *) exit 1;; esac
   case "$next" in preparing|cancelled) :;; *) exit 1;; esac
   test ! -e "$root"; test ! -L "$root"
   test ! -e "$socket"; test ! -L "$socket"
  fi
  mv "$control/pending" "$control/state"
  phase=$next; seen=$serial; previous=$allocation
 fi
 case "$action" in
 start)
  test "$serial" -gt "$seen"
  case "$phase" in empty|cancelled|stopped|discarded) :;; *) exit 1;; esac
  fence_write preparing
  ;;
 stop)
  if test "$serial" -gt "$seen"; then
   case "$phase" in empty|cancelled|stopped|discarded) :;; *) exit 1;; esac
   test ! -e "$root"; test ! -L "$root"
   test ! -e "$socket"; test ! -L "$socket"
   fence_write cancelled
   printf 'stopped\n'; exit
  fi
  if test "$phase" = cancelled; then
   test ! -e "$root"; test ! -L "$root"
   printf 'stopped\n'; exit
  fi
  case "$phase" in
  preparing|discarding|discarded)
   if test "$phase" != discarded; then fence_write discarding; fi
   check_staging
   fence_write discarded
   printf 'stopped\n'; exit
   ;;
  esac
  fence_write closing
  ;;
 remove)
  test "$serial" -eq "$seen"
  case "$phase" in cancelled|stopped|discarded) :;; *) exit 1;; esac
  ;;
 inspect)
  test "$serial" -eq "$seen"
  case "$phase" in preparing|discarding|discarded)
   check_staging; printf 'exited\n'; exit;;
  esac
  if test "$phase" = cancelled; then
   test ! -e "$root"; test ! -L "$root"
   printf 'exited\n'; exit
  fi
  ;;
 *) exit 1;;
 esac
fi
