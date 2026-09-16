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
 test ! -e "$control/pending" && test ! -L "$control/pending"
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
  case "$phase" in launching|closing|cancelled|stopped) :;; *) exit 1;; esac
 fi
 test "$serial" -ge "$seen"
 if test "$serial" -eq "$seen"; then test "$previous" = "$allocation"; fi
 case "$action" in
 start)
  test "$serial" -gt "$seen"
  case "$phase" in empty|cancelled|stopped) :;; *) exit 1;; esac
  fence_write launching
  ;;
 stop)
  if test "$serial" -gt "$seen"; then
   case "$phase" in empty|cancelled|stopped) :;; *) exit 1;; esac
   test ! -e "$root" && test ! -L "$root"
   test ! -e "$socket" && test ! -L "$socket"
   fence_write cancelled
   printf 'stopped\n'; exit
  fi
  if test "$phase" = cancelled; then
   test ! -e "$root" && test ! -L "$root"
   printf 'stopped\n'; exit
  fi
  fence_write closing
  ;;
 remove)
  test "$serial" -eq "$seen"
  case "$phase" in cancelled|stopped) :;; *) exit 1;; esac
  ;;
 inspect)
  test "$serial" -eq "$seen"
  if test "$phase" = cancelled; then
   test ! -e "$root" && test ! -L "$root"
   printf 'exited\n'; exit
  fi
  ;;
 *) exit 1;;
 esac
fi
