set -eu
export LC_ALL=C
# Read-only inventory of a verifier boot's disks, before any pool setup. It only lists and reads;
# the host decides what is acceptable. Lists are NUL-separated relative paths, base64-encoded.
encode() { base64 | tr -d '\n'; }
# tree DIR [FIND-PREDICATES...]: every entry below DIR matching the predicates.
tree() {
  dir=$1
  shift
  if test -d "$dir"; then (cd "$dir" && find . -mindepth 1 "$@" -print0) | encode; fi
}
names() { tree "$1" -maxdepth 1; }
present() { if test -e "$1" || test -L "$1"; then printf 1; else printf 0; fi; }
printf 'owner_marker %s\n' "$(present /storage/.hack-local-owner)"
printf 'engine_id %s\n' "$(present /storage/docker/engine-id)"
printf 'storage_top %s\n' "$(names /storage)"
printf 'docker_top %s\n' "$(names /storage/docker)"
printf 'docker_containers %s\n' "$(names /storage/docker/containers)"
printf 'docker_volumes %s\n' "$(names /storage/docker/volumes)"
printf 'docker_network %s\n' "$(tree /storage/docker/network ! -type d)"
printf 'images %s\n' "$(names /storage/docker/image/overlay2/imagedb/content/sha256)"
for dir in containerd lost+found layers configs manifests overlays workspace containers; do
  printf 'storage_dir %s %s\n' "$dir" "$(tree "/storage/$dir" ! -type d)"
done
device="$(blkid -c /dev/null | sed -n 's/^\([^:]*\):.* LABEL="smolvm-overlay".*/\1/p' | head -n 1)"
test -n "$device"
# `/mnt` exists in the base rootfs, and `-n` keeps mount bookkeeping off the inspected disks.
mountpoint=/mnt
test -d "$mountpoint"
mount -n -o ro "$device" "$mountpoint" 2>/dev/null || mount -n "$device" "$mountpoint"
upper="$mountpoint/upper"
test -d "$upper"
printf 'upper_files %s\n' "$(tree "$upper" -type f)"
printf 'upper_links %s\n' "$(tree "$upper" -type l)"
printf 'upper_dirs %s\n' "$(tree "$upper" -type d)"
printf 'upper_other %s\n' "$(tree "$upper" ! -type f ! -type l ! -type d)"
umount -n "$mountpoint"
receipt=/etc/hack-local-network-tools
read_file() { if test -f "$1" && test ! -L "$1"; then encode < "$1"; fi; }
printf 'tools_owner %s\n' "$(read_file "$receipt/owner")"
printf 'tools_identity %s\n' "$(read_file "$receipt/identity")"
printf 'tools_files %s\n' "$(read_file "$receipt/files")"
if test -f "$receipt/files" && sha256sum -c "$receipt/files" >/dev/null 2>&1; then
  printf 'tools_check ok\n'
else
  printf 'tools_check failed\n'
fi
printf 'end prepared-inventory-v1\n'
