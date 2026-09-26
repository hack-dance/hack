# Read-only observation. Never invoke relay.sh or create/promote a fence here.
set -efu
stage=1
trap 'status=$?; if test "$status" -ne 0; then printf "relay-observation-refused %s\n" "$stage"; exit 0; fi' 0
exec 2>/dev/null
action=$1; allocation=$2; marker=$3; socket=$4; digest=$5; serial=$6; slot=$7
observed_pid=${8:-0}; observed_born=${9:-0}; observed_kernel=${10:-0}
base=/run/hack-local/graph-relays
root="$base/$allocation"
controls=/run/hack-local/relay-slots
control="$controls/slot-$slot"
private_dir() { test ! -L "$1" && test -d "$1" && test "$(stat -c %u:%g:%a "$1")" = 0:0:700; }
private_file() {
 test ! -L "$1"; test -f "$1"
 test "$(stat -c %u:%g:%a:%h "$1")" = 0:0:600:1
 test "$(stat -c %s "$1")" -le 256
}
number() { case "$1" in ''|*[!0-9]*) return 1;; esac; test "$1" -gt 0; }
stage=2
private_dir /run/hack-local
test "$(findmnt -n -o FSTYPE --target /run/hack-local)" = tmpfs
stage=3
private_dir "$controls"; private_dir "$control"
private_file "$control/lock"
control_identity=$(stat -c %d:%i "$control")
lock_identity=$(stat -c %d:%i "$control/lock")
# Open only an existing descriptor. All relay writers take this lock exclusively.
stage=4
exec 9< "$control/lock"
flock -s -w 5 9
test "$(stat -c %d:%i "$control")" = "$control_identity"
test "$(stat -Lc %d:%i /proc/$$/fd/9)" = "$lock_identity"
test "$(stat -c %d:%i "$control/lock")" = "$lock_identity"
stage=5
test ! -e "$control/pending"; test ! -L "$control/pending"
private_file "$control/state"
fields=$(cat "$control/state")
set -- $fields
test "$#" = 3; test "$1" = "$serial"; test "$2" = "$allocation"
phase=$3
printf '%s %s %s\n' "$serial" "$allocation" "$phase" | cmp -s - "$control/state"
if test "$action" = capture; then
 stage=6
 test "$phase" = launching
 stage=7
 private_dir "$base"; private_dir "$root"
 private_file "$root/owner"; test "$(cat "$root/owner")" = "$marker"
 stage=8
 test ! -L "$root/relay"; test -f "$root/relay"
 test "$(stat -c %u:%g:%a:%h "$root/relay")" = 0:0:500:1
 test "$(sha256sum "$root/relay" | cut -d' ' -f1)" = "$digest"
 stage=9
 private_file "$root/process"
 set -- $(cat "$root/process")
 test "$#" = 2; pid=$1; born=$2; number "$pid"; number "$born"; test "$pid" -gt 1
 printf '%s %s\n' "$pid" "$born" | cmp -s - "$root/process"
 stage=10
 test -r "/proc/$pid/stat"
 test "$(sed 's/.*) //' "/proc/$pid/stat" | awk '{print $20}')" = "$born"
 test "$(sed 's/.*) //' "/proc/$pid/stat" | cut -d' ' -f1)" != Z
 stage=11
 executable=$(stat -c %d:%i "$root/relay")
 test "$(stat -Lc %d:%i "/proc/$pid/exe")" = "$executable"
 stage=12
 private_file "$root/socket"
 test ! -L "$socket"; test -S "$socket"
 test "$(stat -c %u:%g:%a:%h "$socket")" = 0:0:700:1
 socket_identity=$(stat -c %d:%i "$socket")
 test "$socket_identity" = "$(cat "$root/socket")"
 # The kernel socket inode is distinct from the filesystem socket inode.
 # The helper enters the target network namespace before creating its listener.
 stage=13
 kernel=$(awk -v path="$socket" '$8 == path { print $7 }' "/proc/$pid/net/unix")
 number "$kernel"
 stage=14
 found=0
 set +f
 for fd in /proc/"$pid"/fd/*; do
  if test "$(readlink "$fd")" = "socket:[$kernel]"; then found=1; fi
 done
 set -f
 test "$found" = 1
 printf 'relay-captured-v1 %s %s %s %s %s\n' "$pid" "$born" "$executable" "$socket_identity" "$kernel"
 exit
fi
stage=15
test "$action" = retired
number "$observed_pid"; number "$observed_born"; number "$observed_kernel"
test "$observed_pid" -gt 1
stage=16
if test -e "/proc/$observed_pid"; then
 test -r "/proc/$observed_pid/stat"
 current_born=$(sed 's/.*) //' "/proc/$observed_pid/stat" | awk '{print $20}')
 number "$current_born"
 if test "$current_born" = "$observed_born"; then
  test "$(sed 's/.*) //' "/proc/$observed_pid/stat" | cut -d' ' -f1)" = Z
 fi
fi
stage=15
test "$phase" = stopped
stage=17
test ! -L "$base"
test ! -e "$root"; test ! -L "$root"
stage=18
test ! -e "$socket"; test ! -L "$socket"
# The listener belonged to the captured helper in its target network namespace.
# This proves that helper generation exited and its owned allocation/path vanished;
# it does not claim a global scan proved closure of every transferred/inherited FD.
# The qualified helper does not fork or transfer descriptors via SCM_RIGHTS.
printf 'relay-retired-v1\n'
