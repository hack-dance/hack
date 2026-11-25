# shellcheck shell=bash
# Verified downloads for CI and build scripts: fetch tries a list of URLs,
# resumes stalled transfers, bounds the total time, and keeps a file only
# when it matches a pinned sha256. zig_urls lists ziglang.org and its
# community mirrors for a Zig tarball. Source this file from bash (3.2 or
# newer); it defines functions and settings and runs nothing.
#
# Used by apps/desktop/term/scripts/provision-ghostty.sh and
# scripts/fetch-zig.sh; apps/desktop/term/scripts/test-provision-ghostty.sh
# and tests/ci-download-helpers.test.ts cover it offline.

# Community mirrors from https://ziglang.org/download/community-mirrors.txt,
# pinned here on 2026-11-25 so CI does not need ziglang.org to find one. A
# mirror serves FILE at MIRROR/FILE and asks for a ?source= tag.
zig_mirrors=(
  https://pkg.hexops.org/zig
  https://zigmirror.hryx.net/zig
  https://zig.linus.dev/zig
  https://zig.squirl.dev
  https://zig.mirror.mschae23.de/zig
  https://ziglang.freetls.fastly.net
  https://zig.tilok.dev
  https://zig-mirror.tsimnet.eu/zig
  https://zig.karearl.com/zig
  https://pkg.earth/zig
  https://fs.liujiacai.net/zigbuilds
  https://zigmirror.com
  https://zig.chainsafe.dev
  https://zig.savalione.com
  https://zig.bcr.ist
  https://zig.vortan.dev/zig
  https://pkg.alexrp.com/zig
)
zig_source_tag=${zig_source_tag:-hack-ci}

# Messages start with this name.
fetch_log=${fetch_log:-fetch-verified}
# fetch writes into $dir; with offline=true it only verifies what is there.
dir=${dir:-}
offline=${offline:-false}

# Download limits. Each attempt gives up when it moves under min_speed
# bytes/s for speed_seconds, or after attempt_seconds, and the next attempt
# resumes the partial file. A source gets `attempts` tries before the next
# source, and all downloads in one run share a budget of budget_seconds, so
# a run with every source slow still fails inside a CI job's timeout.
# HACK_FETCH_SLOW_OK=1 is for a slow link: no time caps or budget,
# and only a connection that sends nothing for 5 minutes is given up on.
min_speed=51200
speed_seconds=30
attempt_seconds=300
attempts=3
retry_delay=5
budget_seconds=900
if [[ "${HACK_FETCH_SLOW_OK:-}" == 1 ]]; then
  min_speed=1
  speed_seconds=300
  attempt_seconds=0
  budget_seconds=0
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# The URL with any query removed, for messages.
show_url() { printf '%s' "${1%%\?*}"; }

# curl_once FILE URL MAX_SECONDS: one attempt, resuming FILE if it has
# bytes. curl's own --retry is not used: it restarts at byte 0, even with
# --continue-at, which throws away a stalled transfer's progress.
curl_once() {
  local -a args
  args=(--fail --location --silent --show-error --proto '=https' --proto-redir '=https'
    --connect-timeout 15)
  args+=(--speed-limit "$min_speed" --speed-time "$speed_seconds")
  if [[ "$3" -gt 0 ]]; then args+=(--max-time "$3"); fi
  if [[ -s "$1" ]]; then args+=(--continue-at -); fi
  curl "${args[@]}" -o "$1" "$2"
}

# The time left in the budget, in seconds; 0 means unlimited, so a spent
# budget prints -1.
budget_left() {
  if [[ "$budget_seconds" -eq 0 ]]; then echo 0; return; fi
  local left=$((budget_seconds - SECONDS))
  if [[ "$left" -le 0 ]]; then echo -1; else echo "$left"; fi
}

# fetch NAME SHA256 URL...: leave a verified DIR/NAME, downloading if needed.
# The URLs are tried in order. A download that fails `attempts` times, or
# whose sha256 does not match, moves on to the next URL; when none is left,
# or the budget is spent, the script fails. Only bytes matching SHA256 are
# ever moved to DIR/NAME.
fetch() {
  local name=$1 want=$2 got url try left max status resumed
  shift 2
  local part="$dir/$name.partial"
  if [[ -f "$dir/$name" ]]; then
    got=$(sha256_of "$dir/$name")
    if [[ "$got" == "$want" ]]; then return 0; fi
    echo "$fetch_log: $name has sha256 $got, expected $want; replacing it" >&2
    rm -f -- "$dir/$name"
  fi
  if [[ "$offline" == true ]]; then
    echo "$fetch_log: $dir/$name is missing and --offline was given" >&2
    exit 1
  fi
  for url in "$@"; do
    echo "$fetch_log: fetching $name from $(show_url "$url")" >&2
    rm -f -- "$part"
    try=1
    while :; do
      left=$(budget_left)
      if [[ "$left" -lt 0 ]]; then
        rm -f -- "$part"
        echo "$fetch_log: the ${budget_seconds}s download budget is spent; giving up on $name" >&2
        exit 1
      fi
      max=$attempt_seconds
      if [[ "$left" -gt 0 && ( "$max" -eq 0 || "$left" -lt "$max" ) ]]; then max=$left; fi
      resumed=false
      if [[ -s "$part" ]]; then resumed=true; fi
      status=0
      curl_once "$part" "$url" "$max" || status=$?
      if [[ "$status" -eq 0 ]]; then
        got=$(sha256_of "$part")
        if [[ "$got" == "$want" ]]; then
          mv -f -- "$part" "$dir/$name"
          return 0
        fi
        echo "$fetch_log: sha256 mismatch for $name from $(show_url "$url"): got $got, expected $want" >&2
        rm -f -- "$part"
        # A resumed file can be bad because the source changed under it;
        # a fresh download from the same source cannot be fixed by retrying.
        if [[ "$resumed" == false ]]; then break; fi
      elif [[ "$resumed" == true && ( "$status" -eq 33 || "$status" -eq 36 || "$status" -eq 22 ) ]]; then
        # The server cannot resume (or refused the range); start over.
        rm -f -- "$part"
      fi
      if [[ "$try" -ge "$attempts" ]]; then
        echo "$fetch_log: giving up on $name from $(show_url "$url") after $try attempts" >&2
        break
      fi
      try=$((try + 1))
      sleep "$retry_delay"
    done
  done
  rm -f -- "$part"
  echo "$fetch_log: could not fetch a verified $name from any source" >&2
  exit 1
}

# zig_urls FILE: set zig_sources to $zig_base/FILE (the caller sets zig_base
# to ziglang.org's directory for the version), then every
# mirror's. Zig asks automation to spread load across mirrors, so they
# start at a random offset; ziglang.org stays first so the usual path is
# unchanged. Mirrors are untrusted: fetch's sha256 check is what makes
# their bytes acceptable.
zig_urls() {
  local file=$1 i n start
  # shellcheck disable=SC2154 # zig_base is the caller's, as documented above
  zig_sources=("$zig_base/$file")
  n=${#zig_mirrors[@]}
  if [[ "$n" -eq 0 ]]; then return 0; fi
  start=$((RANDOM % n))
  for ((i = 0; i < n; i++)); do
    zig_sources+=("${zig_mirrors[$(((start + i) % n))]%/}/$file?source=$zig_source_tag")
  done
}

