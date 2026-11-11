#!/usr/bin/env bun
/**
 * Native provider pin qualification on an Apple Silicon Mac.
 *
 * Runs one bundle (its `hack-v5` and adjacent `hack-native`) against the SmolVM, Docker
 * engine and network-tool inputs its `provider-pins.json` names, inside one private root,
 * and checks in order:
 *
 *   1. archive: the SmolVM archive SHA-256 matches the bundle's pin (and upstream's
 *      `checksums.sha256` when given), the archive's own `checksums.txt` matches its files,
 *      and `smolvm-bin` passes `codesign --verify --strict`.
 *   2. prepare: `runtime prepare`, `prepare-engine`, `prepare-network-tools` and `probe`,
 *      plus a prepared base built and verified in the second home (network tools and the
 *      overlay inventory under the pinned guest).
 *   3. templates: the first start expands both disk templates at their logical sizes; their
 *      content digests (the runtime's own definition) are printed and compared with the
 *      repository pins when this checkout pins the same archive.
 *   4. disk identity: both machine disks have exactly the profile size, the provider runs
 *      with `SMOLVM_DISK_TRIM=0`, and the identity and size survive writes and deletes.
 *   5. lifecycle: `hack up`, `restart`, `down`, `down --recover` after a lost foreground,
 *      and recovery after the provider VM process is killed (an unclean stop).
 *   6. network modes (second home): approved hosts, extended hosts and internet, each
 *      read back from the provider's stored machine record and running configuration.
 *   7. `--mount-socket`: a host dependency listener relayed into a container through the
 *      pool's dependency sockets (framed relay), 64 KiB each way, before and after restart.
 *   8. Rosetta (second home): `runtime up --amd64-emulation`, read back as recorded.
 *   9. web plus database: service DNS, a database write that survives down, up, restart and
 *      an unclean stop.
 *  10. measurements: prepare time, cold and warm `up` to ready, `restart`, `down`, VM plus
 *      helper physical footprint at idle after 0, 3 and 10 minutes (3 is past the 2-minute
 *      reclaim pulse), and idle CPU.
 *
 * Preview-first: without --run it prints the plan and changes nothing. It never uses
 * sudo, never reads or writes the real home (every child gets a HOME, XDG directories,
 * HACK_HOME and HACK_NATIVE_HOME inside the root), keeps Docker clients pointed at a dead
 * socket, and disables daemon autostart. The provider itself uses the short
 * `/private/tmp/hkl-*` alias the runtime creates for every pool.
 *
 * The first failed check prints one `FAIL <step>: <check>: <detail>` line, writes
 * evidence/failure.json and exits 1. Nothing is stopped or removed after a failure, so
 * the state can be inspected; the line names the command that stops each pool. The only
 * processes it signals are its own children and, in step 5, the provider VM process of
 * its own pool, which it identifies by the pool receipt and the executable path under the
 * root before sending SIGKILL.
 */
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const GIB = 1024 * 1024 * 1024;

/** Disk sizes the runtime declares per profile (`provider::Profile`). */
export const PROFILE_DISKS = {
  development: { storage: 32 * GIB, overlay: 10 * GIB },
  research: { storage: 4 * GIB, overlay: 4 * GIB },
} as const;

/** Logical sizes of the expanded SmolVM disk templates. */
export const TEMPLATE_LENGTHS = {
  "storage-template.ext4": 21_474_836_480,
  "overlay-template.ext4": 10_737_418_240,
} as const;

/**
 * Machine-record fields (SmolVM 1.34.1 `VmRecord`) that must stay inert. Kept equal to
 * `INERT_RECORD_FIELDS` in `packages/runtime-core/src/provider/config_audit.rs`; a test
 * compares the two lists.
 */
export const INERT_RECORD_FIELDS = [
  "pause_reason",
  "paused_checkpoint",
  "disks",
  "cache_disk",
  "disk_volumes",
  "block_private",
  "staged_mounts_detached_from",
  "udp_ports",
  "nested_virt",
  "egress_rules",
  "dns_options",
  "shm_size",
  "guest_subnet",
  "detached",
  "keep_identity",
  "stop_on_exit",
  "stop_signal",
  "stop_timeout_secs",
  "credential_policy",
  "external_interceptor_required",
  "mediated_egress_required",
  "credential_placeholders",
  "credentials_supplied_by_api",
  "packed_image_on_storage",
  "source_registry_ref",
  "image_origin",
  "image_origin_digest",
  "checkpoint_head",
  "host_uid_owner",
] as const;

/** Running-configuration resource fields that must stay inert (`INERT_RUNNING_RESOURCES`). */
export const INERT_RUNNING_RESOURCES = [
  "nested_virt",
  "disks",
  "cache_disk",
  "disk_volumes",
  "block_private",
  "egress_rules",
  "dns_options",
  "shm_size",
  "guest_subnet",
] as const;

/** The runtime's inert rule: absent, null, false, or empty; `block_private` only absent or null. */
export function inertField(field: string, value: unknown): boolean {
  if (field === "block_private") {
    return value === undefined || value === null;
  }
  if (value === undefined || value === null || value === false) {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === "object") {
    return Object.keys(value).length === 0;
  }
  return false;
}

/** Fields of a stored record or running resources that are not inert, by the runtime's rule. */
export function activeFields(
  value: Record<string, unknown>,
  fields: readonly string[]
): string[] {
  return fields.filter((field) => !inertField(field, value[field]));
}

const DIGEST_DOMAIN = Buffer.from("hack.disk-template.content.v1\0");
const BLOCK = 4096;

function le64(value: number): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
}

/**
 * `disk_template::content_digest` over a whole file: SHA-256 of the domain, block size and
 * logical length, then each non-zero 4 KiB block as its index and bytes. Holes and zero
 * blocks are elided, so the value does not depend on sparseness.
 */
export function contentDigest(path: string): {
  sha256: string;
  length: number;
} {
  const descriptor = openSync(path, "r");
  try {
    const length = fstatSync(descriptor).size;
    const hash = createHash("sha256");
    hash.update(DIGEST_DOMAIN);
    hash.update(le64(BLOCK));
    hash.update(le64(length));
    const chunk = Buffer.alloc(16 * 1024 * 1024);
    const zero = Buffer.alloc(BLOCK);
    let offset = 0;
    while (offset < length) {
      // Fill the chunk completely so block indices stay aligned across short reads.
      const wanted = Math.min(chunk.length, length - offset);
      let read = 0;
      while (read < wanted) {
        const got = readSync(
          descriptor,
          chunk,
          read,
          wanted - read,
          offset + read
        );
        if (got <= 0) {
          throw new Error(`short read at ${offset + read} in ${path}`);
        }
        read += got;
      }
      for (let start = 0; start < read; start += BLOCK) {
        const end = Math.min(start + BLOCK, read);
        const size = end - start;
        if (chunk.compare(zero, 0, size, start, end) !== 0) {
          hash.update(le64((offset + start) / BLOCK));
          hash.update(chunk.subarray(start, end));
        }
      }
      offset += read;
    }
    return { sha256: hash.digest("hex"), length };
  } finally {
    closeSync(descriptor);
  }
}

/** Pinned template digests from the runtime source, with the archive they were derived from. */
export function sourceTemplatePins(
  source: string
): { archive: string; templates: Record<string, string> } | null {
  const archive =
    /"([0-9a-f]{64})",\s*super::super::artifact::ARCHIVE_SHA256/.exec(
      source
    )?.[1];
  const templates: Record<string, string> = {};
  for (const match of source.matchAll(
    /name:\s*"([a-z-]+-template\.ext4)",\s*logical_len:\s*[0-9_]+,\s*content_sha256:\s*"([0-9a-f]{64})"/g
  )) {
    templates[match[1] as string] = match[2] as string;
  }
  if (!archive || Object.keys(templates).length !== 2) {
    return null;
  }
  return { archive, templates };
}

/** `footprint` reports physical footprint as `Footprint: <n> <unit>`; returns bytes. */
export function parseFootprint(text: string): number | null {
  const match = /Footprint:\s*([0-9]+(?:\.[0-9]+)?)\s*(B|KB|MB|GB)\b/.exec(
    text
  );
  if (!match) {
    return null;
  }
  const scale = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[
    match[2] as "B" | "KB" | "MB" | "GB"
  ];
  return Math.round(Number(match[1]) * scale);
}

/** `top -l 1 -pid <pid> -stats pid,mem`: the MEM column (physical footprint) in bytes. */
export function parseTopMemory(text: string, pid: number): number | null {
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+([0-9]+(?:\.[0-9]+)?)([BKMG])\+?-?\s*$/.exec(
      line
    );
    if (match && Number(match[1]) === pid) {
      const scale = { B: 1, K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[
        match[3] as "B" | "K" | "M" | "G"
      ];
      return Math.round(Number(match[2]) * scale);
    }
  }
  return null;
}

/** `ps -o time=` CPU time (`[[dd-]hh:]mm:ss[.cc]`) in seconds. */
export function parseCpuTime(text: string): number | null {
  const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(
    text
  );
  if (!match) {
    return null;
  }
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86_400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
}

/** One `ps -A -o pid=,ppid=,rss=,time=,command=` row. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  rssKib: number;
  cpuSeconds: number;
  command: string;
}

export function parseProcessRows(text: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    const cpu = match ? parseCpuTime(match[4] as string) : null;
    if (match && cpu !== null) {
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        rssKib: Number(match[3]),
        cpuSeconds: cpu,
        command: match[5] as string,
      });
    }
  }
  return rows;
}

/** Provider processes of one candidate home: executables under its prepared provider tree. */
export function providerProcesses(
  rows: ProcessRow[],
  providers: string
): ProcessRow[] {
  const prefix = `${providers}/smolvm-`;
  return rows.filter((row) => row.command.startsWith(prefix));
}

export interface Options {
  hack: string;
  native: string;
  bundle: string;
  root: string;
  providerArchive: string;
  engineArchive: string;
  networkTools: string;
  webImage: string;
  dbImage: string;
  upstreamChecksums: string | null;
  approvedHosts: [string, string];
  amd64Image: string | null;
  idleMinutes: number[];
  skipIdle: boolean;
  caddy: string | null;
  httpsPort: number | null;
  run: boolean;
}

const USAGE = `Usage: bun scripts/qualify-provider-pin.ts --hack /abs/bundle/hack-v5 --home /abs/empty-private-root \\
  --provider-archive /abs/smolvm-<v>-darwin-arm64.tar.gz --engine-archive /abs/docker-<v>.tgz \\
  --network-tools /abs/private-apk-dir --web-image busybox@sha256:... --db-image postgres@sha256:... \\
  [--upstream-checksums /abs/checksums.sha256] [--approved-host example.com --approved-host example.org] \\
  [--amd64-image repo@sha256:...] [--idle-minutes 0,3,10 | --skip-idle] \\
  [--caddy /abs/caddy --https-port 8443] [--run]`;

/** Parse and validate arguments; throws with a usage line on any problem. */
export function parseOptions(argv: string[]): Options {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index] as string;
    if (name === "--run" || name === "--skip-idle") {
      flags.add(name);
      continue;
    }
    const value = argv[index + 1];
    if (
      !name.startsWith("--") ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(`Unexpected argument ${name}.\n${USAGE}`);
    }
    values.set(name, [...(values.get(name) ?? []), value]);
    index++;
  }
  const one = (name: string, required = true): string | null => {
    const list = values.get(name) ?? [];
    if (list.length > 1 || (required && list.length === 0)) {
      throw new Error(`${name} must be given exactly once.\n${USAGE}`);
    }
    return list[0] ?? null;
  };
  const absolute = (name: string, required = true): string | null => {
    const value = one(name, required);
    if (value !== null && !isAbsolute(value)) {
      throw new Error(`${name} must be an absolute path.`);
    }
    return value;
  };
  const pinned = (name: string, required = true): string | null => {
    const value = one(name, required);
    if (value !== null && !/@sha256:[0-9a-f]{64}$/.test(value)) {
      throw new Error(
        `${name} must be pinned by digest (repository@sha256:...).`
      );
    }
    return value;
  };
  const hack = absolute("--hack") as string;
  const hosts = values.get("--approved-host") ?? ["example.com", "example.org"];
  if (
    hosts.length !== 2 ||
    hosts.some((host) => !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host))
  ) {
    throw new Error(
      "--approved-host must be given twice (or not at all) as DNS names."
    );
  }
  const idle = (one("--idle-minutes", false) ?? "0,3,10")
    .split(",")
    .map(Number);
  if (
    idle.length === 0 ||
    idle.some(
      (minute) => !Number.isInteger(minute) || minute < 0 || minute > 60
    ) ||
    idle.some(
      (minute, index) => index > 0 && minute <= (idle[index - 1] as number)
    )
  ) {
    throw new Error(
      "--idle-minutes must be increasing whole minutes from 0 to 60."
    );
  }
  const caddy = absolute("--caddy", false);
  const portText = one("--https-port", false);
  const httpsPort = portText === null ? null : Number(portText);
  if ((caddy === null) !== (httpsPort === null)) {
    throw new Error("--caddy and --https-port go together.");
  }
  if (
    httpsPort !== null &&
    !(Number.isInteger(httpsPort) && httpsPort >= 1024 && httpsPort <= 65_535)
  ) {
    throw new Error("--https-port must be an unprivileged port.");
  }
  return {
    hack,
    bundle: dirname(hack),
    native: join(dirname(hack), "hack-native"),
    root: absolute("--home") as string,
    providerArchive: absolute("--provider-archive") as string,
    engineArchive: absolute("--engine-archive") as string,
    networkTools: absolute("--network-tools") as string,
    webImage: pinned("--web-image") as string,
    dbImage: pinned("--db-image") as string,
    upstreamChecksums: absolute("--upstream-checksums", false),
    approvedHosts: [hosts[0] as string, hosts[1] as string],
    amd64Image: pinned("--amd64-image", false),
    idleMinutes: flags.has("--skip-idle") ? [] : idle,
    skipIdle: flags.has("--skip-idle"),
    caddy,
    httpsPort,
    run: flags.has("--run"),
  };
}

export function compose(
  webImage: string,
  dbImage: string,
  alias: string
): string {
  return `services:
  web:
    image: ${webImage}
    command: ["sh", "-c", "mkdir -p /srv && echo ready > /srv/index.txt && exec httpd -f -p 8080 -h /srv"]
    extra_hosts:
      - "${alias}:host-gateway"
    healthcheck:
      x-hack-http: {port: 8080, path: /index.txt, interval_ms: 1000, timeout_ms: 2000, retries: 60, start_period_ms: 1000}
  db:
    image: ${dbImage}
    environment:
      POSTGRES_PASSWORD: qualification
    volumes:
      - "db-data:/var/lib/postgresql/data"
volumes:
  db-data: {}
`;
}

/** The host dependency listener: 64 KiB of fixed bytes out, the SHA-256 of what came in. */
export const DEPENDENCY_SERVER = `const body = new Uint8Array(65536).map((_, i) => i % 251);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.argv[2]),
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/blob") return new Response(body);
    if (url.pathname === "/echo") {
      const bytes = new Uint8Array(await request.arrayBuffer());
      const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      return new Response(digest + " " + bytes.length + "\\n");
    }
    return new Response("not found", { status: 404 });
  },
});
console.log(String(server.port));
`;

export const BLOB_SHA256 = createHash("sha256")
  .update(Uint8Array.from({ length: 65_536 }, (_, index) => index % 251))
  .digest("hex");

class Failure extends Error {}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
  seconds: number;
}

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** A candidate home's provider `$HOME` (the runtime's `run/smolvm/home`). */
const PROVIDER_HOME = join(".hack-local", "run", "smolvm", "home");

class Qualification {
  readonly evidence: string;
  readonly main: string;
  readonly aux: string;
  readonly project: string;
  readonly env: Record<string, string>;
  readonly measurements: Record<string, unknown> = {};
  readonly passed: string[] = [];
  step = "setup";
  pins: Record<string, Record<string, unknown>> = {};
  foreground: ReturnType<typeof Bun.spawn> | null = null;
  dependencyServer: ReturnType<typeof Bun.spawn> | null = null;
  dependencyPort = 0;
  sequence = 0;

  readonly options: Options;

  constructor(options: Options) {
    this.options = options;
    const root = options.root;
    this.evidence = join(root, "evidence");
    this.main = join(root, "candidate");
    this.aux = join(root, "candidate-network");
    this.project = join(root, "project");
    const user = join(root, "user-home");
    this.env = {
      PATH: SYSTEM_PATH,
      LANG: "C",
      LC_ALL: "C",
      HOME: user,
      XDG_CONFIG_HOME: join(user, ".config"),
      XDG_DATA_HOME: join(user, ".local/share"),
      XDG_STATE_HOME: join(user, ".local/state"),
      XDG_CACHE_HOME: join(user, ".cache"),
      TMPDIR: join(root, "tmp"),
      HACK_HOME: join(root, "cli-home"),
      HACK_NATIVE_HOME: this.main,
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_PREPARED_BASE: "off",
      HACK_NO_INTERACTIVE: "1",
      HACK_DAEMON_AUTOSTART_DISABLE: "1",
      HACK_LOGGER: "console",
      HACK_NATIVE_DEPENDENCIES: join(root, "fixtures", "dependencies.json"),
      DOCKER_HOST: `unix://${join(root, "no-docker.sock")}`,
    };
    if (options.caddy && options.httpsPort) {
      this.env.HACK_NATIVE_CADDY_BINARY = options.caddy;
      this.env.HACK_NATIVE_HTTPS_PORT = String(options.httpsPort);
    }
  }

  note(line: string): void {
    console.log(line);
  }

  check(name: string, ok: boolean, detail = ""): void {
    if (!ok) {
      throw new Failure(`${name}${detail ? `: ${detail}` : ""}`);
    }
    this.passed.push(`${this.step}: ${name}`);
    this.note(`PASS ${this.step}: ${name}`);
  }

  measure(name: string, value: unknown): void {
    this.measurements[name] = value;
    this.note(`MEASURE ${name} = ${JSON.stringify(value)}`);
  }

  label(name: string): string {
    this.sequence++;
    return `${String(this.sequence).padStart(3, "0")}-${name}`;
  }

  /** Run one bounded command; keep its output as evidence. */
  exec(
    name: string,
    argv: string[],
    options: { timeout?: number; cwd?: string; allowFailure?: boolean } = {}
  ): Result {
    const label = this.label(name);
    const started = performance.now();
    const child = Bun.spawnSync(argv, {
      cwd: options.cwd ?? this.options.root,
      env: this.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: (options.timeout ?? 180) * 1000,
    });
    const result: Result = {
      code: child.exitCode ?? -1,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
      seconds: (performance.now() - started) / 1000,
    };
    writeFileSync(
      join(this.evidence, `${label}.json`),
      JSON.stringify({ argv, ...result }, null, 2)
    );
    if (result.code !== 0 && !options.allowFailure) {
      throw new Failure(
        `${name} exited ${result.code}: ${(result.stderr || result.stdout).trim().slice(-600)}`
      );
    }
    return result;
  }

  json(
    name: string,
    argv: string[],
    options: { timeout?: number; cwd?: string } = {}
  ): Record<string, unknown> {
    const result = this.exec(name, argv, options);
    const value: unknown = JSON.parse(result.stdout);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Failure(`${name} did not print a JSON object`);
    }
    return value as Record<string, unknown>;
  }

  runtime(
    home: string,
    name: string,
    args: string[],
    timeout = 300
  ): Record<string, unknown> {
    return this.json(
      name,
      [this.options.native, "--candidate-root", home, ...args],
      { timeout }
    );
  }

  hack(
    name: string,
    args: string[],
    timeout = 180,
    allowFailure = false
  ): Result {
    return this.exec(name, [this.options.hack, ...args], {
      cwd: this.project,
      timeout,
      allowFailure,
    });
  }

  status(home: string): Record<string, unknown> {
    return this.runtime(
      home,
      "runtime-status",
      ["runtime", "status", "--json"],
      60
    );
  }

  owner(home: string): Record<string, unknown> {
    return JSON.parse(
      readFileSync(join(home, ".hack-local/run/smolvm/owner.json"), "utf8")
    );
  }

  /** The provider data directory of a home's pool, through its receipt's short HOME alias. */
  dataDirectory(home: string): string {
    const owner = this.owner(home);
    const machine = String(owner.machine);
    const hash = createHash("sha256")
      .update(machine)
      .digest("hex")
      .slice(0, 16);
    return join(String(owner.short_home), "Library/Caches/smolvm/vms", hash);
  }

  /**
   * The stored machine record through a read-only connection, as the runtime reads it. Not
   * `immutable`: the provider keeps the database in WAL mode, and an immutable open would
   * ignore committed changes still in the WAL. A read-only connection never checkpoints.
   */
  record(home: string): Record<string, unknown> {
    const database = join(
      home,
      PROVIDER_HOME,
      "Library/Application Support/smolvm/server/smolvm.db"
    );
    const result = this.exec("sqlite-record", [
      "/usr/bin/sqlite3",
      "-readonly",
      "-json",
      `file:${encodeURI(database)}?mode=ro`,
      "SELECT name, CAST(data AS TEXT) AS data FROM vms",
    ]);
    const rows = JSON.parse(result.stdout || "[]") as {
      name: string;
      data: string;
    }[];
    if (rows.length !== 1) {
      throw new Failure(
        `expected one stored machine record, found ${rows.length}`
      );
    }
    return JSON.parse((rows[0] as { data: string }).data);
  }

  runningConfig(home: string): Record<string, unknown> {
    return JSON.parse(
      readFileSync(join(this.dataDirectory(home), "agent.config.json"), "utf8")
    );
  }

  processes(home: string): ProcessRow[] {
    const listing = this.exec("ps", [
      "/bin/ps",
      "-A",
      "-ww",
      "-o",
      "pid=,ppid=,rss=,time=,command=",
    ]);
    return providerProcesses(
      parseProcessRows(listing.stdout),
      realpathSync(join(home, ".hack-local/providers"))
    );
  }

  // 1. Archive hash and signature.
  archive(): void {
    this.step = "1 archive";
    const pins = JSON.parse(
      readFileSync(join(this.options.bundle, "provider-pins.json"), "utf8")
    );
    this.pins = pins;
    const smolvm = pins.smolvm as Record<string, string>;
    const actual = sha256File(this.options.providerArchive);
    this.note(`INFO pinned SmolVM ${smolvm.version} ${smolvm.archive_sha256}`);
    this.check(
      "archive SHA-256 matches the bundle pin",
      actual === smolvm.archive_sha256,
      actual
    );
    this.check(
      "engine archive SHA-256 matches the bundle pin",
      sha256File(this.options.engineArchive) ===
        (pins.docker as Record<string, string>).archive_sha256
    );
    if (this.options.upstreamChecksums) {
      const name = String(smolvm.url).split("/").pop();
      const line = readFileSync(this.options.upstreamChecksums, "utf8")
        .split("\n")
        .find((row) => row.trim().endsWith(` ${name}`));
      this.check(
        "archive matches upstream checksums.sha256",
        line?.split(/\s+/)[0] === actual,
        line ?? "missing"
      );
    }
    const extract = join(this.options.root, "extract");
    mkdirSync(extract, { mode: 0o700 });
    this.exec("extract", [
      "/usr/bin/tar",
      "-xzf",
      this.options.providerArchive,
      "-C",
      extract,
    ]);
    const tree = join(extract, `smolvm-${smolvm.version}-darwin-arm64`);
    const listed = readFileSync(join(tree, "checksums.txt"), "utf8")
      .trim()
      .split("\n");
    const mismatched = listed.filter((row) => {
      const [hash, file] = row.split(/\s+/);
      return !file || sha256File(join(tree, file)) !== hash;
    });
    this.check(
      "archive checksums.txt matches its files",
      listed.length > 0 && mismatched.length === 0,
      mismatched.join("; ")
    );
    this.exec("codesign-verify", [
      "/usr/bin/codesign",
      "--verify",
      "--strict",
      "--verbose=2",
      join(tree, "smolvm-bin"),
    ]);
    const details = this.exec("codesign-details", [
      "/usr/bin/codesign",
      "-dv",
      "--verbose=2",
      join(tree, "smolvm-bin"),
    ]);
    const identity = (
      details.stderr.match(/^(Authority|TeamIdentifier|Identifier)=.*$/gm) ?? []
    ).join("; ");
    this.measure("smolvm_signature", identity);
    this.check("smolvm-bin passes codesign --verify --strict", true);
  }

  // 2. Prepare and probe both homes.
  prepare(): void {
    this.step = "2 prepare";
    for (const home of [this.main, this.aux]) {
      mkdirSync(home, { mode: 0o700 });
    }
    const started = performance.now();
    this.runtime(this.main, "prepare", [
      "runtime",
      "prepare",
      "--archive",
      this.options.providerArchive,
    ]);
    this.measure(
      "prepare_provider_seconds",
      round((performance.now() - started) / 1000)
    );
    this.runtime(this.main, "prepare-engine", [
      "runtime",
      "prepare-engine",
      "--archive",
      this.options.engineArchive,
    ]);
    this.runtime(this.main, "prepare-network-tools", [
      "runtime",
      "prepare-network-tools",
      "--directory",
      this.options.networkTools,
    ]);
    this.measure(
      "prepare_total_seconds",
      round((performance.now() - started) / 1000)
    );
    for (const [name, args] of [
      [
        "prepare",
        ["runtime", "prepare", "--archive", this.options.providerArchive],
      ],
      [
        "prepare-engine",
        ["runtime", "prepare-engine", "--archive", this.options.engineArchive],
      ],
      [
        "prepare-network-tools",
        [
          "runtime",
          "prepare-network-tools",
          "--directory",
          this.options.networkTools,
        ],
      ],
    ] as const) {
      this.runtime(this.aux, `aux-${name}`, [...args]);
    }
    const probe = this.runtime(this.main, "probe", [
      "runtime",
      "probe",
      "--profile",
      "development",
      "--json",
    ]);
    writeFileSync(
      join(this.evidence, "probe.json"),
      JSON.stringify(probe, null, 2)
    );
    this.check(
      "runtime probe answers for the development profile",
      typeof probe === "object"
    );
    // A prepared base boots a verifier pool, installs the network tools and checks the
    // overlay's upper-layer inventory, so it exercises the apk-tools 3 file set of the
    // pinned guest. It runs in the second home before that home's own pool exists.
    const store = join(this.options.root, "prepared-bases");
    mkdirSync(store, { mode: 0o700 });
    const buildStarted = performance.now();
    const built = this.runtime(
      this.aux,
      "prepared-base-build",
      [
        "runtime",
        "prepared-base",
        "build",
        "--profile",
        "research",
        "--store",
        store,
        "--json",
      ],
      900
    );
    const base = String(
      (built.receipt as Record<string, unknown> | undefined)?.base_id ?? ""
    );
    this.measure(
      "prepared_base_build_seconds",
      round((performance.now() - buildStarted) / 1000)
    );
    this.runtime(
      this.aux,
      "prepared-base-verify",
      [
        "runtime",
        "prepared-base",
        "verify",
        "--base-id",
        base,
        "--store",
        store,
        "--json",
      ],
      900
    );
    this.check(
      "a prepared base builds and verifies its upper-layer inventory",
      base.length > 0
    );
    this.runtime(this.aux, "prepared-base-remove", [
      "runtime",
      "prepared-base",
      "remove",
      "--base-id",
      base,
      "--store",
      store,
      "--json",
    ]);
    const templates = join(this.main, PROVIDER_HOME, ".smolvm");
    this.check(
      "no expanded template exists before the first start",
      !Object.keys(TEMPLATE_LENGTHS).some((name) =>
        existsSync(join(templates, name))
      )
    );
  }

  writeProject(): void {
    const fixtures = join(this.options.root, "fixtures");
    mkdirSync(fixtures, { mode: 0o700 });
    mkdirSync(join(this.project, ".hack"), { recursive: true, mode: 0o700 });
    const alias = "dependency.qualification.test";
    writeFileSync(
      join(this.project, ".hack/hack.config.json"),
      JSON.stringify({
        name: "provider-qual",
        dev_host: "provider-qual.hack.local",
      })
    );
    writeFileSync(
      join(this.project, ".hack/docker-compose.yml"),
      compose(this.options.webImage, this.options.dbImage, alias)
    );
    writeFileSync(
      join(this.project, "README.md"),
      "Provider pin qualification fixture.\n"
    );
    const git = (...args: string[]) =>
      this.exec(
        "git",
        [
          "/usr/bin/git",
          "-c",
          "init.templateDir=",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "user.name=Qualification",
          "-c",
          "user.email=qualification@example.invalid",
          ...args,
        ],
        { cwd: this.project }
      );
    git("init", "--quiet", "--initial-branch=main");
    git("add", ".");
    git("commit", "--quiet", "-m", "fixture");
    // The runtime refuses a share that other users can write.
    this.exec("chmod-project", ["/bin/chmod", "700", this.project]);
    const server = join(fixtures, "dependency-server.ts");
    writeFileSync(server, DEPENDENCY_SERVER);
    // The listener is this run's own child; its PID is the dependency selection's authority.
    this.dependencyServer = Bun.spawn([process.execPath, server, "0"], {
      env: { PATH: SYSTEM_PATH, HOME: this.env.HOME as string },
      stdout: "pipe",
      stderr: "inherit",
    });
  }

  async startDependencyServer(): Promise<void> {
    const server = this.dependencyServer;
    if (!(server && server.stdout instanceof ReadableStream)) {
      throw new Failure("dependency listener did not start");
    }
    const reader = server.stdout.getReader();
    const { value } = await reader.read();
    reader.releaseLock();
    this.dependencyPort = Number(new TextDecoder().decode(value).trim());
    this.check(
      "host dependency listener is up",
      Number.isInteger(this.dependencyPort) && this.dependencyPort > 0
    );
    writeFileSync(
      this.env.HACK_NATIVE_DEPENDENCIES as string,
      JSON.stringify({
        version: 1,
        dependencies: [
          {
            service: "web",
            binding: "qualification",
            guest_port: 80,
            aliases: ["dependency.qualification.test"],
            host_pid: server.pid,
            host_port: this.dependencyPort,
          },
        ],
      }),
      { mode: 0o600 }
    );
  }

  /** Start a `hack up`/`restart` foreground and wait for a ready observation. */
  async upForeground(
    name: string,
    command: "up" | "restart",
    previousContainer: string | null = null
  ): Promise<{ seconds: number; ps: Record<string, unknown> }> {
    const label = this.label(name);
    const started = performance.now();
    const out = Bun.file(join(this.evidence, `${label}.stdout`));
    const err = Bun.file(join(this.evidence, `${label}.stderr`));
    const previous = this.foreground;
    this.foreground = Bun.spawn(
      [this.options.hack, command, "--path", this.project],
      {
        cwd: this.project,
        env: this.env,
        stdin: "ignore",
        stdout: out,
        stderr: err,
      }
    );
    const deadline = started + 900_000;
    while (performance.now() < deadline) {
      if (this.foreground.exitCode !== null) {
        throw new Failure(
          `${name} exited ${this.foreground.exitCode} before readiness (see evidence ${label}.stderr)`
        );
      }
      const ps = this.exec(
        `${name}-ps`,
        [this.options.hack, "ps", "--path", this.project, "--json"],
        { cwd: this.project, timeout: 30, allowFailure: true }
      );
      const data = readyData(ps.stdout);
      const items =
        (data?.items as Record<string, unknown>[] | undefined) ?? [];
      const container =
        items.find((item) => item.service === "web")?.container ??
        items[0]?.container;
      if (data && items.length > 0 && container !== previousContainer) {
        const seconds = round((performance.now() - started) / 1000);
        if (previous && command === "restart") {
          this.check(
            `${name}: the previous foreground exits 0`,
            (await previous.exited) === 0
          );
        }
        return { seconds, ps: data };
      }
      await Bun.sleep(500);
    }
    throw new Failure(`${name} readiness deadline`);
  }

  async down(name: string, extra: string[] = []): Promise<number> {
    const result = this.hack(
      name,
      ["down", ...extra, "--path", this.project],
      300
    );
    if (this.foreground) {
      const code = await Promise.race([
        this.foreground.exited,
        Bun.sleep(120_000).then(() => -1),
      ]);
      if (extra.length === 0) {
        this.check(
          `${name}: the foreground exits 0 after down`,
          code === 0,
          `exit ${code}`
        );
      }
      this.foreground = null;
    }
    return result.seconds;
  }

  /** The current foreground; a method so flow narrowing does not pin an earlier value. */
  running(): ReturnType<typeof Bun.spawn> | null {
    return this.foreground;
  }

  /**
   * `hack down` stops the project but leaves the pool's VM running. Stop the main pool too,
   * so the second home's pool never boots beside it.
   */
  stopMainPool(before: string): void {
    this.runtime(
      this.main,
      `runtime-down-before-${before}`,
      ["runtime", "down", "--json"],
      300
    );
    this.check(
      `the main pool is stopped before the ${before} pool boots`,
      this.status(this.main).process_alive !== true
    );
  }

  observedReady(): boolean {
    const ps = this.exec(
      "ps-after-recover",
      [this.options.hack, "ps", "--path", this.project, "--json"],
      { cwd: this.project, timeout: 30, allowFailure: true }
    );
    return readyData(ps.stdout) !== null;
  }

  inContainer(
    name: string,
    service: string,
    script: string,
    timeout = 120
  ): string {
    return this.hack(
      name,
      ["exec", "--path", this.project, service, "--", "/bin/sh", "-c", script],
      timeout
    ).stdout;
  }

  diskIdentity(): Record<string, { size: number; ino: number; dev: number }> {
    const directory = this.dataDirectory(this.main);
    const identity: Record<string, { size: number; ino: number; dev: number }> =
      {};
    for (const name of ["storage.raw", "overlay.raw"]) {
      const stat = statSync(join(directory, name));
      identity[name] = { size: stat.size, ino: stat.ino, dev: stat.dev };
    }
    return identity;
  }

  // 3. First start: template expansion and digests.
  async firstStart(): Promise<Record<string, unknown>> {
    this.step = "3 templates";
    const { seconds, ps } = await this.upForeground("up-cold", "up");
    this.measure("cold_up_to_ready_seconds", seconds);
    const templates = join(this.main, PROVIDER_HOME, ".smolvm");
    const digests: Record<string, string> = {};
    for (const [name, length] of Object.entries(TEMPLATE_LENGTHS)) {
      const path = join(templates, name);
      this.check(
        `${name} expanded in the provider home`,
        existsSync(path) && lstatSync(path).isFile()
      );
      const digest = contentDigest(path);
      digests[name] = digest.sha256;
      this.check(
        `${name} has its logical length`,
        digest.length === length,
        String(digest.length)
      );
    }
    this.measure("expanded_template_digests", digests);
    const source = join(
      import.meta.dir,
      "../packages/runtime-core/src/provider/disk_template.rs"
    );
    const pins = existsSync(source)
      ? sourceTemplatePins(readFileSync(source, "utf8"))
      : null;
    const archive = (this.pins.smolvm as Record<string, string>).archive_sha256;
    if (pins && pins.archive === archive) {
      for (const [name, expected] of Object.entries(pins.templates)) {
        this.check(
          `${name} digest equals the repository pin`,
          digests[name] === expected,
          `got ${digests[name]}, pinned ${expected}`
        );
      }
    } else {
      this.note(
        "INFO template digests not compared: this checkout pins another archive; record the values above"
      );
    }
    const directory = this.dataDirectory(this.main);
    for (const marker of ["storage.formatted", "overlay.formatted"]) {
      this.check(
        `${marker} recorded by the first start`,
        existsSync(join(directory, marker))
      );
    }
    return ps;
  }

  // 4. Exact-size disk identity with trim off.
  async diskChecks(): Promise<
    Record<string, { size: number; ino: number; dev: number }>
  > {
    this.step = "4 disk identity";
    const identity = this.diskIdentity();
    const expected = PROFILE_DISKS.development;
    this.check(
      "storage.raw has exactly the profile size",
      identity["storage.raw"]?.size === expected.storage,
      JSON.stringify(identity)
    );
    this.check(
      "overlay.raw has exactly the profile size",
      identity["overlay.raw"]?.size === expected.overlay,
      JSON.stringify(identity)
    );
    const owner = this.owner(this.main);
    const pid = Number(
      (owner.process as Record<string, unknown> | undefined)?.pid
    );
    const environment = this.exec(
      "provider-environment",
      ["/bin/ps", "eww", "-o", "command=", "-p", String(pid)],
      { allowFailure: true }
    ).stdout;
    if (environment.includes("SMOLVM_")) {
      this.check(
        "provider runs with SMOLVM_DISK_TRIM=0",
        /\bSMOLVM_DISK_TRIM=0\b/.test(environment)
      );
      this.measure(
        "provider_idle_reclaim_minutes",
        /\bSMOLVM_IDLE_RECLAIM=(\d+)/.exec(environment)?.[1] ?? null
      );
    } else {
      this.note(
        "INFO provider environment not readable through ps; trim is checked by disk size after the guest trim interval"
      );
    }
    this.inContainer(
      "fill-and-delete",
      "db",
      "dd if=/dev/zero of=/var/lib/postgresql/data/qualification.fill bs=1M count=512 2>/dev/null && sync && rm /var/lib/postgresql/data/qualification.fill && sync",
      300
    );
    // The guest trim thread polls every 30 s and acts after 256 MiB of freed space; wait past
    // three polls so an enabled trim would have shortened the disk before the comparison.
    await Bun.sleep(100_000);
    const after = this.diskIdentity();
    this.check(
      "disk identity and size survive a 512 MiB write, delete and the trim interval",
      JSON.stringify(after) === JSON.stringify(identity),
      JSON.stringify(after)
    );
    return identity;
  }

  async dbReady(): Promise<void> {
    for (let attempt = 0; attempt < 90; attempt++) {
      const result = this.exec(
        "pg-isready",
        [
          this.options.hack,
          "exec",
          "--path",
          this.project,
          "db",
          "--",
          "pg_isready",
          "-U",
          "postgres",
        ],
        { cwd: this.project, allowFailure: true, timeout: 30 }
      );
      if (result.code === 0) {
        return;
      }
      await Bun.sleep(1000);
    }
    throw new Failure("database did not become ready");
  }

  psql(name: string, sql: string): string {
    return this.inContainer(
      name,
      "db",
      `PGPASSWORD=qualification psql -h db -U postgres -tAc "${sql}"`
    ).trim();
  }

  // 7. --mount-socket: the framed dependency relay, both directions.
  relay(name: string): void {
    const blob = this.inContainer(
      `${name}-get`,
      "web",
      "wget -qO- http://dependency.qualification.test/blob | sha256sum"
    )
      .trim()
      .split(/\s+/)[0];
    this.check(
      `${name}: 64 KiB host-to-guest over the dependency socket`,
      blob === BLOB_SHA256,
      blob
    );
    const echo = this.inContainer(
      `${name}-post`,
      "web",
      "head -c 65536 /dev/urandom > /tmp/q && sha256sum /tmp/q | cut -d ' ' -f 1 && wget -qO- --post-file=/tmp/q http://dependency.qualification.test/echo"
    )
      .trim()
      .split(/\s+/);
    this.check(
      `${name}: 64 KiB guest-to-host over the dependency socket`,
      echo.length === 3 && echo[0] === echo[1] && echo[2] === "65536",
      echo.join(" ")
    );
  }

  async run(): Promise<number> {
    mkdirSync(this.evidence, { mode: 0o700 });
    for (const directory of ["user-home", "cli-home", "tmp"]) {
      mkdirSync(join(this.options.root, directory), { mode: 0o700 });
    }
    writeFileSync(
      join(this.evidence, "preflight.json"),
      JSON.stringify(
        { options: this.options, env: this.env, host: hostFacts() },
        null,
        2
      )
    );
    try {
      this.archive();
      this.prepare();
      this.writeProject();
      await this.startDependencyServer();
      const first = await this.firstStart();
      await this.dbReady();
      const marker = `marker-${crypto.randomUUID()}`;
      this.psql(
        "db-write",
        `CREATE TABLE qualification(v text); INSERT INTO qualification VALUES ('${marker}')`
      );
      const identity = await this.diskChecks();
      await this.lifecycle(first, marker, identity);

      // The second home boots only while the project pool is stopped, so host memory
      // admission never has to fit both pools.
      this.step = "6 network modes";
      await this.down("down-before-network");
      this.stopMainPool("network");
      this.networkModes();

      this.step = "7 mount-socket";
      let ready = await this.upForeground("up-relay", "up");
      this.relay("relay");
      ready = await this.upForeground(
        "restart-relay",
        "restart",
        readyContainer(ready.ps)
      );
      this.relay("relay-after-restart");

      this.step = "8 rosetta";
      await this.down("down-before-rosetta");
      this.stopMainPool("rosetta");
      this.rosetta();

      this.step = "9 web+db";
      ready = await this.upForeground("up-web-db", "up");
      await this.dbReady();
      this.check(
        "the database row survives every restart, recovery and unclean stop",
        this.psql("db-read-final", "SELECT v FROM qualification") === marker
      );
      this.check(
        "web serves its index",
        this.inContainer(
          "web-index",
          "web",
          "wget -qO- http://127.0.0.1:8080/index.txt"
        ).trim() === "ready"
      );
      this.check(
        "web reaches db by service name",
        this.inContainer(
          "web-to-db",
          "web",
          "nc -w 3 db 5432 </dev/null >/dev/null 2>&1; echo $?"
        ).trim() === "0"
      );
      const record = this.record(this.main);
      this.check(
        "the project pool record keeps every newer capability inert",
        activeFields(record, INERT_RECORD_FIELDS).length === 0,
        activeFields(record, INERT_RECORD_FIELDS).join(",")
      );
      this.check(
        "disk identity is unchanged at the end",
        JSON.stringify(this.diskIdentity()) === JSON.stringify(identity)
      );

      this.step = "10 measurements";
      await this.idle();
      this.check(
        "disk identity is unchanged after the idle period",
        JSON.stringify(this.diskIdentity()) === JSON.stringify(identity)
      );
      this.measure("final_down_seconds", round(await this.down("down-final")));
      this.runtime(
        this.main,
        "runtime-down-final",
        ["runtime", "down", "--json"],
        300
      );
      this.dependencyServer?.kill("SIGTERM");
      writeFileSync(
        join(this.evidence, "qualification.json"),
        JSON.stringify(
          { passed: this.passed, measurements: this.measurements },
          null,
          2
        )
      );
      this.note(
        "PASS all checks; both pools are stopped. Remove the root yourself once the evidence is copied."
      );
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeFileSync(
        join(this.evidence, "failure.json"),
        JSON.stringify(
          {
            step: this.step,
            failure: message,
            passed: this.passed,
            measurements: this.measurements,
          },
          null,
          2
        )
      );
      console.log(`FAIL ${this.step}: ${message}`);
      console.log(
        `Nothing was stopped or removed. Stop the pools with: ${this.options.native} --candidate-root ${this.main} runtime down --json (and the same for ${this.aux}); the dependency listener is PID ${this.dependencyServer?.pid ?? "none"}.`
      );
      return 1;
    }
  }

  // 5. Boot, restart, down, down --recover and an unclean stop of the provider VM.
  async lifecycle(
    first: Record<string, unknown>,
    marker: string,
    identity: Record<string, { size: number; ino: number; dev: number }>
  ): Promise<void> {
    this.step = "5 lifecycle";
    let ready = await this.upForeground(
      "restart",
      "restart",
      readyContainer(first)
    );
    this.measure("restart_to_ready_seconds", ready.seconds);
    this.measure("down_seconds", round(await this.down("down")));
    ready = await this.upForeground("up-warm", "up");
    this.measure("warm_up_to_ready_seconds", ready.seconds);
    await this.dbReady();
    this.check(
      "the database row survives down and up",
      this.psql("db-read-warm", "SELECT v FROM qualification") === marker
    );

    // A lost foreground: this run's own child, killed; down --recover retires its run.
    const lost = this.running();
    lost?.kill("SIGKILL");
    await lost?.exited;
    this.foreground = null;
    await this.down("down-recover", ["--recover"]);
    this.check(
      "down --recover retires the run whose foreground was lost",
      !this.observedReady()
    );
    await this.upForeground("up-after-recover", "up");

    // An unclean stop: SIGKILL to this pool's provider VM, identified by its receipt.
    const providers = realpathSync(join(this.main, ".hack-local/providers"));
    const recorded = this.owner(this.main).process as
      | Record<string, unknown>
      | undefined;
    const pid = Number(recorded?.pid);
    const executable = String(recorded?.executable ?? "");
    const listed = this.processes(this.main).find((row) => row.pid === pid);
    this.check(
      "the receipt's provider runs from this home's provider tree",
      Number.isInteger(pid) &&
        pid > 1 &&
        executable.startsWith(`${providers}/smolvm-`) &&
        listed !== undefined,
      `${pid} ${executable}`
    );
    // Immediately before the signal: the live process still has the receipt's user and
    // start time, so a reused PID is never signalled.
    // `lstart` is local time without a zone: print it in UTC and parse it as UTC.
    const live = this.exec("provider-identity", [
      "/usr/bin/env",
      "TZ=UTC",
      "/bin/ps",
      "-o",
      "uid=,lstart=",
      "-p",
      String(pid),
    ]).stdout.trim();
    const [uid, ...started] = live.split(/\s+/);
    const startedMs = Date.parse(`${started.join(" ")} GMT`);
    const recordedMs = Number(recorded?.start_micros) / 1000;
    this.check(
      "the live provider matches the receipt's user and start time",
      Number(uid) === Number(recorded?.uid) &&
        Number.isFinite(startedMs) &&
        Math.abs(startedMs - recordedMs) < 2000,
      `${live} vs uid ${String(recorded?.uid)} start ${recordedMs}`
    );
    process.kill(pid, "SIGKILL");
    for (
      let attempt = 0;
      attempt < 120 && this.processes(this.main).some((row) => row.pid === pid);
      attempt++
    ) {
      await Bun.sleep(500);
    }
    // The foreground observes the lost provider and exits; it is not signalled.
    const code = await Promise.race([
      this.running()?.exited,
      Bun.sleep(120_000).then(() => "running"),
    ]);
    this.note(`INFO foreground after the unclean stop: ${String(code)}`);
    this.foreground = null;
    const retired = this.hack(
      "down-recover-after-unclean",
      ["down", "--recover", "--path", this.project],
      300,
      true
    );
    this.note(
      `INFO down --recover after the unclean stop exited ${retired.code}`
    );
    let status = this.status(this.main);
    if (status.phase !== "recovered-unclean") {
      status = this.runtime(this.main, "recover", [
        "runtime",
        "recover",
        "--json",
      ]);
    }
    this.check(
      "the unclean stop is recorded as recovered-unclean",
      status.phase === "recovered-unclean" && status.process_alive !== true,
      String(status.phase)
    );
    ready = await this.upForeground("up-after-unclean", "up");
    this.measure("up_after_unclean_stop_seconds", ready.seconds);
    await this.dbReady();
    this.check(
      "disk identity survives the unclean stop",
      JSON.stringify(this.diskIdentity()) === JSON.stringify(identity)
    );
    this.check(
      "the database row survives the unclean stop",
      this.psql("db-read-unclean", "SELECT v FROM qualification") === marker
    );
  }

  networkModes(): void {
    const [first, second] = this.options.approvedHosts;
    const mainRecord = this.record(this.main);
    this.check(
      "isolated pool record: no network",
      mainRecord.network === false &&
        mainRecord.allowed_cidrs == null &&
        mainRecord.dns_filter_hosts == null,
      JSON.stringify({
        network: mainRecord.network,
        allowed_cidrs: mainRecord.allowed_cidrs,
      })
    );
    this.runtime(
      this.aux,
      "aux-up-approved",
      [
        "runtime",
        "up",
        "--profile",
        "research",
        "--allow-host",
        first,
        "--json",
      ],
      600
    );
    let record = this.record(this.aux);
    const cidrs = record.allowed_cidrs as unknown[] | null;
    this.check(
      "approved-hosts record",
      record.network_backend === "virtio-net" &&
        JSON.stringify(record.dns_filter_hosts) === JSON.stringify([first]) &&
        Array.isArray(cidrs) &&
        cidrs.length > 0,
      JSON.stringify({ hosts: record.dns_filter_hosts, cidrs })
    );
    const running = this.runningConfig(this.aux);
    const resources = running.resources as Record<string, unknown>;
    this.check(
      "approved-hosts running configuration",
      resources.network === true &&
        resources.network_backend === "virtio-net" &&
        activeFields(resources, INERT_RUNNING_RESOURCES).length === 0,
      JSON.stringify(resources)
    );
    this.runtime(this.aux, "aux-down-approved", ["runtime", "down", "--json"]);
    this.runtime(this.aux, "aux-extend", [
      "runtime",
      "network",
      "extend",
      "--allow-host",
      second,
      "--json",
    ]);
    record = this.record(this.aux);
    this.check(
      "extended approved-hosts record",
      JSON.stringify(record.dns_filter_hosts) ===
        JSON.stringify([first, second].sort()),
      JSON.stringify(record.dns_filter_hosts)
    );
    this.runtime(this.aux, "aux-internet", [
      "runtime",
      "network",
      "internet",
      "--json",
    ]);
    record = this.record(this.aux);
    this.check(
      "internet record",
      record.network === true &&
        record.network_backend === "virtio-net" &&
        record.allowed_cidrs == null &&
        record.dns_filter_hosts == null,
      JSON.stringify({
        network: record.network,
        cidrs: record.allowed_cidrs,
        hosts: record.dns_filter_hosts,
      })
    );
    this.runtime(
      this.aux,
      "aux-up-internet",
      ["runtime", "up", "--profile", "research", "--internet", "--json"],
      600
    );
    const status = this.status(this.aux);
    this.check(
      "internet pool boots and reports its intent",
      status.process_alive === true &&
        JSON.stringify(status.network).includes("internet"),
      JSON.stringify(status.network)
    );
    this.check(
      "every record keeps newer capabilities inert",
      activeFields(this.record(this.aux), INERT_RECORD_FIELDS).length === 0
    );
    this.runtime(this.aux, "aux-down-internet", ["runtime", "down", "--json"]);
  }

  rosetta(): void {
    this.runtime(
      this.aux,
      "aux-up-rosetta",
      [
        "runtime",
        "up",
        "--profile",
        "research",
        "--internet",
        "--amd64-emulation",
        "--json",
      ],
      600
    );
    const record = this.record(this.aux);
    this.check(
      "the stored record enables Rosetta",
      record.rosetta === true,
      String(record.rosetta)
    );
    const resources = this.runningConfig(this.aux).resources as Record<
      string,
      unknown
    >;
    this.check(
      "the running configuration enables Rosetta",
      resources.rosetta === true
    );
    if (this.options.amd64Image) {
      const ensured = this.runtime(
        this.aux,
        "aux-ensure-amd64",
        [
          "runtime",
          "ensure-image",
          "--reference",
          this.options.amd64Image,
          "--emulation",
          "amd64",
          "--json",
        ],
        600
      );
      this.check(
        "an amd64 image is admitted under translation",
        JSON.stringify(ensured).includes("amd64"),
        JSON.stringify(ensured).slice(0, 300)
      );
    }
    this.runtime(this.aux, "aux-down-rosetta", ["runtime", "down", "--json"]);
  }

  /** Footprint and CPU of this home's provider processes. */
  sample(label: string): Record<string, unknown> {
    const rows = this.processes(this.main);
    let footprint = 0;
    let measured = true;
    for (const row of rows) {
      // `footprint` needs the task port, which a hardened provider may refuse to a same-user
      // caller; `top` reads the same physical footprint (MEM) through libproc.
      const output = this.exec(
        `footprint-${label}`,
        ["/usr/bin/footprint", String(row.pid)],
        { allowFailure: true }
      );
      let bytes = parseFootprint(output.stdout + output.stderr);
      if (bytes === null) {
        const top = this.exec(
          `top-${label}`,
          [
            "/usr/bin/top",
            "-l",
            "1",
            "-pid",
            String(row.pid),
            "-stats",
            "pid,mem",
          ],
          { allowFailure: true }
        );
        bytes = parseTopMemory(top.stdout, row.pid);
      }
      if (bytes === null) {
        measured = false;
      } else {
        footprint += bytes;
      }
    }
    return {
      processes: rows.map((row) => ({
        pid: row.pid,
        rss_kib: row.rssKib,
        command: row.command.split(" ").slice(0, 2).join(" "),
      })),
      footprint_mib: measured ? round(footprint / 1024 / 1024) : null,
      rss_mib: round(rows.reduce((sum, row) => sum + row.rssKib, 0) / 1024),
      cpu_seconds: rows.reduce((sum, row) => sum + row.cpuSeconds, 0),
    };
  }

  async idle(): Promise<void> {
    if (this.options.skipIdle) {
      this.note("INFO idle measurements skipped (--skip-idle)");
      return;
    }
    const started = performance.now();
    for (const minute of this.options.idleMinutes) {
      const wait = started + minute * 60_000 - performance.now();
      if (wait > 0) {
        await Bun.sleep(wait);
      }
      const before = this.sample(`idle-${minute}m`);
      await Bun.sleep(30_000);
      const after = this.sample(`idle-${minute}m-cpu`);
      const cpu = round(
        ((Number(after.cpu_seconds) - Number(before.cpu_seconds)) / 30) * 100
      );
      this.measure(`idle_${minute}m`, {
        footprint_mib: before.footprint_mib,
        rss_mib: before.rss_mib,
        cpu_percent_over_30s: cpu,
        processes: before.processes,
      });
    }
  }
}

function readyContainer(status: Record<string, unknown>): string | null {
  const items = (status.items as Record<string, unknown>[] | undefined) ?? [];
  return (
    (items.find((item) => item.service === "web")?.container as
      | string
      | undefined) ?? null
  );
}

/** `hack ps --json` data when the run is observed ready. */
export function readyData(stdout: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(stdout) as {
      ok?: unknown;
      data?: Record<string, unknown>;
    };
    const data = value.ok === true ? value.data : undefined;
    return data && data.status === "observed" && data.phase === "ready-observed"
      ? data
      : null;
  } catch {
    return null;
  }
}

function sha256File(path: string): string {
  const hash = createHash("sha256");
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, offset);
      if (read <= 0) {
        break;
      }
      hash.update(buffer.subarray(0, read));
      offset += read;
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest("hex");
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function hostFacts(): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const [name, argv] of [
    ["os", ["/usr/bin/sw_vers"]],
    ["arch", ["/usr/bin/uname", "-m"]],
    ["memory", ["/usr/sbin/sysctl", "-n", "hw.memsize"]],
    ["cpu", ["/usr/sbin/sysctl", "-n", "machdep.cpu.brand_string"]],
  ] as const) {
    const result = Bun.spawnSync([...argv], {
      stdout: "pipe",
      stderr: "ignore",
    });
    facts[name] = result.stdout.toString().trim();
  }
  return facts;
}

/** Root checks: an existing, empty, private, canonical directory owned by this user. */
export function rootProblem(root: string): string | null {
  if (/[?#%]/.test(root)) {
    return "--home must not contain ?, # or % (it is used in an SQLite URI)";
  }
  if (!existsSync(root)) {
    return "--home must exist";
  }
  const stat = lstatSync(root);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    stat.uid !== process.getuid?.()
  ) {
    return "--home must be a private (0700) directory owned by this user";
  }
  if (realpathSync(root) !== resolve(root)) {
    return "--home must be canonical (on macOS use /private/tmp, not /tmp)";
  }
  if (readdirSync(root).length > 0) {
    return "--home must be empty";
  }
  return null;
}

export async function main(argv: string[]): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 64;
  }
  const plan = {
    hack: options.hack,
    native: options.native,
    home: options.root,
    homes: {
      main: join(options.root, "candidate"),
      network: join(options.root, "candidate-network"),
    },
    images: {
      web: options.webImage,
      db: options.dbImage,
      amd64: options.amd64Image,
    },
    approved_hosts: options.approvedHosts,
    idle_minutes: options.idleMinutes,
    sequence: [
      "1 archive",
      "2 prepare",
      "3 templates",
      "4 disk identity",
      "5 lifecycle",
      "6 network modes",
      "7 mount-socket",
      "8 rosetta",
      "9 web+db",
      "10 measurements",
    ],
  };
  if (!options.run) {
    console.log(JSON.stringify({ preview: plan }, null, 2));
    return 0;
  }
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    console.error("Qualification runs only on Apple Silicon macOS.");
    return 64;
  }
  if (process.getuid?.() === 0) {
    console.error("Run as your own user, never as root.");
    return 64;
  }
  const problem = rootProblem(options.root);
  for (const path of [
    options.hack,
    options.native,
    join(options.bundle, "provider-pins.json"),
    options.providerArchive,
    options.engineArchive,
    options.networkTools,
  ]) {
    if (!existsSync(path)) {
      console.error(`Missing ${path}.`);
      return 64;
    }
  }
  if (problem) {
    console.error(problem);
    return 64;
  }
  return await new Qualification(options).run();
}

if (import.meta.main) {
  process.exit(await main(Bun.argv.slice(2)));
}
