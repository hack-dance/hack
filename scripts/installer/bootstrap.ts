import {
  TRANSFER_INACTIVITY_MS,
  TRANSFER_TOTAL_MS,
} from "../../src/lib/release-transfer-budget.ts";
import {
  candidateVersion,
  LINUX_BUNDLE_PLATFORMS,
  requireThat,
  SHA256,
  UNSUPPORTED_HOST,
} from "./integrity.ts";
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
/** What a Linux install prints last, so nobody expects the native backend there. */
export const LINUX_INSTALLED_NOTE =
  "Installed the Compose backend. The native backend is Apple Silicon macOS only.";
/** SHA-256 of each Linux manager a release ships, as `SHA256SUMS-linux` lists them. */
export type LinuxManagerDigests = Readonly<
  Record<(typeof LINUX_BUNDLE_PLATFORMS)[number], string>
>;
/**
 * Render only from verified package bytes; the script never discovers a mutable latest candidate.
 *
 * One script serves every platform: it picks the manager by `uname` and checks
 * the digest embedded for that platform. `linux` is absent only for a
 * macOS-only asset set; the script then refuses on Linux.
 */
export function renderBootstrap(
  version: string,
  checksum: string,
  linux?: LinuxManagerDigests
) {
  candidateVersion(version);
  requireThat(SHA256.test(checksum), "Invalid standalone manager checksum.");
  for (const platform of linux ? LINUX_BUNDLE_PLATFORMS : []) {
    requireThat(
      SHA256.test(linux?.[platform] ?? ""),
      "Invalid standalone Linux manager checksum."
    );
  }
  const base = `https://github.com/hack-dance/hack/releases/download/v${version}/`;
  const linuxCase = (platform: (typeof LINUX_BUNDLE_PLATFORMS)[number]) =>
    linux
      ? `platform=${platform}; manager_sha256='${linux[platform]}'`
      : "fail 'This release has no Linux bundle; Linux bundles start with a later release.'";
  return `#!/bin/sh
set -eu
umask 077
fail() { printf '%s\\n' "hack-next: $*" >&2; exit 1; }
# One script for every platform. Linux installs the Compose backend only.
case "$(uname -s)/$(uname -m)" in
  Darwin/arm64) platform=${MANAGER_ASSET.slice("hack-next-manager-".length)}; manager_sha256='${checksum}' ;;
  Linux/x86_64|Linux/amd64) ${linuxCase("linux-x86_64")} ;;
  Linux/aarch64|Linux/arm64) ${linuxCase("linux-arm64")} ;;
  *) fail "${UNSUPPORTED_HOST} This host is $(uname -s) $(uname -m)." ;;
esac
root=\${HOME:?HOME must be set}/.hack-next
root_set=0
archive=
checksum=
manager=
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || fail 'Every bootstrap option needs a value.'
  case "$1" in
    --root) [ "$root_set" -eq 0 ] || fail 'Duplicate --root.'; root=$2; root_set=1 ;;
    --archive) [ -z "$archive" ] || fail 'Duplicate --archive.'; [ -n "$2" ] || fail 'Empty --archive.'; archive=$2 ;;
    --sha256) [ -z "$checksum" ] || fail 'Duplicate --sha256.'; [ -n "$2" ] || fail 'Empty --sha256.'; checksum=$2 ;;
    --manager) [ -z "$manager" ] || fail 'Duplicate --manager.'; [ -n "$2" ] || fail 'Empty --manager.'; manager=$2 ;;
    *) fail 'Usage: sh installer.sh [--root /canonical/path] [--archive /canonical/archive --sha256 digest] [--manager /downloaded/manager]' ;;
  esac
  shift 2
done
if [ -n "$archive" ] || [ -n "$checksum" ]; then
  [ -n "$archive" ] && [ -n "$checksum" ] || fail '--archive and --sha256 must be supplied together.'
  case "$archive" in /*) ;; *) fail 'Archive path must be absolute.' ;; esac
  case "$checksum" in *[!0-9a-f]*|'') fail 'Expected lowercase SHA-256.' ;; esac
  [ "\${#checksum}" -eq 64 ] || fail 'Expected lowercase SHA-256.'
fi
# A manager file you already downloaded replaces only the transfer: it is
# checked against the same embedded digest before it runs.
if [ -n "$manager" ]; then
  case "$manager" in /*) ;; *) fail 'Manager path must be absolute.' ;; esac
  [ -f "$manager" ] || fail 'Supplied manager is not a regular file.'
  tools='cat'
else
  tools='curl'
fi
if [ "$platform" = darwin-arm64 ]; then
  tools="$tools shasum codesign mktemp chmod rm date"
  sha256_check='shasum -a 256 -c -'
else
  tools="$tools mktemp chmod rm date"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256_check='sha256sum -c -'
  elif command -v shasum >/dev/null 2>&1; then
    sha256_check='shasum -a 256 -c -'
  else
    fail 'Required system tool unavailable: sha256sum (or shasum)'
  fi
fi
for tool in $tools; do
  command -v "$tool" >/dev/null 2>&1 || fail "Required system tool unavailable: $tool"
done
# Refuse before creating scratch or downloading. The manager validates the full root again.
case "$root" in /*) ;; *) fail 'Installation root must be absolute.' ;; esac
scratch=$(mktemp -d "\${TMPDIR:-/tmp}/hack-next-bootstrap.XXXXXXXX") || fail 'Cannot create private scratch.'
trap 'rm -rf "$scratch"' 0
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP
scratch=$(CDPATH= cd -P "$scratch" && pwd -P) || fail 'Cannot canonicalize private scratch.'
url="${base}hack-next-manager-$platform"
redirects=0
# Redirects share a wall-clock total budget. Each of at most six requests also
# has a capped max-time, so a backwards clock cannot create an unbounded transfer.
started=$(date +%s)
while [ -z "$manager" ]; do
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
if [ -n "$manager" ]; then
  cat "$manager" > "$scratch/manager" || fail 'Cannot read the supplied manager; installation unchanged.'
fi
printf '%s  %s\\n' "$manager_sha256" "$scratch/manager" | $sha256_check >/dev/null || fail 'Manager checksum mismatch; installation unchanged.'
if [ "$platform" = darwin-arm64 ]; then
  # Ad-hoc signature verification checks structural integrity, not Developer ID origin.
  # Origin trust is the official HTTPS bootstrap and its embedded manager digest.
  codesign --verify --strict "$scratch/manager" >/dev/null 2>&1 || fail 'Manager code signature failed; installation unchanged.'
fi
chmod 500 "$scratch/manager"
if [ "$platform" != darwin-arm64 ]; then
  # Linux executables are not code signed; the embedded digest above is the check.
  "$scratch/manager" --help >/dev/null 2>&1 || fail "The verified manager cannot run from $scratch; installation unchanged. Linux prereleases need glibc (musl-based systems such as Alpine are not supported) and a temporary directory that allows execution (set TMPDIR)."
fi
if [ -n "$archive" ]; then
  "$scratch/manager" --root "$root" install --version '${version}' --archive "$archive" --sha256 "$checksum"
else
  "$scratch/manager" --root "$root" install --version '${version}'
fi
printf 'Candidate command: %s/bin/hack-next\\n' "$root"
if [ "$root" = "$HOME/.hack-next" ]; then\n  printf '%s\\n' 'For this shell: export PATH="$HOME/.hack-next/bin:$PATH"'\nfi\nprintf 'Stable hack and shell PATH are unchanged.\\n'
if [ "$platform" != darwin-arm64 ]; then
  printf '%s\\n' '${LINUX_INSTALLED_NOTE}'
fi
`;
}
