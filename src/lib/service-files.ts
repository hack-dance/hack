import { realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, resolve, sep } from "node:path";
import { HackCliError, type HackErrorCode } from "./cli-result.ts";
import { containerOwnership } from "./compose-instance-stop.ts";
import { dockerUnixHostPath } from "./docker-context.ts";
import { dockerHelperRunEnvironment } from "./docker-helper-environment.ts";
import { getString, isRecord } from "./guards.ts";
import type { ProjectContext } from "./project.ts";
import { EXEC_STDOUT_OVERFLOW_EXIT, exec } from "./shell.ts";

const PREVIEW_BYTES = 64 * 1024;
const DIRECTORY_ENTRIES = 2000;
const OUTPUT_BYTES = 2 * 1024 * 1024;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const ANONYMOUS_VOLUME_NAME = /^[a-f0-9]{64}$/;
const COMPOSE_LABEL = "com.docker.compose";
// A full inspect includes container env values. Select only fields for this read.
const INSPECT = `{"id":{{json .Id}},"state":{{json .State.Status}},"service":{{json (index .Config.Labels "${COMPOSE_LABEL}.service")}},"project":{{json (index .Config.Labels "${COMPOSE_LABEL}.project")}},"number":{{json (index .Config.Labels "${COMPOSE_LABEL}.container-number")}},"oneOff":{{json (index .Config.Labels "${COMPOSE_LABEL}.oneoff")}},"workingDir":{{json (index .Config.Labels "${COMPOSE_LABEL}.project.working_dir")}},"mounts":{{json .Mounts}},"binds":{{json .HostConfig.Binds}},"configured":{{json .HostConfig.Mounts}},"tmpfs":{{json .HostConfig.Tmpfs}}}`;
// Modern engines label anonymous volumes, including ones inherited via volumes_from.
const VOLUME =
  '{"name":{{json .Name}},"anonymous":"{{range $key, $_ := .Labels}}{{if eq $key "com.docker.volume.anonymous"}}yes{{end}}{{end}}"}';
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

type DockerRead = (argv: readonly string[]) => ReturnType<typeof exec>;

function dockerReader(opts: {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly unsetEnvKeys?: readonly string[];
}): DockerRead {
  return async (argv) => {
    try {
      return await exec(["docker", ...argv], {
        cwd: opts.cwd,
        env: { ...opts.env },
        unsetEnvKeys: opts.unsetEnvKeys,
        timeoutMs: 6000,
        maxStdoutBytes: OUTPUT_BYTES,
        maxStderrBytes: 16 * 1024,
        forwardSignals: true,
      });
    } catch {
      return fail("E_DOCKER_UNAVAILABLE", "Could not connect to Docker.");
    }
  };
}

function lines(output: string): string[] {
  return output.trim().split("\n").filter(Boolean);
}

function parseRecord(line: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return invalid();
  }
  return isRecord(raw) ? raw : invalid();
}

function ownedReplica(opts: {
  readonly raw: Record<string, unknown>;
  readonly ids: ReadonlySet<string>;
  readonly projectDir: string;
  readonly service: string;
  readonly expectedProject?: string;
}) {
  const { raw, ids, projectDir, service } = opts;
  const id = getString(raw, "id");
  if (!(id && ids.has(id))) {
    return invalid();
  }
  const workingDir = getString(raw, "workingDir");
  const replica = Number(raw.number);
  if (
    raw.service !== service ||
    (opts.expectedProject !== undefined &&
      raw.project !== opts.expectedProject) ||
    raw.state !== "running" ||
    raw.oneOff !== "False" ||
    !(workingDir && isAbsolute(workingDir)) ||
    !Number.isSafeInteger(replica) ||
    replica < 1 ||
    containerOwnership({
      container: { id, service, state: "running", workingDir },
      projectDir,
    }) !== "owned"
  ) {
    return null;
  }
  return { id, replica, raw };
}

async function runningReplica(opts: {
  readonly compose: DockerRead;
  readonly docker: DockerRead;
  readonly composeArgs: readonly string[];
  readonly service: string;
  readonly projectDir: string;
  readonly expectedProject?: string;
}) {
  // Compose resolves the base name, including COMPOSE_PROJECT_NAME in its env
  // or .env, with the same project directory and branch -p as up/exec.
  const listed = await opts.compose([
    ...opts.composeArgs,
    "ps",
    "--quiet",
    "--no-trunc",
    "--status",
    "running",
    "--orphans=false",
    opts.service,
  ]);
  if (listed.exitCode !== 0) {
    return fail(
      "E_COMPOSE_FAILED",
      "Could not read running Compose services. Check the Compose configuration and Docker connection."
    );
  }
  const ids = new Set(lines(listed.stdout));
  if (ids.size === 0) {
    return noOwnedReplica();
  }
  if (![...ids].every((id) => CONTAINER_ID.test(id))) {
    return invalid();
  }
  const inspected = await opts.docker([
    "inspect",
    "--type",
    "container",
    "--format",
    INSPECT,
    ...ids,
  ]);
  if (inspected.exitCode !== 0) {
    return fail(
      "E_COMPOSE_FAILED",
      "Could not inspect the running service. Refresh and try again."
    );
  }
  const replicas = lines(decode(Buffer.from(inspected.stdout, "latin1")))
    .map((line) => ownedReplica({ ...opts, ids, raw: parseRecord(line) }))
    .filter((replica) => replica !== null);
  // Multiple checkouts can use the same Compose name on the same engine.
  // Apply the checkout ownership check before choosing the lowest replica.
  replicas.sort((a, b) => a.replica - b.replica || a.id.localeCompare(b.id));
  return replicas[0] ?? noOwnedReplica();
}

function noOwnedReplica(): never {
  return fail(
    "E_SERVICE_NOT_FOUND",
    "No running container for this Compose service in the selected checkout."
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

function explicitlyNamedVolume(
  raw: Record<string, unknown>,
  name: string
): boolean {
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

async function inspectVolumes(
  docker: DockerRead,
  mounts: readonly unknown[]
): Promise<Map<string, boolean>> {
  const names = new Set<string>();
  for (const mount of mounts) {
    if (isRecord(mount) && mount.Type === "volume") {
      const name = getString(mount, "Name");
      if (name) {
        names.add(name);
      }
    }
  }
  if (names.size === 0) {
    return new Map();
  }
  const result = await docker([
    "volume",
    "inspect",
    "--format",
    VOLUME,
    "--",
    ...names,
  ]);
  if (result.exitCode !== 0) {
    return fail(
      "E_COMPOSE_FAILED",
      "Could not determine the service's volume sources. Refresh and try again."
    );
  }
  const volumes = new Map<string, boolean>();
  for (const line of lines(decode(Buffer.from(result.stdout, "latin1")))) {
    const row = parseRecord(line);
    const name = getString(row, "name");
    if (
      !(
        name &&
        names.has(name) &&
        !volumes.has(name) &&
        (row.anonymous === "" || row.anonymous === "yes")
      )
    ) {
      return invalid();
    }
    volumes.set(name, row.anonymous === "yes");
  }
  return volumes.size === names.size ? volumes : invalid();
}

async function classifyMount(opts: {
  readonly raw: Record<string, unknown>;
  readonly mount: unknown;
  readonly root: string | null;
  readonly volumes: ReadonlyMap<string, boolean>;
}): Promise<Mount> {
  const { raw, mount, root, volumes } = opts;
  if (!isRecord(mount)) {
    return invalid();
  }
  const destination = getString(mount, "Destination");
  if (!(destination && posix.isAbsolute(destination))) {
    return invalid();
  }
  const name = getString(mount, "Name");
  // Older Docker can omit the anonymous label. Its default IDs are 64 hex
  // characters; explicitly named mounts still disambiguate such names.
  if (
    mount.Type === "volume" &&
    name &&
    volumes.get(name) === false &&
    (!ANONYMOUS_VOLUME_NAME.test(name) || explicitlyNamedVolume(raw, name))
  ) {
    return { destination, source: "volume", hostRoot: null };
  }
  const source = getString(mount, "Source");
  if (root !== null && mount.Type === "bind" && source) {
    const hostRoot = await realpath(hostBindPath(source)).catch(() => null);
    if (hostRoot && within(root, hostRoot)) {
      return { destination, source: "worktree", hostRoot };
    }
  }
  return { destination, source: "container", hostRoot: null };
}

async function localMountRoot(opts: {
  readonly docker: DockerRead;
  readonly mounts: readonly unknown[];
  readonly projectRoot: string;
}): Promise<string | null> {
  if (!opts.mounts.some((mount) => isRecord(mount) && mount.Type === "bind")) {
    return null;
  }
  // A daemon reached over SSH or TCP can expose a bind with exactly the
  // same path as a local file. Its pathname is evidence only on that daemon.
  const endpoint = await opts.docker([
    "context",
    "inspect",
    "--format",
    '{{(index .Endpoints "docker").Host}}',
  ]);
  const host = decode(Buffer.from(endpoint.stdout, "latin1")).trim();
  return endpoint.exitCode === 0 && dockerUnixHostPath(host) !== null
    ? await realpath(opts.projectRoot)
    : null;
}

async function readMounts(opts: {
  readonly raw: Record<string, unknown>;
  readonly projectRoot: string;
  readonly docker: DockerRead;
}): Promise<Mount[]> {
  const { raw, projectRoot, docker } = opts;
  if (!(raw.mounts === null || Array.isArray(raw.mounts))) {
    return invalid();
  }
  const mounts: readonly unknown[] = raw.mounts ?? [];
  const [root, volumes] = await Promise.all([
    localMountRoot({ docker, mounts, projectRoot }),
    inspectVolumes(docker, mounts),
  ]);
  const actual = await Promise.all(
    mounts.map((mount) => classifyMount({ raw, mount, root, volumes }))
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
  readonly project: Pick<ProjectContext, "projectRoot" | "projectDir">;
  readonly composeArgs: readonly string[];
  readonly expectedProject?: string;
  readonly env: Readonly<Record<string, string>>;
  readonly service: string;
  readonly path: string;
}): Promise<FilesResult> {
  const cwd = opts.project.projectDir;
  const compose = dockerReader({ cwd, env: opts.env });
  // Direct Docker reads need the same client/engine, without forwarding
  // application interpolation values outside Compose.
  const docker = dockerReader({ cwd, ...dockerHelperRunEnvironment(opts.env) });
  const { id, raw } = await runningReplica({
    compose,
    docker,
    composeArgs: opts.composeArgs.slice(1),
    service: opts.service,
    projectDir: cwd,
    expectedProject: opts.expectedProject,
  });
  const mounts = await readMounts({
    raw,
    projectRoot: opts.project.projectRoot,
    docker,
  });
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
