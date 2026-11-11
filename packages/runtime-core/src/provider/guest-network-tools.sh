set -eu
set -o pipefail
export LC_ALL=C
umask 077
root=/etc/hack-local-network-tools
packages='iptables libmnl libnftnl libxtables'
# Every apk call reads only the installed database: with no repositories it never tries to
# refresh an index. apk-tools 3 otherwise waits about 10 s per call for DNS in a pool
# without internet, and five calls pass the agent's exec limit.
apk() { command apk --repositories-file /dev/null "$@"; }
test "$(cat /etc/alpine-release)" = 3.24.4
test "$(apk --print-arch)" = aarch64
resume=
if test -e "$root" || test -L "$root"; then
 test ! -L "$root"; test -d "$root"; test "$(stat -c %u:%a "$root")" = 0:700
 if test -e "$root/ready" || test -L "$root/ready"; then
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
 # No receipt yet: an install of this pool and package set was interrupted after it created
 # the directory (the package check below runs before that). Its owner and identity are
 # absent, empty or exactly this pool's; anything else is refused. The install resumes:
 # `apk add` of the pinned files is idempotent and the receipt is written again.
 for file in owner identity inventory files; do
  if test -e "$root/$file" || test -L "$root/$file"; then
   test ! -L "$root/$file"; test -f "$root/$file"
   test "$(stat -c %u:%a:%h "$root/$file")" = 0:600:1
  fi
 done
 for pair in "owner:$1" "identity:$2"; do
  file=${pair%%:*}
  if test -s "$root/$file"; then
   test "$(cat "$root/$file")" = "${pair#*:}"
  fi
 done
 resume=1
else
 for package in $packages; do
  if apk info -e "$package" >/dev/null 2>&1; then
   printf 'Unowned networking package: %s\n' "$package" >&2
   exit 81
  fi
 done
fi
if test "$3" = check; then printf 'absent\n'; exit 0; fi
test "$3" = install
if test -z "$resume"; then mkdir "$root"; fi
printf '%s' "$1" > "$root/owner"
printf '%s' "$2" > "$root/identity"
apk add --no-network --no-cache --no-scripts --no-logfile "$4"/*.apk >/dev/null
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
