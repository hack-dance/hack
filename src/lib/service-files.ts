import { realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { HackCliError, type HackErrorCode } from "./cli-result.ts";
import { getString, isRecord } from "./guards.ts";
import { EXEC_STDOUT_OVERFLOW_EXIT, exec } from "./shell.ts";

const PREVIEW_BYTES = 64 * 1024;
const DIRECTORY_ENTRIES = 2000;
const OUTPUT_BYTES = 2 * 1024 * 1024;
const REPLICA = /^([a-f0-9]{64}) (\d+)$/;
const COMPOSE_LABEL = "com.docker.compose";
// Read only the mount and replica data. A full inspect includes container env values.
const INSPECT =
  '{"mounts":{{json .Mounts}},"binds":{{json .HostConfig.Binds}},"configured":{{json .HostConfig.Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}}}';
const CONTAINER_TIMEOUT_SECONDS = 4;

// Paths are passed as argv, and NUL framing preserves spaces, tabs and newlines.
// Resolve symlinks in the container namespace before classifying the target.
const READ_FILES = `
set -eu
export LC_ALL=C
path=$(readlink -f -- "$1" && printf .) || exit 66
path=\${path%??}
metadata() {
  stat -c '%f:%s:%Y' -- "$1" || exit 66
}
info=$(metadata "$path") || exit 66
printf '%s\\0%s\\0' "$path" "$info"
if [ "$2" = cat ]; then
  [ -f "$path" ] || exit 65
  exec head -c ${PREVIEW_BYTES + 1} -- "$path"
fi
if [ -d "$path" ]; then
  [ -r "$path" ] && [ -x "$path" ] || exit 77
  count=0
  for entry in "\${path%/}"/* "\${path%/}"/.[!.]* "\${path%/}"/..?*; do
    [ -e "$entry" ] || [ -L "$entry" ] || continue
    count=$((count + 1))
    [ "$count" -le ${DIRECTORY_ENTRIES} ] || exit 75
    info=$(metadata "$entry") || exit 66
    printf '%s\\0%s\\0' "$entry" "$info"
  done
fi
`;

type FileKind = "directory" | "file" | "symlink" | "other";
type FileSource = "worktree" | "container" | "volume";

interface Entry {
  readonly name: string;
  readonly path: string;
  readonly kind: FileKind;
  readonly source: FileSource;
  readonly hostPath: string | null;
  readonly sizeBytes: number | null;
  readonly modifiedAtMs: number;
}

interface Mount {
  readonly destination: string;
  readonly source: FileSource;
  readonly hostRoot: string | null;
}

type FilesResult =
  | {
      readonly operation: "ls";
      readonly entry: Entry;
      readonly entries: readonly Entry[];
    }
  | {
      readonly operation: "cat";
      readonly entry: Entry;
      readonly encoding: "utf8" | "base64";
      readonly content: string;
      readonly truncated: boolean;
    };

function fail(code: HackErrorCode, message: string): never {
  throw new HackCliError({ code, message });
}

function invalid(): never {
  return fail(
    "E_COMPOSE_OUTPUT_INVALID",
    "The service returned invalid or non-UTF-8 file metadata."
  );
}

async function docker(argv: readonly string[], maxStdoutBytes = OUTPUT_BYTES) {
  try {
    return await exec(["docker", ...argv], {
      timeoutMs: 6000,
      maxStdoutBytes,
      maxStderrBytes: 16 * 1024,
      forwardSignals: true,
    });
  } catch {
    return fail("E_DOCKER_UNAVAILABLE", "Could not connect to Docker.");
  }
}

async function runningReplica(
  composeProject: string,
  service: string
): Promise<string> {
  const result = await docker([
    "ps",
    "--no-trunc",
    "--filter",
    "status=running",
    "--filter",
    `label=${COMPOSE_LABEL}.project=${composeProject}`,
    "--filter",
    `label=${COMPOSE_LABEL}.service=${service}`,
    "--filter",
    `label=${COMPOSE_LABEL}.oneoff=False`,
    "--format",
    `{{.ID}} {{.Label "${COMPOSE_LABEL}.container-number"}}`,
  ]);
  if (result.exitCode !== 0) {
    return fail(
      "E_DOCKER_UNAVAILABLE",
      "Could not read running Compose services from Docker."
    );
  }
  let selected: { id: string; replica: number } | undefined;
  for (const line of result.stdout.trim().split("\n").filter(Boolean)) {
    const match = REPLICA.exec(line.trim());
    const id = match?.[1];
    const replica = Number(match?.[2]);
    if (!(id && Number.isSafeInteger(replica) && replica > 0)) {
      return invalid();
    }
    if (
      !selected ||
      replica < selected.replica ||
      (replica === selected.replica && id < selected.id)
    ) {
      selected = { id, replica };
    }
  }
  return (
    selected?.id ??
    fail(
      "E_SERVICE_NOT_FOUND",
      "No running container for this Compose service."
    )
  );
}

function within(root: string, value: string): boolean {
  const suffix = relative(root, value);
  return (
    suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
  );
}

function hostBindPath(source: string): string {
  // Docker Desktop's VM may report the path through its host sharing mount.
  for (const prefix of ["/run/desktop/mnt/host", "/host_mnt"]) {
    if (source.startsWith(`${prefix}/`)) {
      return source.slice(prefix.length);
    }
  }
  return source;
}

function namedVolume(raw: Record<string, unknown>, name: string): boolean {
  const configured = Array.isArray(raw.configured) ? raw.configured : [];
  const binds = Array.isArray(raw.binds) ? raw.binds : [];
  return (
    configured.some(
      (mount: unknown) =>
        isRecord(mount) && mount.Type === "volume" && mount.Source === name
    ) ||
    binds.some(
      (bind: unknown) => typeof bind === "string" && bind.startsWith(`${name}:`)
    )
  );
}

async function classifyMount(
  raw: Record<string, unknown>,
  mount: unknown,
  root: string
): Promise<Mount> {
  if (!isRecord(mount)) {
    return invalid();
  }
  const destination = getString(mount, "Destination");
  if (!(destination && posix.isAbsolute(destination))) {
    return invalid();
  }
  const name = getString(mount, "Name");
  if (mount.Type === "volume" && name && namedVolume(raw, name)) {
    return { destination, source: "volume", hostRoot: null };
  }
  const source = getString(mount, "Source");
  if (mount.Type === "bind" && source) {
    const hostRoot = await realpath(hostBindPath(source)).catch(() => null);
    if (hostRoot && within(root, hostRoot)) {
      return { destination, source: "worktree", hostRoot };
    }
  }
  return { destination, source: "container", hostRoot: null };
}

async function readMounts(id: string, projectRoot: string): Promise<Mount[]> {
  const out = await docker([
    "inspect",
    "--type",
    "container",
    "--format",
    INSPECT,
    id,
  ]);
  if (out.exitCode !== 0) {
    return fail(
      "E_COMPOSE_FAILED",
      "Could not inspect the service's mounts. Refresh the service and try again."
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decode(Buffer.from(out.stdout, "latin1")));
  } catch {
    return invalid();
  }
  if (!(isRecord(raw) && (raw.mounts === null || Array.isArray(raw.mounts)))) {
    return invalid();
  }
  const root = await realpath(projectRoot);
  const actual = await Promise.all(
    (raw.mounts ?? []).map((mount: unknown) => classifyMount(raw, mount, root))
  );
  for (const destination of Object.keys(isRecord(raw.tmpfs) ? raw.tmpfs : {})) {
    actual.push({ destination, source: "container", hostRoot: null });
  }
  // The deepest mount shadows its parent, even if it is not a worktree or named volume.
  return actual.sort((a, b) => b.destination.length - a.destination.length);
}

function mountFor(path: string, mounts: readonly Mount[]): Mount | undefined {
  return mounts.find(
    ({ destination }) =>
      path === destination ||
      path.startsWith(destination === "/" ? "/" : `${destination}/`)
  );
}

function kindFor(mode: number): FileKind {
  switch (mode & 0xf0_00) {
    case 0x40_00:
      return "directory";
    case 0x80_00:
      return "file";
    case 0xa0_00:
      return "symlink";
    default:
      return "other";
  }
}

function entryFrom(
  path: string,
  metadata: string,
  mounts: readonly Mount[]
): Entry {
  const [modeText, sizeText, modifiedText] = metadata.split(":");
  const mode = Number.parseInt(modeText ?? "", 16);
  const size = Number(sizeText);
  const modifiedAtMs = Number(modifiedText) * 1000;
  if (
    !(
      posix.isAbsolute(path) &&
      posix.normalize(path) === path &&
      Number.isSafeInteger(mode) &&
      Number.isSafeInteger(size) &&
      size >= 0 &&
      Number.isSafeInteger(modifiedAtMs)
    )
  ) {
    return invalid();
  }
  const kind = kindFor(mode);
  const mount = mountFor(path, mounts);
  return {
    name: posix.basename(path) || "/",
    path,
    kind,
    source: mount?.source ?? "container",
    hostPath: mount?.hostRoot
      ? resolve(mount.hostRoot, posix.relative(mount.destination, path))
      : null,
    sizeBytes: kind === "file" ? size : null,
    modifiedAtMs,
  };
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes
    );
  } catch {
    return invalid();
  }
}

function listEntries(output: Buffer, mounts: readonly Mount[]): Entry[] {
  const entries: Entry[] = [];
  let start = 0;
  while (start < output.length) {
    const separator = output.indexOf(0, start);
    const end = separator < 0 ? -1 : output.indexOf(0, separator + 1);
    if (end < 0) {
      return invalid();
    }
    entries.push(
      entryFrom(
        decode(output.subarray(start, separator)),
        decode(output.subarray(separator + 1, end)),
        mounts
      )
    );
    start = end + 1;
  }
  return entries;
}

function preview(
  bytes: Buffer
): Omit<Extract<FilesResult, { operation: "cat" }>, "operation" | "entry"> {
  const truncated = bytes.length > PREVIEW_BYTES;
  const content = bytes.subarray(0, PREVIEW_BYTES);
  if (!content.includes(0)) {
    try {
      return {
        encoding: "utf8",
        content: new TextDecoder("utf-8", {
          fatal: true,
          ignoreBOM: true,
        }).decode(content, { stream: truncated }),
        truncated,
      };
    } catch {
      // Invalid UTF-8 is delivered byte-for-byte below.
    }
  }
  return { encoding: "base64", content: content.toString("base64"), truncated };
}

function requireReadSuccess(code: number): undefined {
  switch (code) {
    case 0:
      return;
    case 65:
      return fail("E_USAGE", "Only regular files can be read.");
    case 66:
      return fail(
        "E_COMPOSE_FAILED",
        "The container path could not be found or read."
      );
    case 77:
      return fail("E_PERMISSION", "The service cannot read this directory.");
    case 75:
    case EXEC_STDOUT_OVERFLOW_EXIT:
      return fail(
        "E_COMPOSE_FAILED",
        "The directory listing exceeds the file browser's limits."
      );
    default:
      return fail(
        "E_COMPOSE_FAILED",
        "Could not read the service files. Check that the container is running and has sh, readlink, stat, timeout and head."
      );
  }
}

/** Read the selected running replica by ID so the mount inventory and read use the same container. */
export async function readServiceFiles(opts: {
  readonly operation: "ls" | "cat";
  readonly root: string;
  readonly composeProject: string;
  readonly service: string;
  readonly path: string;
}): Promise<FilesResult> {
  const id = await runningReplica(opts.composeProject, opts.service);
  const mounts = await readMounts(id, opts.root);
  const result = await docker([
    "exec",
    id,
    "timeout",
    "-k",
    "1",
    String(CONTAINER_TIMEOUT_SECONDS),
    "sh",
    "-c",
    READ_FILES,
    "hack-files",
    opts.path,
    opts.operation,
  ]);
  requireReadSuccess(result.exitCode);
  const output = Buffer.from(result.stdout, "latin1");
  const separator = output.indexOf(0);
  const end = separator < 0 ? -1 : output.indexOf(0, separator + 1);
  if (end < 0) {
    return invalid();
  }
  const entry =
    listEntries(output.subarray(0, end + 1), mounts)[0] ?? invalid();
  const rest = output.subarray(end + 1);
  if (opts.operation === "cat") {
    return { operation: "cat", entry, ...preview(rest) };
  }
  const entries =
    entry.kind === "directory" ? listEntries(rest, mounts) : [entry];
  return {
    operation: "ls",
    entry,
    entries: entries.sort((a, b) => a.name.localeCompare(b.name)),
  };
}
