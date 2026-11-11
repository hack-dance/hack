/**
 * Install a file as root without root ever opening a path the invoking user
 * can write.
 *
 * The content crosses to root on standard input from the Hack process. The
 * root step:
 * 1. refuses a destination that is not absolute, or whose directory, or any
 *    ancestor up to `/`, is a link or is not root-owned without group/world
 *    write (it creates a missing directory itself, root-owned, 0755, after
 *    checking the existing ancestors);
 * 2. creates its temporary file with `mktemp` inside that directory, so the
 *    file is root-owned and no other user can replace or redirect it;
 * 3. reads at most the declared number of bytes from stdin, within a time
 *    limit, and refuses any other length;
 * 4. checks the SHA-256 digest passed as an argument against those bytes;
 * 5. sets owner and mode, then renames the temporary file over the
 *    destination (a rename replaces a link at the destination; it never
 *    writes through it; a directory there fails the step).
 * The temporary file is removed on every failure. Arguments are positional
 * (`/bin/sh -c SCRIPT hack-install BYTES SHA256 DEST MODE`), never
 * interpolated.
 */
import { createHash } from "node:crypto";

/** Seconds root waits for the declared bytes on stdin. */
export const STDIN_INSTALL_TIMEOUT_SECONDS = 30;
/** Largest file this helper installs. */
export const STDIN_INSTALL_MAX_BYTES = 1_048_576;
const ALLOWED_MODES = ["0644", "0444"] as const;
export type InstallMode = (typeof ALLOWED_MODES)[number];

/** The root script; `timeoutSeconds` is a test seam for the stdin wait. */
export function renderStdinInstallScript(opts?: {
  readonly timeoutSeconds?: number;
}): string {
  const seconds = opts?.timeoutSeconds ?? STDIN_INSTALL_TIMEOUT_SECONDS;
  return [
    "set -eu",
    "umask 077",
    'n="$1"; sum="$2"; dest="$3"; mode="$4"',
    `case "$n" in ""|*[!0-9]*) exit 64;; esac`,
    `[ "$n" -le ${STDIN_INSTALL_MAX_BYTES} ] || exit 64`,
    'case "$sum" in *[!0-9a-f]*) exit 64;; esac',
    '[ "$(printf %s "$sum" | wc -c)" -eq 64 ] || exit 64',
    `case "$mode" in ${ALLOWED_MODES.join("|")}) ;; *) exit 64;; esac`,
    'case "$dest" in /*) ;; *) exit 64;; esac',
    'case "$dest" in */) exit 64;; esac',
    'dir="$(dirname -- "$dest")"',
    // A directory is safe when it is not a link, and is root-owned and not
    // writable by group or others; a chain is safe when every directory from
    // it up to / is. Then only root can rename or replace anything on the
    // path, so the temporary file below cannot be swapped or redirected.
    'safe() { [ ! -L "$1" ] && [ -d "$1" ] && [ -z "$(find "$1" -maxdepth 0 \\( ! -user 0 -o -perm /022 \\) -print)" ]; }',
    'chain() { c="$1"; while :; do safe "$c" || return 1; [ "$c" = / ] && return 0; c="$(dirname -- "$c")"; done; }',
    // Check the nearest existing ancestor's chain before creating anything.
    'e="$dir"; while [ ! -e "$e" ] && [ ! -L "$e" ]; do e="$(dirname -- "$e")"; done',
    'chain "$e" || exit 65',
    '[ -d "$dir" ] || install -d -o root -g root -m 0755 -- "$dir"',
    'chain "$dir" || exit 65',
    'tmp="$(mktemp -- "$dir/.hack-install.XXXXXXXX")"',
    `trap 'rm -f -- "$tmp"' EXIT`,
    `timeout -k 1 ${seconds} head -c "$n" > "$tmp"`,
    '[ "$(wc -c < "$tmp")" -eq "$n" ] || exit 66',
    'printf "%s  %s\\n" "$sum" "$tmp" | sha256sum -c --status || exit 67',
    'chown root:root -- "$tmp"',
    'chmod "$mode" -- "$tmp"',
    // -T: a directory at the destination fails instead of receiving the file.
    'mv -fT -- "$tmp" "$dest"',
    "trap - EXIT",
  ].join("; ");
}

export const STDIN_INSTALL_SCRIPT = renderStdinInstallScript();

export type StdinInstallStep = {
  /** Run as `sudo <argv>` with `input` on stdin. */
  readonly argv: readonly string[];
  readonly input: Uint8Array;
  readonly target: string;
  readonly sha256: string;
};

export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The root step that installs exactly `content` at `target`. */
export function stdinInstallStep(opts: {
  readonly target: string;
  readonly content: string | Uint8Array;
  readonly mode?: InstallMode;
}): StdinInstallStep {
  const input =
    typeof opts.content === "string"
      ? new TextEncoder().encode(opts.content)
      : Uint8Array.from(opts.content);
  const sha256 = sha256Hex(input);
  return {
    argv: [
      "/bin/sh",
      "-c",
      STDIN_INSTALL_SCRIPT,
      "hack-install",
      String(input.byteLength),
      sha256,
      opts.target,
      opts.mode ?? "0644",
    ],
    input,
    target: opts.target,
    sha256,
  };
}
