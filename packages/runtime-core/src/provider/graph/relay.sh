set -efu
umask 077
action=$1; allocation=$2; marker=$3; socket=$4; digest=$5; target=$6; ticks=$7; port=$8
test "$(findmnt -n -o FSTYPE --target /run/hack-local)" = tmpfs
base=/run/hack-local/graph-relays
root="$base/$allocation"
private_dir() { test ! -L "$1" && test -d "$1" && test "$(stat -c %u:%g:%a "$1")" = 0:0:700; }
private_file() {
 test ! -L "$1" && test -f "$1" && test "$(stat -c %u:%g:%a:%h "$1")" = 0:0:600:1
 test "$(stat -c %s "$1")" -le 256
}
start_ticks() { sed 's/.*) //' "/proc/$1/stat" | awk '{print $20}'; }
check_binary() {
 test ! -L "$root/relay" && test -f "$root/relay"
 test "$(stat -c %u:%g:%a:%h "$root/relay")" = 0:0:500:1
 test "$(sha256sum "$root/relay" | cut -d' ' -f1)" = "$digest"
}
check_socket() {
 private_file "$root/socket"
 test ! -L "$socket" && test -S "$socket"
 test "$(stat -c %u:%g:%a:%h "$socket")" = 0:0:700:1
 test "$(stat -c %d:%i "$socket")" = "$(cat "$root/socket")"
}
read_process() {
 private_file "$root/process"
 set -- $(cat "$root/process")
 test "$#" = 2
 case "$1:$2" in *[!0-9:]*|:*|*:) return 1;; esac
 pid=$1; born=$2; test "$pid" -gt 1; test "$born" -gt 0
}
alive() {
 test -e "/proc/$pid/stat" || return 1
 test "$(start_ticks "$pid")" = "$born" || return 1
 test "$(sed 's/.*) //' "/proc/$pid/stat" | cut -d' ' -f1)" != Z
}
# RELAY_FENCE
if test "$action" = start; then
 test ! -L "$base"
 if test ! -e "$base"; then mkdir -m 700 "$base"; fi
 private_dir "$base"
 test ! -L "$socket" && test ! -e "$socket"
 mkdir -m 700 "$root"
 printf '%s\n' "$marker" > "$root/owner"
 base64 -d | gzip -d > "$root/relay.pending"
 test "$(sha256sum "$root/relay.pending" | cut -d' ' -f1)" = "$digest"
 chmod 500 "$root/relay.pending"
 mv "$root/relay.pending" "$root/relay"
 check_binary
 # This shell records its own PID before exec: no detached child can start after recorded exit.
 /bin/sh -c '
 set -eu; umask 077; set -C
 printf "%s %s\n" "$$" "$(sed "s/.*) //" /proc/$$/stat | awk "{print \$20}")" > "$1/process"
 exec "$1/relay" "$2" 127.0.0.1 "$3" 10000 --netns "$4" "$5"
 ' relay-child "$root" "$socket" "$port" "$target" "$ticks" </dev/null >/dev/null 2>&1 &
 for i in $(seq 1 100); do
  if test -S "$socket" && test -f "$root/process"; then break; fi
  sleep .05
 done
 read_process
 alive
 test "$(stat -Lc %d:%i /proc/$pid/exe)" = "$(stat -c %d:%i "$root/relay")"
 test -S "$socket" && test ! -L "$socket"
 stat -c %d:%i "$socket" > "$root/socket"
 check_socket
 printf 'running\n'
 exit
fi
if test "$action" = remove && test ! -e "$root" && test ! -L "$root"; then
 printf 'removed\n'; exit
fi
private_dir "$base"; private_dir "$root"
private_file "$root/owner"; test "$(cat "$root/owner")" = "$marker"
if test "$action" = remove; then
 # Called only after the host has durably committed confirmed process exit.
 for file in process socket; do
  if test -e "$root/$file" || test -L "$root/$file"; then private_file "$root/$file"; rm "$root/$file"; fi
 done
 if test -e "$root/relay" || test -L "$root/relay"; then check_binary; rm "$root/relay"; fi
 rm "$root/owner"
 rmdir "$root"
 printf 'removed\n'; exit
fi
check_binary
read_process
if alive; then
 test "$(stat -Lc %d:%i /proc/$pid/exe)" = "$(stat -c %d:%i "$root/relay")"
 if test "$action" = inspect; then check_socket; printf 'running\n'; exit; fi
 test "$action" = stop
 "$root/relay" --stop "$pid" "$born"
 ! alive
elif test "$action" = inspect; then
 printf 'exited\n'; exit
fi
test "$action" = stop
if test -e "$socket" || test -L "$socket"; then check_socket; rm "$socket"; fi
if test "$serial" -ne 0; then fence_write stopped; fi
printf 'stopped\n'
