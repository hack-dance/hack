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
#   eval "$(bash term/scripts/provision-ghostty.sh)"              # shell
#   bash term/scripts/provision-ghostty.sh --emit github >> "$GITHUB_ENV"
#   bash term/scripts/provision-ghostty.sh --dir DIR --offline    # verify only
#
# Checksums: libghostty-vt files from
# https://release.files.ghostty.org/libghostty-vt/1.0.1/SHA256SUMS (they match
# ghostty-vt-sys 0.9.0's GHOSTTY.lock); Zig from
# https://ziglang.org/download/index.json; the font archive from the Nerd
# Fonts release's SHA-256.txt, and the font file from that archive. To
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

emit=shell
offline=false
dir=${HACK_DESKTOP_GHOSTTY_CACHE:-${XDG_CACHE_HOME:-$HOME/.cache}/hack-desktop/ghostty-vt-${ghostty_version}}
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir) dir=${2:?--dir needs a directory}; shift 2 ;;
    --emit) emit=${2:?--emit needs shell or github}; shift 2 ;;
    --offline) offline=true; shift ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$emit" in shell|github) ;; *) echo '--emit must be shell or github' >&2; exit 2 ;; esac

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# fetch NAME URL SHA256: leave a verified DIR/NAME, downloading if needed.
fetch() {
  local name=$1 url=$2 want=$3 got
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
  echo "provision-ghostty: fetching $name" >&2
  curl --fail --location --silent --show-error --proto '=https' --proto-redir '=https' \
    --connect-timeout 20 --max-time 600 --retry 3 -o "$dir/$name.partial" "$url"
  got=$(sha256_of "$dir/$name.partial")
  if [[ "$got" != "$want" ]]; then
    rm -f -- "$dir/$name.partial"
    echo "provision-ghostty: sha256 mismatch for $name: got $got, expected $want" >&2
    exit 1
  fi
  mv -f -- "$dir/$name.partial" "$dir/$name"
}

mkdir -p "$dir"
dir=$(CDPATH= cd -- "$dir" && pwd -P)
zig=""
case "$(uname -s)" in
  Darwin)
    fetch "$ghostty_xcframework" "$ghostty_base/$ghostty_xcframework" "$ghostty_xcframework_sha"
    ;;
  Linux)
    fetch "$ghostty_source" "$ghostty_base/$ghostty_source" "$ghostty_source_sha"
    fetch "$ghostty_deps" "$ghostty_base/$ghostty_deps" "$ghostty_deps_sha"
    case "$(uname -m)" in
      x86_64) zig_arch=x86_64; zig_sha=$zig_sha_x86_64_linux ;;
      aarch64|arm64) zig_arch=aarch64; zig_sha=$zig_sha_aarch64_linux ;;
      *) echo "provision-ghostty: no pinned Zig for $(uname -m)" >&2; exit 2 ;;
    esac
    zig_name="zig-${zig_arch}-linux-${zig_version}"
    fetch "$zig_name.tar.xz" "$zig_base/$zig_name.tar.xz" "$zig_sha"
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
fetch "$nerd_archive" "$nerd_url" "$nerd_archive_sha"
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

put() {
  if [[ "$emit" == github ]]; then printf '%s=%s\n' "$1" "$2"
  else printf 'export %s=%q\n' "$1" "$2"; fi
}
put GHOSTTY_RELEASE_DIR "$dir"
put HACK_TERM_SYMBOLS_FONT "$nerd_dir/$nerd_font"
if [[ -n "$zig" ]]; then put ZIG "$zig"; fi
