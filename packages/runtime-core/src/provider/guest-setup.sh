set -eu
stage=identity
trap 'code=$?; if test "$code" != 0; then printf "Guest setup failed at %s (exit %s)\n" "$stage" "$code" >&2; fi' EXIT
owner=$1
expected_uuid=$2
previous_boot=$3
test "$(sha256sum /opt/hack-engine/dockerd | cut -d ' ' -f 1)" = "$4"
test "$(sha256sum /usr/local/bin/smolvm-agent | cut -d ' ' -f 1)" = "$5"
stage=storage
storage_source=$(findmnt -n -o SOURCE --mountpoint /storage)
test "$(findmnt -n -o FSTYPE --mountpoint /storage)" = ext4
test "$(blkid -s UUID -o value "$storage_source")" = "$expected_uuid"
stage=engine-mount
test "$(findmnt -n -o FSTYPE --mountpoint /opt/hack-engine)" = virtiofs
case ",$(findmnt -n -o OPTIONS --mountpoint /opt/hack-engine)," in *,ro,*) ;; *) exit 40;; esac
boot=$(cat /proc/sys/kernel/random/boot_id)
test "$boot" != "$previous_boot"
stage=owner-marker
if test -f /storage/.hack-local-owner; then
  test "$(cat /storage/.hack-local-owner)" = "$owner"
else
  test "$previous_boot" = new
  (umask 077; set -C; printf '%s\n' "$owner" > /storage/.hack-local-owner)
fi
stage=runtime-mounts
mkdir -p /storage/docker /storage/containerd /var/lib/docker /var/lib/containerd /run/hack-local
# Refuse an existing runtime mount: do not hide a live daemon under another tmpfs.
if findmnt -n --mountpoint /run/hack-local >/dev/null; then exit 41; fi
mount --bind /storage/docker /var/lib/docker
mount --bind /storage/containerd /var/lib/containerd
mount -t tmpfs -o size=16m,nr_inodes=4096,mode=700 tmpfs /run/hack-local
test "$(findmnt -n -o FSTYPE --mountpoint /var/lib/docker)" = ext4
test "$(findmnt -n -o FSTYPE --mountpoint /var/lib/containerd)" = ext4
if test -L /var/run/docker.sock; then
  test "$(readlink /var/run/docker.sock)" = /run/hack-local/docker.sock
else
  test ! -e /var/run/docker.sock
  ln -s /run/hack-local/docker.sock /var/run/docker.sock
fi
sync
printf '%s\n' "$boot"
