# Cache pinned executables in guest memory, independent of host-share ownership.
# Interrupted setup is retained for VM teardown; never reuse or repair it in place.
set -eu
test "$#" = 4
for digest in "$3" "$4"; do
 test "${#digest}" = 64
 case "$digest" in *[!0-9a-f]*) exit 64;; esac
done
test "$(cat /storage/.hack-local-owner)" = "$1"
test "$(cat /proc/sys/kernel/random/boot_id)" = "$2"
test "$(findmnt -n -o FSTYPE --mountpoint /opt/hack-engine)" = virtiofs
test "$(findmnt -n -o FSTYPE --mountpoint /run/hack-local)" = tmpfs
test "$(stat -c %u:%g:%a /run/hack-local)" = 0:0:700
total=0
for name in runc docker-init; do
 path=/opt/hack-engine/$name
 test -f "$path"
 test ! -L "$path"
 case "$name" in runc) expected=$3;; docker-init) expected=$4;; esac
 test "$(sha256sum "$path" | cut -d ' ' -f 1)" = "$expected"
 size=$(stat -c %s "$path")
 test "$size" -gt 0
 test "$size" -le 33554432
 total=$((total + size))
 if mountpoint -q "$path"; then exit 44; fi
done
test "$total" -le 33554432
cache=/run/hack-local/engine-exec
test ! -e "$cache"
test ! -L "$cache"
mkdir -m 700 "$cache"
mount -t tmpfs -o size=32m,mode=700,nosuid,nodev tmpfs "$cache"
for name in runc docker-init; do
 cp "/opt/hack-engine/$name" "$cache/$name"
 chmod 555 "$cache/$name"
 test "$(stat -c %u:%g:%a "$cache/$name")" = 0:0:555
 case "$name" in runc) expected=$3;; docker-init) expected=$4;; esac
 test "$(sha256sum "$cache/$name" | cut -d ' ' -f 1)" = "$expected"
done
mount -o remount,ro "$cache"
for name in runc docker-init; do
 path=/opt/hack-engine/$name
 mount --bind "$cache/$name" "$path"
 mount -o remount,bind,ro "$path"
 test "$(findmnt -n -o FSTYPE --mountpoint "$path")" = tmpfs
 test "$(stat -c %u:%g:%a "$path")" = 0:0:555
 case "$name" in runc) expected=$3;; docker-init) expected=$4;; esac
 test "$(sha256sum "$path" | cut -d ' ' -f 1)" = "$expected"
done
for target in "$cache" /opt/hack-engine/runc /opt/hack-engine/docker-init; do
 case ",$(findmnt -n -o OPTIONS --mountpoint "$target")," in *,ro,*) ;; *) exit 45;; esac
done
printf 'engine-exec-cache-v1\n'
