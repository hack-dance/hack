set -eu
# Confirms the guest's x86_64 translation matches the pool's audited intent before the engine
# starts. The pinned SmolVM agent mounts the host Rosetta runtime (virtiofs tag `rosetta`)
# at /mnt/rosetta and registers it with binfmt_misc as `rosetta`, matching x86_64 ELF.
# Since SmolVM 1.35.0 the pinned libkrun answers Rosetta's start-up key request for that
# share, so the agent registers the translator itself (1.14.3 to 1.34.1 registered
# /usr/bin/rosetta-wrapper with `F` only). `F` (fix-binary) makes container mount
# namespaces use the interpreter opened at registration; `C` takes credentials from the
# x86_64 binary and implies `O`, so the kernel reports the flags as `OCF`.
test "$(cat /storage/.hack-local-owner)" = "$1"
test "$(cat /proc/sys/kernel/random/boot_id)" = "$2"
entry=/proc/sys/fs/binfmt_misc/rosetta
case "$3" in
enabled)
  test -f "$entry"
  test "$(sed -n 1p "$entry")" = enabled
  grep -qx 'interpreter /mnt/rosetta/rosetta' "$entry"
  grep -qx 'flags: OCF' "$entry"
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
