set -efu
allocation=$1; slot=$2; serial=$3
case "$allocation" in *[!0-9a-f]*|'') exit 1;; esac
test "${#allocation}" = 32
case "$slot" in *[!0-9]*|'') exit 1;; esac
test "$slot" -ge 0
test "$slot" -le 31
case "$serial" in *[!0-9]*|'') exit 1;; esac
test "$serial" -gt 0
test "$(findmnt -n -o FSTYPE --target /run/hack-local)" = tmpfs
base=/run/hack-local
private_dir() {
 test ! -L "$1"
 test -d "$1"
 test "$(stat -c %u:%g:%a "$1")" = 0:0:700
}
private_file() {
 test ! -L "$1"
 test -f "$1"
 test "$(stat -c %u:%g:%a:%h "$1")" = 0:0:600:1
 test "$(stat -c %s "$1")" -le 256
}
private_dir "$base"
private_dir "$base/graph-relays"
root="$base/graph-relays/$allocation"
socket=$(printf '%s/bridge-%02d.sock' "$base" "$slot")
test ! -L "$root"
if test -e "$root"; then
 test -d "$root"
 printf 'present\n'
 exit
fi
test ! -e "$socket"
test ! -L "$socket"
private_dir "$base/relay-slots"
control="$base/relay-slots/slot-$slot"
private_dir "$control"
private_file "$control/lock"
exec 9<> "$control/lock"
flock -w 7 9
test ! -e "$control/pending"
test ! -L "$control/pending"
private_file "$control/state"
set -- $(cat "$control/state")
test "$#" = 3
test "$1" = "$serial"
test "$2" = "$allocation"
test "$3" = stopped
printf '%s %s %s\n' "$1" "$2" "$3" | cmp -s - "$control/state"
printf 'absent\n'
