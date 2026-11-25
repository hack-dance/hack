#!/usr/bin/env bash
# Offline tests for provision-ghostty.sh's download fallback: a fake curl on
# PATH plays dead, wrong, stalled and good sources, and each case checks that
# only bytes matching the pinned sha256 are kept. No network. Runs on bash
# 3.2 (macOS) and later.
#
#   bash term/scripts/test-provision-ghostty.sh
set -euo pipefail

here=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd -P)
work=$(mktemp -d "${TMPDIR:-/tmp}/provision-ghostty-test.XXXXXX")
trap 'rm -rf -- "$work"' EXIT

# shellcheck source-path=SCRIPTDIR source=provision-ghostty.sh
source "$here/provision-ghostty.sh"

mkdir -p "$work/bin"
printf 'the pinned bytes\n' > "$work/fixture"
want=$(sha256_of "$work/fixture")
export FAKE_FIXTURE="$work/fixture" FAKE_LOG="$work/curl.log"

# The fake curl: reads -o FILE, --continue-at and the URL (the last
# argument), logs "URL resume|fresh", and acts on the host:
#   dead.test    fails as a stalled transfer would (exit 28), writing nothing
#   bad.test     serves other bytes
#   good.test    serves the fixture
#   stall.test   serves half the fixture then stalls; a resumed request
#                gets the rest
#   norange.test serves half then stalls, and refuses to resume (exit 33)
cat > "$work/bin/curl" <<'SHIM'
#!/usr/bin/env bash
out="" resume=fresh url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out=$2; shift 2 ;;
    --continue-at) resume=resume; shift 2 ;;
    --speed-limit|--speed-time|--max-time|--connect-timeout|--proto|--proto-redir) shift 2 ;;
    *) url=$1; shift ;;
  esac
done
echo "$url $resume" >> "$FAKE_LOG"
size=$(wc -c < "$FAKE_FIXTURE" | tr -d ' ')
half=$((size / 2))
case "$url" in
  https://dead.test/*) exit 28 ;;
  https://bad.test/*) printf 'other bytes\n' > "$out" ;;
  https://good.test/*) cat "$FAKE_FIXTURE" > "$out" ;;
  https://stall.test/*)
    if [ "$resume" = resume ]; then tail -c +$((half + 1)) "$FAKE_FIXTURE" >> "$out"
    else head -c "$half" "$FAKE_FIXTURE" > "$out"; exit 28; fi ;;
  https://norange.test/*)
    if [ "$resume" = resume ]; then exit 33; fi
    head -c "$half" "$FAKE_FIXTURE" > "$out"; exit 28 ;;
  *) echo "fake curl: unexpected URL $url" >&2; exit 6 ;;
esac
SHIM
chmod +x "$work/bin/curl"
PATH="$work/bin:$PATH"

retry_delay=0
offline=false
failures=0
case_dir=""

# start NAME: a fresh download dir and curl log for one case.
start() {
  case_dir="$work/case-$1"
  mkdir -p "$case_dir"
  dir=$case_dir
  : > "$FAKE_LOG"
  SECONDS=0
}
fail() { echo "FAIL: $*" >&2; failures=$((failures + 1)); }
pass() { echo "ok: $*"; }
calls() { wc -l < "$FAKE_LOG" | tr -d ' '; }
# kept: the file is there and verified, and no partial file is left.
kept() { [[ -f "$dir/f" && "$(sha256_of "$dir/f")" == "$want" && ! -e "$dir/f.partial" ]]; }
# nothing_kept: neither the file nor a partial file is left.
nothing_kept() { [[ ! -e "$dir/f" && ! -e "$dir/f.partial" ]]; }

start dead-primary
if (fetch f "$want" https://dead.test/f https://good.test/f) 2>/dev/null && kept \
  && [[ "$(calls)" -eq $((attempts + 1)) ]]; then
  pass "a dead primary is retried $attempts times, then a mirror serves the verified file"
else fail "dead primary then good mirror"; fi

start bad-mirror
if (fetch f "$want" https://bad.test/f https://good.test/f) 2>"$work/err" && kept \
  && grep -q 'sha256 mismatch for f from https://bad.test/f' "$work/err" \
  && [[ "$(calls)" -eq 2 ]]; then
  pass "a mirror serving other bytes is rejected once and the next source is used"
else fail "bad mirror then good mirror"; fi

start only-bad
if (fetch f "$want" https://dead.test/f https://bad.test/f) 2>/dev/null; then
  fail "fetch succeeded with no good source"
elif nothing_kept; then pass "with no good source, fetch fails and keeps nothing"
else fail "fetch left a file behind with no good source"; fi

start stall
if (fetch f "$want" https://stall.test/f) 2>/dev/null && kept \
  && [[ "$(cat "$FAKE_LOG")" == "https://stall.test/f fresh
https://stall.test/f resume" ]]; then
  pass "a stalled download resumes the partial file on the next attempt"
else fail "stalled download resume"; fi

start norange
if (fetch f "$want" https://norange.test/f https://good.test/f) 2>/dev/null && kept \
  && [[ "$(calls)" -eq $((attempts + 1)) ]]; then
  pass "a source that cannot resume is restarted, then the next source is used"
else fail "source that cannot resume"; fi

start budget
saved_budget=$budget_seconds
budget_seconds=1
SECONDS=5
if (fetch f "$want" https://good.test/f) 2>"$work/err"; then fail "fetch ran past a spent budget"
elif grep -q 'download budget is spent' "$work/err" && [[ "$(calls)" -eq 0 ]] && nothing_kept; then
  pass "a spent download budget stops fetching before any request"
else fail "spent budget"; fi
budget_seconds=$saved_budget

start replace
printf 'stale\n' > "$dir/f"
if (fetch f "$want" https://good.test/f) 2>/dev/null && kept; then
  pass "a cached file with the wrong sha256 is replaced"
else fail "stale cached file"; fi

start offline
offline=true
if (fetch f "$want" https://good.test/f) 2>/dev/null; then fail "--offline fetched a missing file"
else pass "--offline fails on a missing file"; fi
cat "$work/fixture" > "$dir/f"
if (fetch f "$want" https://good.test/f) 2>/dev/null && kept && [[ "$(calls)" -eq 0 ]]; then
  pass "--offline accepts a verified file without a request"
else fail "--offline with a verified file"; fi
offline=false

zig_urls zig-test.tar.xz
mirror_urls=$(printf '%s\n' "${zig_sources[@]}" | tail -n +2 | sed 's|/zig-test.tar.xz?source=.*||' | sort)
pinned=$(printf '%s\n' "${zig_mirrors[@]}" | sed 's|/$||' | sort)
if [[ "${zig_sources[0]}" == "$zig_base/zig-test.tar.xz" \
  && "${#zig_sources[@]}" -eq $((${#zig_mirrors[@]} + 1)) \
  && "$mirror_urls" == "$pinned" \
  && "$(printf '%s\n' "${zig_sources[@]}" | tail -n +2 | grep -vc "/zig-test.tar.xz?source=$zig_source_tag\$" || true)" -eq 0 ]]; then
  pass "Zig sources are ziglang.org, then each pinned mirror once with ?source="
else fail "Zig source list"; printf '%s\n' "${zig_sources[@]}" >&2; fi

if [[ "$failures" -gt 0 ]]; then
  echo "$failures provisioning test(s) failed" >&2
  exit 1
fi
echo "all provisioning tests passed"
