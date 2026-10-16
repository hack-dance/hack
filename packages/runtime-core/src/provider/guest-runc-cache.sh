# Cache the pinned executable in guest memory to avoid host-share traffic on every exec.
# A failed or interrupted setup is retained for VM teardown; never reuse or repair it in place.
set -eu
test "$(cat /storage/.hack-local-owner)" = "$1"
test "$(cat /proc/sys/kernel/random/boot_id)" = "$2"
test "$(findmnt -n -o FSTYPE --mountpoint /opt/hack-engine)" = virtiofs
test "$(findmnt -n -o FSTYPE --mountpoint /run/hack-local)" = tmpfs
test "$(stat -c %u:%g:%a /run/hack-local)" = 0:0:700
test -f /opt/hack-engine/runc
test ! -L /opt/hack-engine/runc
test "$(sha256sum /opt/hack-engine/runc | cut -d ' ' -f 1)" = "$3"
test "$(stat -c %s /opt/hack-engine/runc)" -le 33554432
if mountpoint -q /opt/hack-engine/runc; then exit 44; fi
cache=/run/hack-local/engine-exec
test ! -e "$cache"
test ! -L "$cache"
mkdir -m 700 "$cache"
mount -t tmpfs -o size=32m,mode=700,nosuid,nodev tmpfs "$cache"
cp /opt/hack-engine/runc "$cache/runc"
chmod 555 "$cache/runc"
test "$(sha256sum "$cache/runc" | cut -d ' ' -f 1)" = "$3"
mount -o remount,ro "$cache"
mount --bind "$cache/runc" /opt/hack-engine/runc
mount -o remount,bind,ro /opt/hack-engine/runc
test "$(findmnt -n -o FSTYPE --mountpoint /opt/hack-engine/runc)" = tmpfs
for target in "$cache" /opt/hack-engine/runc; do
 case ",$(findmnt -n -o OPTIONS --mountpoint "$target")," in *,ro,*) ;; *) exit 45;; esac
done
test "$(sha256sum /opt/hack-engine/runc | cut -d ' ' -f 1)" = "$3"
printf 'engine-exec-cache-v1\n'
