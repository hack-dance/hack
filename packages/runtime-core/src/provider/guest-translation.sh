set -eu
# Confirms the guest's x86_64 translation matches the pool's audited intent before the engine
# starts. SmolVM 1.14.3's agent mounts the host Rosetta runtime (virtiofs tag `rosetta`) at
# /mnt/rosetta and registers it with binfmt_misc as `rosetta`, matching x86_64 ELF with the
# fix-binary flag so container mount namespaces use the interpreter opened at registration.
test "$(cat /storage/.hack-local-owner)" = "$1"
test "$(cat /proc/sys/kernel/random/boot_id)" = "$2"
entry=/proc/sys/fs/binfmt_misc/rosetta
case "$3" in
enabled)
  test -f "$entry"
  test "$(sed -n 1p "$entry")" = enabled
  grep -qx 'interpreter /usr/bin/rosetta-wrapper' "$entry"
  grep -qx 'flags: F' "$entry"
  grep -qx 'magic 7f454c4602010100000000000000000002003e00' "$entry"
  test "$(findmnt -n -o FSTYPE --mountpoint /mnt/rosetta)" = virtiofs
  printf 'amd64-translation-enabled-v1\n'
  ;;
disabled)
  test ! -e "$entry"
  printf 'amd64-translation-disabled-v1\n'
  ;;
*)
  exit 2
  ;;
esac
