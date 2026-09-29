set -eu
set -o pipefail
export LC_ALL=C
umask 077
root=/etc/hack-local-network-tools
packages='iptables libmnl libnftnl libxtables'
test "$(cat /etc/alpine-release)" = 3.19.0
test "$(apk --print-arch)" = aarch64
if test -e "$root" || test -L "$root"; then
 test ! -L "$root"; test -d "$root"; test "$(stat -c %u:%a "$root")" = 0:700
 for file in owner identity inventory files ready; do
  test ! -L "$root/$file"; test -f "$root/$file"
  test "$(stat -c %u:%a:%h "$root/$file")" = 0:600:1
 done
 test "$(cat "$root/owner")" = "$1"
 test "$(cat "$root/identity")" = "$2"
 test "$(apk info -v | sort | sha256sum | cut -d ' ' -f 1)" = "$(cat "$root/inventory")"
 sha256sum -c "$root/files" >/dev/null
 iptables -t nat -S >/dev/null
 printf 'ready\n'
 exit 0
fi
for package in $packages; do
 if apk info -e "$package" >/dev/null 2>&1; then
  printf 'Unowned networking package: %s\n' "$package" >&2
  exit 81
 fi
done
if test "$3" = check; then printf 'absent\n'; exit 0; fi
test "$3" = install
# A retained directory without a complete receipt blocks retry after interruption.
mkdir "$root"
printf '%s' "$1" > "$root/owner"
printf '%s' "$2" > "$root/identity"
apk add --no-network --no-cache --no-scripts --repositories-file /dev/null "$4"/*.apk >/dev/null
for package in $packages; do
 apk info -L "$package" | sed '1d' | while IFS= read -r path; do
  if test -n "$path" && test -f "/$path"; then sha256sum "/$path"; fi
 done
done > "$root/files"
test -s "$root/files"
apk info -v | sort | sha256sum | cut -d ' ' -f 1 > "$root/inventory"
iptables -t nat -S >/dev/null
sync
printf 'ready\n' > "$root/ready"
sync
