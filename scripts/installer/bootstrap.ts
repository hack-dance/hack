import { requireThat, SHA256, versionNumber } from "./integrity.ts";
import {
  TRANSFER_INACTIVITY_MS,
  TRANSFER_TOTAL_MS,
} from "./transfer-budget.ts";
/** Curl's low-speed window bounds sustained inactivity; max-time independently caps progress. */
export function curlTransferFlags({
  inactivitySeconds = TRANSFER_INACTIVITY_MS / 1000,
  totalSeconds = TRANSFER_TOTAL_MS / 1000,
}: {
  inactivitySeconds?: number;
  totalSeconds?: number;
} = {}) {
  requireThat(
    Number.isInteger(inactivitySeconds) &&
      inactivitySeconds > 0 &&
      Number.isInteger(totalSeconds) &&
      totalSeconds > 0,
    "Invalid curl transfer budget."
  );
  return [
    "--connect-timeout",
    "10",
    "--speed-limit",
    "1",
    "--speed-time",
    String(inactivitySeconds),
    "--max-time",
    String(totalSeconds),
  ];
}
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
for tool in curl shasum codesign mktemp chmod rm date; do
  command -v "$tool" >/dev/null 2>&1 || fail "Required system tool unavailable: $tool"
done
root=\${HOME:?HOME must be set}/.hack-next
root_set=0
archive=
checksum=
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || fail 'Every bootstrap option needs a value.'
  case "$1" in
    --root) [ "$root_set" -eq 0 ] || fail 'Duplicate --root.'; root=$2; root_set=1 ;;
    --archive) [ -z "$archive" ] || fail 'Duplicate --archive.'; [ -n "$2" ] || fail 'Empty --archive.'; archive=$2 ;;
    --sha256) [ -z "$checksum" ] || fail 'Duplicate --sha256.'; [ -n "$2" ] || fail 'Empty --sha256.'; checksum=$2 ;;
    *) fail 'Usage: sh installer.sh [--root /canonical/path] [--archive /canonical/archive --sha256 digest]' ;;
  esac
  shift 2
done
if [ -n "$archive" ] || [ -n "$checksum" ]; then
  [ -n "$archive" ] && [ -n "$checksum" ] || fail '--archive and --sha256 must be supplied together.'
  case "$archive" in /*) ;; *) fail 'Archive path must be absolute.' ;; esac
  case "$checksum" in *[!0-9a-f]*|'') fail 'Expected lowercase SHA-256.' ;; esac
  [ "\${#checksum}" -eq 64 ] || fail 'Expected lowercase SHA-256.'
fi
# Refuse before creating scratch or downloading. The manager validates the full root again.
case "$root" in /*) ;; *) fail 'Installation root must be absolute.' ;; esac
scratch=$(mktemp -d "\${TMPDIR:-/tmp}/hack-next-bootstrap.XXXXXXXX") || fail 'Cannot create private scratch.'
trap 'rm -rf "$scratch"' 0
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
scratch=$(CDPATH= cd -P "$scratch" && pwd -P) || fail 'Cannot canonicalize private scratch.'
url='${url}'
redirects=0
# Redirects share a wall-clock total budget. Each of at most six requests also
# has a capped max-time, so a backwards clock cannot create an unbounded transfer.
started=$(date +%s)
while :; do
  # Validate each redirect before it is requested, including host/port/userinfo.
  case "$url" in
    https://github.com/*|https://release-assets.githubusercontent.com/*|https://objects.githubusercontent.com/*) ;;
    *) fail 'Refusing nonofficial or non-HTTPS manager download.' ;;
  esac
  elapsed=$(( $(date +%s) - started ))
  [ "$elapsed" -ge 0 ] || elapsed=0
  remaining=$(( ${TRANSFER_TOTAL_MS / 1000} - elapsed ))
  [ "$remaining" -gt 0 ] || fail 'Manager total transfer budget exceeded.'
  response=$(curl --proto '=https' --tlsv1.2 --silent --show-error --fail ${curlTransferFlags().slice(0, -2).join(" ")} --max-time "$remaining" --max-filesize 268435456 --output "$scratch/manager" --write-out '%{http_code} %{redirect_url}' "$url") || fail 'Manager download failed; installation unchanged.'
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
# Ad-hoc signature verification checks structural integrity, not Developer ID origin.
# Origin trust is the official HTTPS bootstrap and its embedded manager digest.
codesign --verify --strict "$scratch/manager" >/dev/null 2>&1 || fail 'Manager code signature failed; installation unchanged.'
chmod 500 "$scratch/manager"
if [ -n "$archive" ]; then
  "$scratch/manager" --root "$root" install --version '${version}' --archive "$archive" --sha256 "$checksum"
else
  "$scratch/manager" --root "$root" install --version '${version}'
fi
printf 'Candidate command: %s/bin/hack-next\\n' "$root"
if [ "$root" = "$HOME/.hack-next" ]; then\n  printf '%s\\n' 'For this shell: export PATH="$HOME/.hack-next/bin:$PATH"'\nfi\nprintf 'Stable hack and shell PATH are unchanged.\\n'
`;
}
