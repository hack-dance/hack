import { requireThat, SHA256, versionNumber } from "./integrity.ts";
export const MANAGER_ASSET = "hack-next-manager-darwin-arm64";
export const BOOTSTRAP_ASSET = "hack-next-install.sh";
export const INSTALLER_SUMS = "INSTALLER-SHA256SUMS";
/** Render only from verified package bytes; the script never discovers a mutable latest candidate. */
export function renderBootstrap(version: string, checksum: string) {
  versionNumber(version);
  requireThat(SHA256.test(checksum), "Invalid standalone manager checksum.");
  const url = `https://github.com/hack-dance/hack/releases/download/v${version}/${MANAGER_ASSET}`;
  return `#!/bin/sh
set -eu
umask 077
fail() { printf '%s\\n' "hack-next: $*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || fail 'Native prereleases support Apple Silicon macOS only.'
for tool in curl shasum codesign mktemp chmod rm; do
  command -v "$tool" >/dev/null 2>&1 || fail "Required system tool unavailable: $tool"
done
root=\${HOME:?HOME must be set}/.hack-next
if [ "$#" -ne 0 ]; then
  [ "$#" -eq 2 ] && [ "$1" = --root ] || fail 'Usage: sh installer.sh [--root /canonical/private/path]'
  root=$2
fi
# Refuse before creating scratch or downloading. The manager validates the full root again.
case "$root" in /*) ;; *) fail 'Installation root must be absolute.' ;; esac
scratch=$(mktemp -d "\${TMPDIR:-/tmp}/hack-next-bootstrap.XXXXXXXX") || fail 'Cannot create private scratch.'
trap 'rm -rf "$scratch"' 0
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
url='${url}'
redirects=0
while :; do
  # Validate each redirect before it is requested, including host/port/userinfo.
  case "$url" in
    https://github.com/*|https://release-assets.githubusercontent.com/*|https://objects.githubusercontent.com/*) ;;
    *) fail 'Refusing nonofficial or non-HTTPS manager download.' ;;
  esac
  response=$(curl --proto '=https' --tlsv1.2 --silent --show-error --fail --connect-timeout 10 --max-time 30 --max-filesize 268435456 --output "$scratch/manager" --write-out '%{http_code} %{redirect_url}' "$url") || fail 'Manager download failed; installation unchanged.'
  code=\${response%% *}
  case "$code" in
    200) break ;;
    301|302|303|307|308)
      [ "$redirects" -lt 5 ] || fail 'Manager redirect budget exceeded.'
      redirects=$((redirects + 1))
      url=\${response#* }
      ;;
    *) fail 'Manager download returned an unexpected status.' ;;
  esac
done
printf '%s  %s\\n' '${checksum}' "$scratch/manager" | shasum -a 256 -c - >/dev/null || fail 'Manager checksum mismatch; installation unchanged.'
codesign --verify --strict "$scratch/manager" >/dev/null 2>&1 || fail 'Manager code signature failed; installation unchanged.'
chmod 500 "$scratch/manager"
"$scratch/manager" --root "$root" install --version '${version}'
printf 'Candidate command: %s/bin/hack-next\\n' "$root"
if [ "$root" = "$HOME/.hack-next" ]; then\n  printf '%s\\n' 'For this shell: export PATH="$HOME/.hack-next/bin:$PATH"'\nfi\nprintf 'Stable hack and shell PATH are unchanged.\\n'
`;
}
