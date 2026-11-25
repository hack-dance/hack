#!/usr/bin/env bash
# Fetch the pinned inputs for the `ghostty` feature of hack-desktop-term into
# a cache directory, verify each against the sha256 committed below, and
# print the environment a build needs. This is the only step that uses the
# network; with its output exported, cargo builds libghostty-vt offline.
#
#   Linux: Zig 0.17.1 (official tarball) plus the libghostty-vt 1.0.1 source
#          and Zig-package tarballs (built from source).
#   macOS: the libghostty-vt 1.0.1 prebuilt XCFramework (no Zig).
#   Both:  Symbols Nerd Font Mono 3.5.1, the terminal's fallback font for
#          prompt symbols. It is embedded in the build.
#
# Usage:
#   bash term/scripts/provision-ghostty.sh >/dev/null   # fill the default dir
#   eval "$(bash term/scripts/provision-ghostty.sh)"              # shell
#   bash term/scripts/provision-ghostty.sh --emit github >> "$GITHUB_ENV"
#   bash term/scripts/provision-ghostty.sh --dir DIR --offline    # verify only
#   HACK_DESKTOP_FETCH_SLOW_OK=1 bash term/scripts/provision-ghostty.sh # slow link
#
# Checksums: libghostty-vt files from
# https://release.files.ghostty.org/libghostty-vt/1.0.1/SHA256SUMS (they match
# ghostty-vt-sys 0.9.0's GHOSTTY.lock); Zig from
# https://ziglang.org/download/index.json; the font archive from the Nerd
# Fonts release's SHA-256.txt, and the font file from that archive. Zig falls
# back to community mirrors (see zig_urls); the sha256 gates every source, and
# test-provision-ghostty.sh covers the download fallback offline. To
# change a version, change the URL and the checksum together (the font
# file's checksum is also pinned in term/build.rs).
set -euo pipefail

ghostty_version=1.0.1
ghostty_base="https://release.files.ghostty.org/libghostty-vt/${ghostty_version}"
ghostty_source="libghostty-vt-${ghostty_version}.tar.gz"
ghostty_source_sha=333dfce97641ef9b536bb9e08907ad86abaaada50e8f7417b70d9284adef37aa
ghostty_deps="libghostty-vt-${ghostty_version}-deps.tar.gz"
ghostty_deps_sha=91a4e10960a52bf5bf4b15aa2a2cddaff8a89d6cd903d3055bda4fd17de3356d
ghostty_xcframework="ghostty-vt-${ghostty_version}.xcframework.zip"
ghostty_xcframework_sha=c0f9631277f726154c8f521954d17cdc41aac4626fc0df8cf925a19ee58e829b

nerd_version=3.5.1
nerd_url="https://github.com/ryanoasis/nerd-fonts/releases/download/v${nerd_version}/NerdFontsSymbolsOnly.tar.xz"
nerd_archive="NerdFontsSymbolsOnly-${nerd_version}.tar.xz"
nerd_archive_sha=01172f37db8543edb102e5cb5c64101c9f4686630804d49b419aa07b23a69996
nerd_font=SymbolsNerdFontMono-Regular.ttf
nerd_font_sha=fe471e538392f51910faab985fa8e192a39dd3426125edd15b71b3680df0e749

zig_version=0.17.1
zig_base="https://ziglang.org/download/${zig_version}"
zig_sha_x86_64_linux=3581863e3cbcfd0fce0efc682ce7e9e93da96668a977791d356a26d2a7e9b17a
zig_sha_aarch64_linux=a1546d5646eb184437918d6635ca6b762a0e889eac09cef720ee7a1ed3fe7795

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
zig_source_tag=hack-desktop-provision-ghostty

# Download limits. Each attempt gives up when it moves under min_speed
# bytes/s for speed_seconds, or after attempt_seconds, and the next attempt
# resumes the partial file. A source gets `attempts` tries before the next
# source, and all downloads in one run share a budget of budget_seconds, so
# a run with every source slow still fails inside the CI job's timeout.
# HACK_DESKTOP_FETCH_SLOW_OK=1 is for a slow link: no time caps or budget,
# and only a connection that sends nothing for 5 minutes is given up on.
min_speed=51200
speed_seconds=30
attempt_seconds=300
attempts=3
retry_delay=5
budget_seconds=900
if [[ "${HACK_DESKTOP_FETCH_SLOW_OK:-}" == 1 ]]; then
  min_speed=1
  speed_seconds=300
  attempt_seconds=0
  budget_seconds=0
fi

emit=shell
offline=false
dir=""

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
    echo "provision-ghostty: $name has sha256 $got, expected $want; replacing it" >&2
    rm -f -- "$dir/$name"
  fi
  if [[ "$offline" == true ]]; then
    echo "provision-ghostty: $dir/$name is missing and --offline was given" >&2
    exit 1
  fi
  for url in "$@"; do
    echo "provision-ghostty: fetching $name from $(show_url "$url")" >&2
    rm -f -- "$part"
    try=1
    while :; do
      left=$(budget_left)
      if [[ "$left" -lt 0 ]]; then
        rm -f -- "$part"
        echo "provision-ghostty: the ${budget_seconds}s download budget is spent; giving up on $name" >&2
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
        echo "provision-ghostty: sha256 mismatch for $name from $(show_url "$url"): got $got, expected $want" >&2
        rm -f -- "$part"
        # A resumed file can be bad because the source changed under it;
        # a fresh download from the same source cannot be fixed by retrying.
        if [[ "$resumed" == false ]]; then break; fi
      elif [[ "$resumed" == true && ( "$status" -eq 33 || "$status" -eq 36 || "$status" -eq 22 ) ]]; then
        # The server cannot resume (or refused the range); start over.
        rm -f -- "$part"
      fi
      if [[ "$try" -ge "$attempts" ]]; then
        echo "provision-ghostty: giving up on $name from $(show_url "$url") after $try attempts" >&2
        break
      fi
      try=$((try + 1))
      sleep "$retry_delay"
    done
  done
  rm -f -- "$part"
  echo "provision-ghostty: could not fetch a verified $name from any source" >&2
  exit 1
}

# zig_urls FILE: set zig_sources to ziglang.org's URL for FILE, then every
# mirror's. Zig asks automation to spread load across mirrors, so they
# start at a random offset; ziglang.org stays first so the usual path is
# unchanged. Mirrors are untrusted: fetch's sha256 check is what makes
# their bytes acceptable.
zig_urls() {
  local file=$1 i n start
  zig_sources=("$zig_base/$file")
  n=${#zig_mirrors[@]}
  if [[ "$n" -eq 0 ]]; then return 0; fi
  start=$((RANDOM % n))
  for ((i = 0; i < n; i++)); do
    zig_sources+=("${zig_mirrors[$(((start + i) % n))]%/}/$file?source=$zig_source_tag")
  done
}

put() {
  if [[ "$emit" == github ]]; then printf '%s=%s\n' "$1" "$2"
  else printf 'export %s=%q\n' "$1" "$2"; fi
}

main() {
  # The default is apps/desktop/target/ghostty-inputs, the directory
  # apps/desktop/.cargo/config.toml names as GHOSTTY_RELEASE_DIR, so a build
  # from apps/desktop finds the inputs there without exporting anything.
  dir=${HACK_DESKTOP_GHOSTTY_CACHE:-$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)/target/ghostty-inputs}
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --dir) dir=${2:?--dir needs a directory}; shift 2 ;;
      --emit) emit=${2:?--emit needs shell or github}; shift 2 ;;
      --offline) offline=true; shift ;;
      -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
      *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
  done
  case "$emit" in shell|github) ;; *) echo '--emit must be shell or github' >&2; exit 2 ;; esac

  mkdir -p "$dir"
  dir=$(CDPATH='' cd -- "$dir" && pwd -P)
  local zig="" zig_arch zig_sha zig_name nerd_dir
  case "$(uname -s)" in
    Darwin)
      fetch "$ghostty_xcframework" "$ghostty_xcframework_sha" "$ghostty_base/$ghostty_xcframework"
      ;;
    Linux)
      fetch "$ghostty_source" "$ghostty_source_sha" "$ghostty_base/$ghostty_source"
      fetch "$ghostty_deps" "$ghostty_deps_sha" "$ghostty_base/$ghostty_deps"
      case "$(uname -m)" in
        x86_64) zig_arch=x86_64; zig_sha=$zig_sha_x86_64_linux ;;
        aarch64|arm64) zig_arch=aarch64; zig_sha=$zig_sha_aarch64_linux ;;
        *) echo "provision-ghostty: no pinned Zig for $(uname -m)" >&2; exit 2 ;;
      esac
      zig_name="zig-${zig_arch}-linux-${zig_version}"
      zig_urls "$zig_name.tar.xz"
      fetch "$zig_name.tar.xz" "$zig_sha" "${zig_sources[@]}"
      # Extract once per verified tarball; the stamp records which one.
      if [[ "$(cat "$dir/$zig_name/.provision-sha256" 2>/dev/null || true)" != "$zig_sha" || ! -x "$dir/$zig_name/zig" ]]; then
        rm -rf -- "${dir:?}/$zig_name" "${dir:?}/$zig_name.extract"
        mkdir "$dir/$zig_name.extract"
        tar -xJf "$dir/$zig_name.tar.xz" -C "$dir/$zig_name.extract"
        mv -- "$dir/$zig_name.extract/$zig_name" "$dir/$zig_name"
        rmdir "$dir/$zig_name.extract"
        printf '%s\n' "$zig_sha" > "$dir/$zig_name/.provision-sha256"
      fi
      zig="$dir/$zig_name/zig"
      if [[ "$("$zig" version)" != "$zig_version" ]]; then
        echo "provision-ghostty: $zig is not Zig $zig_version" >&2
        exit 1
      fi
      ;;
    *) echo "provision-ghostty: unsupported platform $(uname -s)" >&2; exit 2 ;;
  esac

  # The symbols font, on every platform: the font file plus the archive's
  # licence and its list of icon-set licences, kept beside it.
  fetch "$nerd_archive" "$nerd_archive_sha" "$nerd_url"
  nerd_dir="$dir/nerd-fonts-symbols-${nerd_version}"
  if [[ ! -f "$nerd_dir/$nerd_font" || "$(sha256_of "$nerd_dir/$nerd_font")" != "$nerd_font_sha" ]]; then
    rm -rf -- "${nerd_dir:?}" "${nerd_dir:?}.extract"
    mkdir "$nerd_dir.extract"
    tar -xJf "$dir/$nerd_archive" -C "$nerd_dir.extract" "$nerd_font" LICENSE README.md
    mv -- "$nerd_dir.extract" "$nerd_dir"
  fi
  if [[ "$(sha256_of "$nerd_dir/$nerd_font")" != "$nerd_font_sha" ]]; then
    echo "provision-ghostty: sha256 mismatch for $nerd_font" >&2
    exit 1
  fi

  put GHOSTTY_RELEASE_DIR "$dir"
  put HACK_TERM_SYMBOLS_FONT "$nerd_dir/$nerd_font"
  if [[ -n "$zig" ]]; then put ZIG "$zig"; fi
}

# Sourcing the script (as test-provision-ghostty.sh does) defines the
# functions and settings without running anything.
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
