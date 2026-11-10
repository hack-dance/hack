# Called only after owned allocation/tmpfs and inactive exec proofs. Keep the
# mounted directory, and clear only reconstructible samples under its probe lock.
case "$previous" in ''|*[!0-9a-f]*) exit 1;; esac
test "${#previous}" = 32
test "$(stat -c %u:%g:%a "$state")" = "$uid:$gid:700"
test ! -L "$state"
cd -P "$state"
test "$(stat -c %d:%i .)" = "$(stat -c %d:%i "$state")"
private_sample() {
 test ! -L "$1"
 test -f "$1"
 test "$(stat -c %u:%g:%a:%h "$1")" = "$uid:$gid:600:1"
 test "$(stat -c %s "$1")" -le 256
}
private_sample lock
test "$(stat -c %s lock)" = 0
exec 9<> lock
flock -n 9
# Compare the held descriptor with the still-canonical leaf before touching data.
private_sample lock
test "$(stat -Lc %d:%i /proc/self/fd/9)" = "$(stat -c %d:%i lock)"
for leaf in status first-sample status.pending; do
 if test -e "$leaf" || test -L "$leaf"; then private_sample "$leaf"; fi
done
observed=0
for leaf in status first-sample; do
 if test -e "$leaf"; then
  read -r version generation rest < "$leaf"
  test "$version" = v1
  test "$generation" = "$previous"
  observed=1
 fi
done
# Absence is not proof of this generation. In particular, an old delayed
# preparation must not treat a successor's newly cleared directory as its own.
test "$observed" = 1
# A killed writer can leave an empty or partial pending file. Its contents never
# grant readiness or deletion authority; only the owned, locked leaf does.
rm -f -- status first-sample status.pending
