# Read-only selection/retry proof for an exited, launch-fenced bridge helper.
# Capture/verify never mutate. finish-empty removes only a pinned empty allocation
# after its committed stopped fence, under the same exclusive guest slot lock.
set -efu
stage=1
trap 'status=$?; if test "$status" -ne 0; then printf "relay-normalization-refused %s\n" "$stage"; exit 0; fi' 0
exec 2>/dev/null
action=$1; allocation=$2; marker=$3; socket=$4; digest=$5; serial=$6; slot=$7
expected=${8:-}
base=/run/hack-local/graph-relays
root="$base/$allocation"
control=/run/hack-local/relay-slots/slot-$slot
private_dir() { test ! -L "$1" && test -d "$1" && test "$(stat -c %u:%g:%a "$1")" = 0:0:700; }
private_file() { test ! -L "$1" && test -f "$1" && test "$(stat -c %u:%g:%a:%h "$1")" = 0:0:600:1 && test "$(stat -c %s "$1")" -le 256; }
absent() { test ! -e "$1" && test ! -L "$1"; }
number() { case "$1" in ''|*[!0-9]*) return 1;; esac; test "$1" -gt 0; }
identity() { stat -c %d:%i "$1"; }
stage=2
private_dir /run/hack-local
test "$(findmnt -n -o FSTYPE --target /run/hack-local)" = tmpfs
private_dir /run/hack-local/relay-slots
private_dir "$control"; private_file "$control/lock"
control_id=$(identity "$control"); lock_id=$(identity "$control/lock")
exec 9< "$control/lock"
if test "$action" = finish-empty; then flock -x -w 5 9; else flock -s -w 5 9; fi
test "$(identity "$control")" = "$control_id"
test "$(stat -Lc %d:%i /proc/$$/fd/9)" = "$lock_id"
test "$(identity "$control/lock")" = "$lock_id"
stage=3
private_file "$control/state"
set -- $(cat "$control/state")
test "$#" = 3; test "$1" = "$serial"; test "$2" = "$allocation"
phase=$3
printf '%s %s %s\n' "$serial" "$allocation" "$phase" | cmp -s - "$control/state"
case "$phase" in launching|closing|stopped) :;; *) exit 1;; esac
# NORMALIZATION_PENDING_BEGIN
if ! absent "$control/pending"; then
 test "$action" != capture
 private_file "$control/pending"
 set -- $(cat "$control/pending")
 test "$#" = 3; test "$1" = "$serial"; test "$2" = "$allocation"
 next=$3
 printf '%s %s %s\n' "$serial" "$allocation" "$next" | cmp -s - "$control/pending"
 case "$phase:$next" in launching:closing|closing:closing|closing:stopped|stopped:closing) :;; *) exit 1;; esac
 # Read-only admission. Ordinary stop promotes this under its exclusive lock.
fi
# NORMALIZATION_PENDING_END
if test "$action" = capture; then
 test "$phase" = launching
 stage=4
 private_dir "$base"; private_dir "$root"; private_file "$root/owner"
 test "$(cat "$root/owner")" = "$marker"
 root_id=$(identity "$root")
 stage=5
 test ! -L "$root/relay"; test -f "$root/relay"
 test "$(stat -c %u:%g:%a:%h "$root/relay")" = 0:0:500:1
 test "$(sha256sum "$root/relay" | cut -d' ' -f1)" = "$digest"
 binary_id=$(identity "$root/relay")
 stage=6
 private_file "$root/process"
 set -- $(cat "$root/process")
 test "$#" = 2; pid=$1; born=$2; number "$pid"; number "$born"; test "$pid" -gt 1
 printf '%s %s\n' "$pid" "$born" | cmp -s - "$root/process"
 stage=7
 if test -e "/proc/$pid"; then
  test -r "/proc/$pid/stat"
  test "$(sed 's/.*) //' "/proc/$pid/stat" | awk '{print $20}')" = "$born"
  if test "$(sed 's/.*) //' "/proc/$pid/stat" | cut -d' ' -f1)" != Z; then printf 'relay-normalization-running\n'; exit; fi
 fi
 stage=8
 private_file "$root/socket"
 socket_id=$(cat "$root/socket")
 # The exact helper unlinks its own listener during a graceful exit.
 if ! absent "$socket"; then
  test ! -L "$socket"; test -S "$socket"
  test "$(stat -c %u:%g:%a:%h "$socket")" = 0:0:700:1
  test "$(identity "$socket")" = "$socket_id"
 fi
 printf 'relay-normalization-exited-v1 %s %s %s %s %s %s %s\n' "$pid" "$born" "$root_id" "$binary_id" "$socket_id" "$control_id" "$lock_id"
 exit
fi
stage=9
case "$action" in verify|finish-empty) :;; *) exit 1;; esac
set -- $expected
test "$#" = 8; test "$1" = relay-normalization-exited-v1
pid=$2; born=$3; root_id=$4; binary_id=$5; socket_id=$6
number "$pid"; number "$born"; test "$pid" -gt 1
test "$7" = "$control_id"; test "$8" = "$lock_id"
stage=10
if test -e "/proc/$pid"; then
 test -r "/proc/$pid/stat"
 test "$(sed 's/.*) //' "/proc/$pid/stat" | awk '{print $20}')" = "$born"
 test "$(sed 's/.*) //' "/proc/$pid/stat" | cut -d' ' -f1)" = Z
fi
stage=11
if absent "$root"; then
 test "$phase" = stopped; absent "$socket"
else
 private_dir "$base"; private_dir "$root"; test "$(identity "$root")" = "$root_id"
 if absent "$root/owner"; then
  test "$phase" = stopped; absent "$socket"
  test -z "$(find "$root" -mindepth 1 -maxdepth 1 -print -quit)"
  if test "$action" = finish-empty; then rmdir "$root"; fi
  printf 'relay-normalization-verified\n'; exit
 fi
 private_file "$root/owner"; test "$(cat "$root/owner")" = "$marker"
 if ! absent "$root/relay"; then
  test ! -L "$root/relay"; test -f "$root/relay"
  test "$(stat -c %u:%g:%a:%h "$root/relay")" = 0:0:500:1
  test "$(identity "$root/relay")" = "$binary_id"
  test "$(sha256sum "$root/relay" | cut -d' ' -f1)" = "$digest"
 else test "$phase" = stopped; fi
 if ! absent "$root/process"; then
  private_file "$root/process"
  printf '%s %s\n' "$pid" "$born" | cmp -s - "$root/process"
 else test "$phase" = stopped; fi
 if ! absent "$root/socket"; then
  private_file "$root/socket"; test "$(cat "$root/socket")" = "$socket_id"
 else test "$phase" = stopped; fi
 if ! absent "$socket"; then
  test ! -L "$socket"; test -S "$socket"
  test "$(stat -c %u:%g:%a:%h "$socket")" = 0:0:700:1
  test "$(identity "$socket")" = "$socket_id"
 else case "$phase" in launching|closing|stopped) :;; *) exit 1;; esac; fi
fi
printf 'relay-normalization-verified\n'
