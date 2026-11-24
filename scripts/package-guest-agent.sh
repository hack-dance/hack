#!/bin/sh
# Stage an already verified provider rootfs and a static agent in a fresh image.
set -eu
if [ "$#" -ne 4 ]; then
  echo 'usage: package-guest-agent.sh ROOTFS AGENT aarch64|x86_64 OUTPUT_PARENT' >&2
  exit 2
fi
[ -f "$2" ] || { echo 'agent must be a regular file' >&2; exit 2; }
case "$3" in aarch64|x86_64) ;; *) echo 'unsupported guest architecture' >&2; exit 2;; esac
base=$(CDPATH='' cd -- "$1" && pwd -P)
out=$(CDPATH='' cd -- "$4" && pwd -P)
[ "$base" != / ] || { echo 'input must be an extracted guest rootfs' >&2; exit 2; }
case "$out/" in "$base/"*) echo 'output must be outside the input rootfs' >&2; exit 2;; esac
here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
member=usr/local/bin/hack-vm-agent
check_layout() {
  tree=$1
  for dir in usr usr/local usr/local/bin; do
    if [ ! -d "$tree/$dir" ] || [ -L "$tree/$dir" ]; then
      echo 'unexpected guest bin directory' >&2
      exit 1
    fi
  done
  if [ ! -f "$tree/usr/local/bin/smolvm-agent" ] || [ -L "$tree/usr/local/bin/smolvm-agent" ]; then
    echo 'provider agent missing or symlinked' >&2
    exit 1
  fi
  if [ -e "$tree/$member" ] || [ -L "$tree/$member" ]; then
    echo 'guest image already has an agent entry' >&2
    exit 1
  fi
}
check_layout "$base"
umask 077
stage=$(mktemp -d "$out/guest-image.XXXXXX")
trap 'rm -rf "$stage"' EXIT
trap 'exit 1' HUP INT TERM
mkdir "$stage/rootfs"
cp -a "$base/." "$stage/rootfs/"
check_layout "$stage/rootfs"
install -m 755 "$2" "$stage/rootfs/$member"
python3 "$here/verify-native-relay.py" "$stage/rootfs/$member" --guest-agent "$3" "$stage/rootfs/usr/local/bin/smolvm-agent" >&2
cmp "$2" "$stage/rootfs/$member"
printf '%s\n' "$stage/rootfs"
trap - EXIT
