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
 * 2. creates its temporary file exclusively inside that directory, so the
 *    file is root-owned and no other user can replace or redirect it;
 * 3. reads at most one byte more than declared from stdin, within a time
 *    limit, and refuses any length other than the declared one (longer
 *    input is refused, not truncated);
 * 4. checks the SHA-256 digest passed as an argument against those bytes;
 * 5. sets owner and mode, then renames the temporary file over the
 *    destination (a rename replaces a link at the destination; it never
 *    writes through it; a directory there fails the step).
 * The temporary file is removed on every failure, including a signal. The
 * signal handler never signals any process: a shell cannot tell atomically
 * whether a child pid is already reaped (and so possibly reused), so the
 * stdin reader is never cancelled by pid. After a signal it stops on its own,
 * at end of input (Hack writes the input in full and closes the pipe) or at
 * the time limit, and until then writes only to the temporary file, already
 * unlinked.
 * `.` and `..` components are refused, and the file is synced before the
 * rename. Arguments are positional
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
    // No `.` or `..` components: the ancestor walk below is lexical.
    'case "$dest" in */./*|*/../*|*/.|*/..) exit 64;; esac',
    'dir="$(dirname -- "$dest")"',
    // A directory is safe when it is not a link, and is root-owned and not
    // writable by group or others; a chain is safe when every directory from
    // it up to / is. Then only root can rename or replace anything on the
    // path, so the temporary file below cannot be swapped or redirected.
    // The ownership probe fails closed: a failed or missing `find` (non-zero
    // exit) refuses the directory instead of reading as "no violations".
    'safe() { [ ! -L "$1" ] && [ -d "$1" ] || return 1; v="$(find "$1" -maxdepth 0 \\( ! -user 0 -o -perm /022 \\) -print)" || return 1; [ -z "$v" ]; }',
    'chain() { c="$1"; while :; do safe "$c" || return 1; [ "$c" = / ] && return 0; c="$(dirname -- "$c")"; done; }',
    // Check the nearest existing ancestor's chain before creating anything.
    'e="$dir"; while [ ! -e "$e" ] && [ ! -L "$e" ]; do e="$(dirname -- "$e")"; done',
    'chain "$e" || exit 65',
    '[ -d "$dir" ] || install -d -o root -g root -m 0755 -- "$dir"',
    'chain "$dir" || exit 65',
    // Traps first, so no signal can arrive after the file exists but before
    // cleanup is armed. dash skips the EXIT trap when a signal kills it, so
    // every signal becomes a normal exit. The handler only exits: it never
    // signals the reader (see the module comment).
    "tmp=",
    `trap '[ -z "$tmp" ] || rm -f -- "$tmp"' EXIT`,
    "trap 'exit 130' HUP INT TERM",
    // The name is set before the file exists, and noclobber makes the
    // create exclusive. Only root can write in this directory (checked
    // above), so a per-process name is enough and nothing can pre-empt it.
    // The shell itself opens the file, as descriptor 4, before the reader
    // starts: the reader inherits that descriptor and never opens a path, so
    // a reader outliving a signal cannot recreate the file after the EXIT
    // trap removed it.
    'tmp="$dir/.hack-install.$$"',
    'set -C; exec 4> "$tmp"; set +C',
    // One byte past the declared count, so longer input is seen and refused.
    // The read runs in the background on a copy of stdin (an asynchronous
    // list would otherwise read /dev/null) and the shell waits for it: a
    // trapped signal interrupts `wait` at once and exits, and the EXIT trap
    // removes the temporary file. The reader, bounded by its time limit and
    // by end of input, then writes only to that unlinked file.
    "exec 3<&0",
    `timeout -k 1 ${seconds} head -c "$((n + 1))" <&3 >&4 & reader=$!`,
    'wait "$reader" || exit 66',
    // Later steps (and a caller's appended command) do not inherit either.
    "exec 3<&- 4>&-",
    '[ "$(wc -c < "$tmp")" -eq "$n" ] || exit 66',
    'printf "%s  %s\\n" "$sum" "$tmp" | sha256sum -c --status || exit 67',
    'chown root:root -- "$tmp"',
    'chmod "$mode" -- "$tmp"',
    // -T: a directory at the destination fails instead of receiving the file.
    // Flush the data before the rename, so a crash cannot leave the new name
    // pointing at an empty file on filesystems without rename ordering.
    'sync -- "$tmp"',
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
