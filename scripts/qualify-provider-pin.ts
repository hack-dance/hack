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
 *   2. prepare: `runtime prepare`, `prepare-engine`, `prepare-network-tools` and `probe`
 *      in three homes. 2a: `prepared-base build`, `verify` (both disks and the overlay's
 *      upper-layer inventory) and `remove` in the second home, each its own check. 2b: a pool
 *      without internet access booted and stopped in the third (network tools included).
 *   3. templates: the first start expands both disk templates at their logical sizes; their
 *      content digests (the runtime's own definition) are printed and compared with the
 *      repository pins when this checkout pins the same archive.
 *   4. disk identity: both machine disks have exactly the profile size, the provider runs
 *      with `SMOLVM_DISK_TRIM=0`, and the identity and size survive writes and deletes.
 *   5. lifecycle: `hack up`, `restart`, `down`, then a lost foreground: the release's answer
 *      to `down --recover` is recorded, and its documented recovery (`down`, `restart
 *      --recover-frontend`, `down`) is followed when it refuses.
 *   6. network modes (second home, with the project pool stopped): approved hosts, extended
 *      hosts and internet, each read back from the provider's stored machine record and
 *      running configuration; the project pool's own network is recorded.
 *   7. `--mount-socket`: a host dependency listener relayed into a container through the
 *      pool's dependency sockets (framed relay), 64 KiB each way (no zero bytes: busybox
 *      `wget --post-file` stops at one), before and after restart.
 *   8. Rosetta (second home, project pool stopped): `runtime up --amd64-emulation`.
 *   9. web plus database: service DNS, and a database write that survives every step.
 *  10. measurements: prepare time, cold and warm `up` to ready, `restart`, `down`, VM plus
 *      helper physical footprint at idle after 0, 3 and 10 minutes (3 is past the 2-minute
 *      reclaim pulse), and idle CPU.
 *  11. unclean stop, last and recorded only: SIGKILL to the provider VM, then what the
 *      foreground, `down --recover`, `runtime recover` and the next `up -d` do.
 *
 * `--profile` (default `development`) selects the profile of the second and third homes'
 * pools; the project pool is the frontend's. The run grants its own fixture's project share
 * (`HACK_NATIVE_SHARED_SOURCE=1`) and keeps secrets off the keychain.
 *
 * Preview-first: without --run it prints the plan and changes nothing. It never uses
 * sudo, never reads or writes the real home (every child gets a HOME, XDG directories,
 * HACK_HOME and HACK_NATIVE_HOME inside the root), keeps Docker clients pointed at a dead
 * socket, and disables daemon autostart. The provider itself uses the short
 * `/private/tmp/hkl-*` alias the runtime creates for every pool.
 *
 * By default the first failed check prints one `FAIL <step>: <check>: <detail>` line, writes
 * evidence/failure.json and exits 1; nothing is stopped or removed, so the state can be
 * inspected, and the line names the command that stops each pool. With `--keep-going`
 * every failed check is recorded and the run continues (a failed step 1-3 still ends it).
 * After any failed step, including a recorded check failure, every pool of the run is asked
 * to stop and the run shows that no provider of its homes and no foreground it started is
 * still running before the next step
 * boots a pool; when it cannot, every later step is skipped and the evidence recorded. At
 * the end the run asks every pool to stop, lists each failure and exits 1. Exit 0 means
 * every check passed; the recovery answers of steps 5 and 11 are recorded, not checked, so
 * read them in qualification.json. At the end it also checks that no provider of its homes
 * is still running (a run that leaves one fails and lists it). The only processes it
 * signals are its own children (a foreground still running after every pool was asked to
 * stop gets SIGTERM at cleanup) and, in step 11, the provider VM process of its own pool,
 * which it identifies by the pool receipt, executable path, user and start time before
 * sending SIGKILL.
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
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

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
  keepGoing: boolean;
  profile: "development" | "research";
  caddy: string | null;
  httpsPort: number | null;
  run: boolean;
}

const USAGE = `Usage: bun scripts/qualify-provider-pin.ts --hack /abs/bundle/hack-v5 --home /abs/empty-private-root \\
  --provider-archive /abs/smolvm-<v>-darwin-arm64.tar.gz --engine-archive /abs/docker-<v>.tgz \\
  --network-tools /abs/private-apk-dir --web-image busybox@sha256:... --db-image postgres@sha256:... \\
  [--upstream-checksums /abs/checksums.sha256] [--approved-host example.com --approved-host example.org] \\
  [--amd64-image repo@sha256:...] [--idle-minutes 0,3,10 | --skip-idle] \\
  [--profile development|research] [--keep-going] \\
  [--caddy /abs/caddy --https-port 8443] [--run]`;

function idleMinutes(text: string): number[] {
  const idle = text.split(",").map(Number);
  const valid =
    idle.length > 0 &&
    idle.every(
      (minute) => Number.isInteger(minute) && minute >= 0 && minute <= 60
    ) &&
    idle.every(
      (minute, index) => index === 0 || minute > (idle[index - 1] as number)
    );
  if (!valid) {
    throw new Error(
      "--idle-minutes must be increasing whole minutes from 0 to 60."
    );
  }
  return idle;
}

const FLAGS = new Set(["--run", "--skip-idle", "--keep-going"]);

/** Parse and validate arguments; throws with a usage line on any problem. */
export function parseOptions(argv: string[]): Options {
  const values = new Map<string, string[]>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index] as string;
    if (FLAGS.has(name)) {
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
  const idle = idleMinutes(one("--idle-minutes", false) ?? "0,3,10");
  const profile = one("--profile", false) ?? "development";
  if (profile !== "development" && profile !== "research") {
    throw new Error("--profile must be development or research.");
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
    keepGoing: flags.has("--keep-going"),
    profile,
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

/** Console progress from this foreground's own stderr, after startup has completed. */
export function foregroundReadyRun(stderr: string): string | null {
  return (
    /^SUCCESS: Project is ready \([^\r\n]*; run ([0-9a-f]{32})\)\. Use hack ps and hack logs from another terminal; press Ctrl-C to stop\.$/m.exec(
      stderr
    )?.[1] ?? null
  );
}

/**
 * Primary code in the foreground's terminal console error. Qualification fixes the
 * console logger and does not enable debug stacks; earlier output and runtime notes
 * may contain service text and cannot establish the command's failure code. The
 * CLI appends failed-service tails after their own heading; those are not errors
 * emitted by the frontend, even if a service printed an identical-looking line.
 */
export function terminalRuntimeErrorCode(stderr: string): string | null {
  const diagnostic =
    stderr.split(/\r?\nLast output of failed services \(/, 1)[0] ?? "";
  const line = diagnostic.trimEnd().split(/\r?\n/).at(-1) ?? "";
  return (
    /^ERROR: Native runtime request failed \(([a-z][a-z0-9_]{0,79})(?:: [a-z][a-z0-9_]{0,79})?\); [^\r\n]+$/.exec(
      line
    )?.[1] ?? null
  );
}

/** Startup progress is small; fail closed rather than reading an unbounded log. */
function startupOutput(path: string): string {
  if (!existsSync(path)) {
    return "";
  }
  const descriptor = openSync(path, "r");
  try {
    const length = fstatSync(descriptor).size;
    if (length > 1024 * 1024) {
      throw new Failure(
        "Startup diagnostic exceeds the observation limit; see evidence."
      );
    }
    const bytes = Buffer.alloc(length);
    const read = readSync(descriptor, bytes, 0, length, 0);
    return bytes.subarray(0, read).toString("utf8");
  } finally {
    closeSync(descriptor);
  }
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
  seconds: number;
}

const SYSTEM_PATH = "/usr/bin:/bin:/usr/sbin:/sbin";

/** A candidate home's provider `$HOME` (the runtime's `run/smolvm/home`). */
const PROVIDER_HOME = join(".hack-local", "run", "smolvm", "home");

export class Qualification {
  /** Read boundary for testing a stale diagnostic snapshot racing with child exit. */
  readStartupOutput = startupOutput;
  readonly evidence: string;
  readonly main: string;
  readonly aux: string;
  readonly isolated: string;
  readonly project: string;
  readonly env: Record<string, string>;
  readonly measurements: Record<string, unknown> = {};
  readonly passed: string[] = [];
  readonly failed: string[] = [];
  /** Whether the current step must pass for any later step to mean anything. */
  stepRequired = true;
  readonly recorded: Record<string, unknown> = {};
  step = "setup";
  pins: Record<string, Record<string, unknown>> = {};
  foreground: ReturnType<typeof Bun.spawn> | null = null;
  /** Foregrounds of this run that were replaced or abandoned while still running. */
  readonly strays: ReturnType<typeof Bun.spawn>[] = [];
  /** Set when a failed step's pools or foregrounds could not be shown stopped. */
  blocked: string | null = null;
  /** How long a foreground of this run gets to exit after it was asked to. */
  exitWaitMs = 120_000;
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
    this.isolated = join(root, "candidate-isolated");
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
      // The fixture project is this run's own: grant its share, and keep secrets off the
      // login keychain (the isolated HOME has none, and a prompt would stall the run).
      HACK_NATIVE_SHARED_SOURCE: "1",
      HACK_SECRETS_DISABLE_KEYCHAIN_FALLBACK: "1",
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
      const message = `${name}${detail ? `: ${detail}` : ""}`;
      if (!this.options.keepGoing || this.stepRequired) {
        throw new Failure(message);
      }
      this.failed.push(`${this.step}: ${message}`);
      this.note(`FAIL ${this.step}: ${message} (continuing: --keep-going)`);
      return;
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
  machineRecord(home: string): Record<string, unknown> {
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
    for (const home of [this.main, this.aux, this.isolated]) {
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
      this.runtime(this.isolated, `isolated-${name}`, [...args]);
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
    const templates = join(this.main, PROVIDER_HOME, ".smolvm");
    this.check(
      "no expanded template exists before the first start",
      !Object.keys(TEMPLATE_LENGTHS).some((name) =>
        existsSync(join(templates, name))
      )
    );
  }

  /**
   * 2a. A prepared base, before any other pool runs: `build` boots a verifier pool without
   * internet in the second home (installing the network tools), and `verify` boots it again
   * and checks both disks, including the overlay's upper-layer inventory against the pinned
   * guest's file set. Each command is its own check; the base is removed afterwards.
   */
  async preparedBase(): Promise<void> {
    try {
      this.preparedBaseCommands();
    } finally {
      // A verifier VM left running (a failed teardown, or a command killed at its timeout)
      // must not share the host with the next step's pool: wait, then block later steps.
      await this.settleProviders("2a prepared base");
    }
  }

  /**
   * Wait for every provider of the run to exit; when one does not, or the check fails,
   * record it and skip every later step.
   */
  async settleProviders(after: string): Promise<void> {
    const key = `providers_after_${after.replace(/\W+/g, "_")}`;
    try {
      const left = await this.lingeringProviders();
      if (left.length > 0) {
        this.record(key, left);
        this.blocked = `step ${after} left provider processes running: ${left.join(", ")}`;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.record(key, { check_failed: message });
      this.blocked = `the provider check after step ${after} failed: ${message}`;
    }
  }

  preparedBaseCommands(): void {
    const store = this.store();
    mkdirSync(store, { mode: 0o700 });
    const native = (name: string, args: string[]) =>
      this.exec(
        name,
        [
          this.options.native,
          "--candidate-root",
          this.aux,
          "runtime",
          "prepared-base",
          ...args,
          "--store",
          store,
          "--json",
        ],
        { timeout: 900, allowFailure: true }
      );
    const detail = (result: Result) =>
      (result.stderr || result.stdout).trim().slice(-600);
    let started = performance.now();
    const built = native("prepared-base-build", [
      "build",
      "--profile",
      this.options.profile,
    ]);
    const base = String(
      (readJson(built.stdout)?.receipt as Record<string, unknown> | undefined)
        ?.base_id ?? ""
    );
    this.check(
      "prepared-base build succeeds",
      built.code === 0 && base.length > 0,
      detail(built)
    );
    if (built.code !== 0 || base.length === 0) {
      return;
    }
    this.measure(
      "prepared_base_build_seconds",
      round((performance.now() - started) / 1000)
    );
    started = performance.now();
    const verified = native("prepared-base-verify", [
      "verify",
      "--base-id",
      base,
    ]);
    this.check(
      "prepared-base verify accepts the base's disks and upper-layer inventory",
      verified.code === 0,
      detail(verified)
    );
    if (verified.code === 0) {
      this.measure(
        "prepared_base_verify_seconds",
        round((performance.now() - started) / 1000)
      );
    }
    const removed = native("prepared-base-remove", [
      "remove",
      "--base-id",
      base,
    ]);
    this.check(
      "prepared-base remove succeeds",
      removed.code === 0,
      detail(removed)
    );
  }

  /**
   * A pool without internet access boots, network tools included, then stops. A guest step
   * that needs the network (apk-tools 3 refreshing its index) times out here, not on a pool
   * with internet; this is the check that failed on the first SmolVM 1.34.1 run.
   */
  isolatedBoot(): void {
    const started = performance.now();
    const result = this.exec(
      "isolated-up",
      [
        this.options.native,
        "--candidate-root",
        this.isolated,
        "runtime",
        "up",
        "--profile",
        this.options.profile,
        "--json",
      ],
      { timeout: 600, allowFailure: true }
    );
    this.check(
      "a pool without internet access boots",
      result.code === 0,
      (result.stderr || result.stdout).trim().slice(-400)
    );
    if (result.code !== 0) {
      return;
    }
    this.measure(
      "isolated_cold_boot_seconds",
      round((performance.now() - started) / 1000)
    );
    const status = this.status(this.isolated);
    this.check(
      "the pool without internet runs with no network",
      status.process_alive === true &&
        JSON.stringify(this.machineRecord(this.isolated).network) === "false",
      JSON.stringify(status.network)
    );
    this.runtime(
      this.isolated,
      "isolated-down",
      ["runtime", "down", "--json"],
      300
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

  /** Wait for this foreground's ready line before any provider-lock-taking observation. */
  async upForeground(
    name: string,
    command: "up" | "restart",
    previousContainer: string | null = null,
    extra: string[] = []
  ): Promise<{ seconds: number; ps: Record<string, unknown> }> {
    const label = this.label(name);
    const started = performance.now();
    const out = Bun.file(join(this.evidence, `${label}.stdout`));
    const err = Bun.file(join(this.evidence, `${label}.stderr`));
    const previous = this.foreground;
    this.foreground = Bun.spawn(
      [this.options.hack, command, ...extra, "--path", this.project],
      {
        cwd: this.project,
        env: this.env,
        stdin: "ignore",
        stdout: out,
        stderr: err,
      }
    );
    // Keep the old child reachable before any readiness observation can fail. If spawn
    // itself throws, this.foreground still holds the previous child.
    if (previous) {
      this.strays.push(previous);
    }
    const deadline = started + 900_000;
    while (performance.now() < deadline) {
      const stderrPath = join(this.evidence, `${label}.stderr`);
      const stderr = this.readStartupOutput(stderrPath);
      if (
        this.foreground.exitCode !== null ||
        this.foreground.signalCode !== null
      ) {
        // The child may write its diagnostic after the live snapshot above. Observe
        // completion, then classify the final output rather than that stale snapshot.
        await this.foreground.exited;
        const finalStderr = this.readStartupOutput(stderrPath);
        if (terminalRuntimeErrorCode(finalStderr) === "provider_busy") {
          this.record(`known_product_bug_provider_busy_${label}`, {
            operation: command,
            exit: this.foreground.exitCode,
            evidence: `${label}.stderr`,
          });
          throw new Failure(
            `${name}: KNOWN_PRODUCT_BUG provider_busy during ${command}; this does not establish a provider pin regression (see evidence ${label}.stderr)`
          );
        }
        throw new Failure(
          `${name} exited ${this.foreground.exitCode} before readiness (see evidence ${label}.stderr)`
        );
      }
      const readyRun = foregroundReadyRun(stderr);
      if (!readyRun) {
        await Bun.sleep(500);
        continue;
      }
      // This is a confirmation after the child's startup signal, never startup polling.
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
      if (
        ps.code === 0 &&
        data?.run === readyRun &&
        items.length > 0 &&
        container !== previousContainer
      ) {
        const seconds = round((performance.now() - started) / 1000);
        if (previous && command === "restart") {
          await this.waitForReplacedForeground(name, previous);
        }
        return { seconds, ps: data };
      }
      throw new Failure(
        `${name}: foreground signalled ready but its run was not confirmed by ps (see evidence ${label}.stderr)`
      );
    }
    throw new Failure(`${name} readiness deadline`);
  }

  /** A replaced child remains tracked until its bounded exit observation succeeds. */
  async waitForReplacedForeground(
    name: string,
    previous: ReturnType<typeof Bun.spawn>
  ): Promise<void> {
    const code = await Promise.race([
      previous.exited,
      Bun.sleep(this.exitWaitMs).then(() => null),
    ]);
    if (code === null) {
      throw new Failure(
        `${name}: the previous foreground is still running ${this.exitWaitMs / 1000} s after its replacement became ready (${this.identity(previous)}); it is kept for cleanup`
      );
    }
    const previousIndex = this.strays.indexOf(previous);
    if (previousIndex >= 0) {
      this.strays.splice(previousIndex, 1);
    }
    this.check(
      `${name}: the previous foreground exits 0`,
      code === 0,
      `exit ${code}`
    );
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
        Bun.sleep(this.exitWaitMs).then(() => -1),
      ]);
      if (code === -1) {
        this.strays.push(this.foreground);
      }
      this.foreground = null;
      if (extra.length === 0) {
        this.check(
          `${name}: the foreground exits 0 after down`,
          code === 0,
          `exit ${code}`
        );
      }
    }
    return result.seconds;
  }

  /** PID, start time and command of a child of this run, for a report. */
  identity(child: ReturnType<typeof Bun.spawn>): string {
    const row = this.exec(
      "foreground-identity",
      [
        "/bin/ps",
        "-ww",
        "-o",
        "pid=,lstart=,command=",
        "-p",
        String(child.pid),
      ],
      { timeout: 30, allowFailure: true }
    ).stdout.trim();
    return row || `PID ${child.pid}, no longer listed`;
  }

  /** The children of this run that are still running after waiting up to `ms`. */
  async alive(
    children: ReturnType<typeof Bun.spawn>[],
    ms: number
  ): Promise<ReturnType<typeof Bun.spawn>[]> {
    await Promise.race([
      Promise.all(children.map((child) => child.exited)),
      Bun.sleep(ms),
    ]);
    return children.filter(
      (child) => child.exitCode === null && child.signalCode === null
    );
  }

  /** Provider processes running from a home's own provider tree. */
  providerPids(home: string): number[] {
    if (!existsSync(join(home, ".hack-local/providers"))) {
      return [];
    }
    return this.processes(home).map((row) => row.pid);
  }

  /** The prepared-base store; its verifier VMs run from work roots below `.work/`. */
  store(): string {
    return join(this.options.root, "prepared-bases");
  }

  /** Every pool home of this run. */
  homes(): string[] {
    return [this.main, this.aux, this.isolated];
  }

  /** Ask every pool of this run to stop: the project first, then each home's pool. */
  stopAll(name: string): void {
    this.hack(`down-${name}`, ["down", "--path", this.project], 300, true);
    for (const home of this.homes()) {
      if (existsSync(join(home, ".hack-local/run/smolvm/owner.json"))) {
        this.exec(
          `runtime-down-${name}`,
          [
            this.options.native,
            "--candidate-root",
            home,
            "runtime",
            "down",
            "--json",
          ],
          { timeout: 300, allowFailure: true }
        );
      }
    }
  }

  /**
   * After a failed step under --keep-going, before another step boots a pool: stop what this
   * run owns, then show that no provider of any of its homes and no foreground it started is
   * still running. Without that, every later step is skipped (each boots a pool, and two
   * pools must never run at once, nor may a stale one skew measurements); the evidence is
   * kept and recorded.
   */
  async settle(after: string): Promise<void> {
    if (this.foreground) {
      this.strays.push(this.foreground);
      this.foreground = null;
    }
    const key = `stopped_after_${after.replace(/\W+/g, "_")}`;
    try {
      this.stopAll("after-failed-step");
      const foregrounds = await this.alive(this.strays, this.exitWaitMs);
      const evidence = {
        foregrounds_running: foregrounds.map((child) => this.identity(child)),
        providers_running: await this.lingeringProviders(),
      };
      this.record(key, evidence);
      if (
        evidence.foregrounds_running.length > 0 ||
        evidence.providers_running.length > 0
      ) {
        this.blocked = `step ${after} left processes running after cleanup: ${JSON.stringify(evidence)}`;
      } else {
        this.strays.length = 0;
      }
    } catch (error) {
      // An absence that could not be shown is treated as presence.
      const message = error instanceof Error ? error.message : String(error);
      this.record(key, { cleanup_check_failed: message });
      this.blocked = `the cleanup check after step ${after} failed: ${message}`;
    }
  }

  /**
   * Provider processes of every home of this run, as `home:pid`, and of the prepared-base
   * store's work roots, as `prepared-bases:pid`.
   */
  runningProviders(): string[] {
    const running = this.homes().flatMap((home) =>
      this.providerPids(home).map((pid) => `${basename(home)}:${pid}`)
    );
    if (existsSync(join(this.store(), ".work"))) {
      const work = `${realpathSync(join(this.store(), ".work"))}/`;
      const listing = this.exec("ps", [
        "/bin/ps",
        "-A",
        "-ww",
        "-o",
        "pid=,ppid=,rss=,time=,command=",
      ]);
      for (const row of parseProcessRows(listing.stdout)) {
        if (row.command.startsWith(work)) {
          running.push(`prepared-bases:${row.pid}`);
        }
      }
    }
    return running;
  }

  /**
   * Provider processes still running after up to `exitWaitMs`: `runtime down` waits only for
   * the receipt's VM process, and a helper of the same tree may take a moment longer.
   */
  async lingeringProviders(): Promise<string[]> {
    const deadline = performance.now() + this.exitWaitMs;
    let running = this.runningProviders();
    while (running.length > 0 && performance.now() < deadline) {
      await Bun.sleep(500);
      running = this.runningProviders();
    }
    return running;
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
    const stopped = this.status(this.main).process_alive !== true;
    if (!stopped) {
      throw new Failure(
        "The main pool is still running; refusing auxiliary pool boot."
      );
    }
    this.check(
      `the main pool is stopped before the ${before} pool boots`,
      true
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
      "head -c 65536 /dev/urandom | tr '\\000' '\\001' > /tmp/q && sha256sum /tmp/q | cut -d ' ' -f 1 && wget -qO- --post-file=/tmp/q http://dependency.qualification.test/echo"
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
    const marker = `marker-${crypto.randomUUID()}`;
    let first: Record<string, unknown> = {};
    let identity: Record<string, { size: number; ino: number; dev: number }> =
      {};
    // Steps 1-3 set up everything later steps use: a failure there ends the run even with
    // --keep-going. Every later step runs whatever happened before it under --keep-going.
    const steps: [string, boolean, () => Promise<void> | void][] = [
      ["1 archive", true, () => this.archive()],
      ["2 prepare", true, () => this.prepare()],
      ["2a prepared base", false, () => this.preparedBase()],
      ["2b pool without internet", false, () => this.isolatedBoot()],
      [
        "3 templates",
        true,
        async () => {
          this.writeProject();
          await this.startDependencyServer();
          first = await this.firstStart();
          await this.dbReady();
          this.psql(
            "db-write",
            `CREATE TABLE qualification(v text); INSERT INTO qualification VALUES ('${marker}')`
          );
        },
      ],
      [
        "4 disk identity",
        false,
        async () => {
          identity = await this.diskChecks();
        },
      ],
      ["5 lifecycle", false, () => this.lifecycle(first, marker)],
      [
        "6 network modes",
        false,
        async () => {
          // The second home boots only while the project pool is stopped, so host memory
          // admission never has to fit both pools.
          await this.ensureDown("down-before-network");
          this.stopMainPool("network");
          this.networkModes();
        },
      ],
      [
        "7 mount-socket",
        false,
        async () => {
          const ready = await this.upForeground("up-relay", "up");
          this.relay("relay");
          await this.upForeground(
            "restart-relay",
            "restart",
            readyContainer(ready.ps)
          );
          this.relay("relay-after-restart");
        },
      ],
      [
        "8 rosetta",
        false,
        async () => {
          await this.ensureDown("down-before-rosetta");
          this.stopMainPool("rosetta");
          this.rosetta();
        },
      ],
      ["9 web+db", false, () => this.webAndDatabase(marker, identity)],
      [
        "10 measurements",
        false,
        async () => {
          await this.idle();
          this.check(
            "disk identity is unchanged after the idle period",
            JSON.stringify(this.diskIdentity()) === JSON.stringify(identity)
          );
          this.measure(
            "final_down_seconds",
            round(await this.down("down-final"))
          );
        },
      ],
      ["11 unclean stop (recorded)", false, () => this.uncleanStop(identity)],
    ];
    const failed = await this.runSteps(steps);
    if (failed !== null) {
      return failed;
    }
    this.step = "cleanup";
    this.stopAll("cleanup");
    const children = this.foreground
      ? [...this.strays, this.foreground]
      : [...this.strays];
    // Only this run's own children, after every pool was asked to stop.
    const lingering = await this.alive(children, this.exitWaitMs);
    if (lingering.length > 0) {
      this.record(
        "foregrounds_terminated_at_cleanup",
        lingering.map((child) => this.identity(child))
      );
      for (const child of lingering) {
        child.kill("SIGTERM");
      }
    }
    // Pools asked to stop must be gone: one still running fails the run and is listed.
    let left: string[];
    try {
      left = await this.lingeringProviders();
    } catch (error) {
      left = [
        `not shown: ${error instanceof Error ? error.message : String(error)}`,
      ];
    }
    this.record("providers_running_at_exit", left);
    if (left.length > 0) {
      this.failed.push(
        `cleanup: provider processes still running after runtime down: ${left.join(", ")}`
      );
    }
    this.dependencyServer?.kill("SIGTERM");
    writeFileSync(
      join(this.evidence, "qualification.json"),
      JSON.stringify(
        {
          passed: this.passed,
          failed: this.failed,
          recorded: this.recorded,
          measurements: this.measurements,
        },
        null,
        2
      )
    );
    if (this.failed.length > 0) {
      for (const line of this.failed) {
        console.log(`FAIL ${line}`);
      }
      console.log(
        `${this.failed.length} check(s) failed${this.options.keepGoing ? " (--keep-going)" : ""}; evidence in ${this.evidence}.`
      );
      return 1;
    }
    this.note(
      "PASS all checks; every pool was asked to stop. Recovery outcomes are recorded, not checked: read `recorded` in qualification.json. Remove the root yourself once the evidence is copied."
    );
    return 0;
  }

  /**
   * Run the steps in order. Returns the exit code when a failure ends the run, or null when
   * every step ran or was recorded as failed or skipped under --keep-going.
   */
  async runSteps(
    steps: [string, boolean, () => Promise<void> | void][]
  ): Promise<number | null> {
    for (const [name, required, step] of steps) {
      this.step = name;
      this.stepRequired = required;
      if (this.blocked) {
        this.failed.push(`${name}: skipped: ${this.blocked}`);
        this.note(`SKIP ${name}: ${this.blocked}`);
        continue;
      }
      const failuresBefore = this.failed.length;
      try {
        await step();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!this.options.keepGoing || required) {
          return this.fail(message);
        }
        this.failed.push(`${name}: ${message}`);
        this.note(`FAIL ${name}: ${message} (continuing: --keep-going)`);
      }
      if (this.failed.length > failuresBefore) {
        await this.settle(name);
      }
    }
    return null;
  }

  fail(message: string): number {
    writeFileSync(
      join(this.evidence, "failure.json"),
      JSON.stringify(
        {
          step: this.step,
          failure: message,
          failed: this.failed,
          passed: this.passed,
          recorded: this.recorded,
          measurements: this.measurements,
        },
        null,
        2
      )
    );
    console.log(`FAIL ${this.step}: ${message}`);
    console.log(
      `Nothing was stopped or removed. Stop the pools with: ${this.options.native} --candidate-root <home> runtime down --json for ${this.main}, ${this.aux} and ${this.isolated}; the dependency listener is PID ${this.dependencyServer?.pid ?? "none"}; foregrounds of this run: ${[...this.strays, ...(this.foreground ? [this.foreground] : [])].map((child) => child.pid).join(", ") || "none"}.`
    );
    return 1;
  }

  /** Record an observed behaviour that is reported, not asserted. */
  record(name: string, value: unknown): void {
    this.recorded[name] = value;
    this.note(`RECORD ${this.step}: ${name} = ${JSON.stringify(value)}`);
  }

  /** `hack down` for the project when a run may be up; a project already down is fine. */
  async ensureDown(name: string): Promise<void> {
    if (this.running() || this.observedReady()) {
      await this.down(name);
    }
  }

  // 5. Restart, down and up, then a lost foreground: what the release does is recorded.
  async lifecycle(
    first: Record<string, unknown>,
    marker: string
  ): Promise<void> {
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

    // A lost foreground: this run's own child, killed. The release's answer to
    // `down --recover` is recorded; if it refuses, its documented recovery (plain `down`,
    // then `restart --recover-frontend`, then `down`) is followed and recorded too.
    const lost = this.running();
    lost?.kill("SIGKILL");
    await lost?.exited;
    this.foreground = null;
    const recovered = this.hack(
      "down-recover",
      ["down", "--recover", "--path", this.project],
      300,
      true
    );
    this.record("down_recover_after_lost_foreground_exit", recovered.code);
    if (recovered.code !== 0) {
      const plain = this.hack(
        "down-after-lost-foreground",
        ["down", "--path", this.project],
        300,
        true
      );
      this.record("plain_down_after_lost_foreground_exit", plain.code);
      const attempt = /--expect-finalization-attempt ([0-9a-f]+)/.exec(
        plain.stderr + plain.stdout
      )?.[1];
      this.record("recover_frontend_attempt_offered", attempt !== undefined);
      if (attempt) {
        const resumed = await this.upForeground(
          "restart-recover-frontend",
          "restart",
          null,
          ["--recover-frontend", "--expect-finalization-attempt", attempt]
        );
        this.record("recover_frontend_to_ready_seconds", resumed.seconds);
        await this.down("down-after-frontend-recovery");
      }
    }
    this.check(
      "the run whose foreground was lost is retired (down --recover or the documented recovery)",
      !this.observedReady()
    );
    await this.upForeground("up-after-recover", "up");
  }

  // 9. The web and database project after every earlier step.
  async webAndDatabase(
    marker: string,
    identity: Record<string, { size: number; ino: number; dev: number }>
  ): Promise<void> {
    await this.upForeground("up-web-db", "up");
    await this.dbReady();
    this.check(
      "the database row survives every restart and recovery",
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
    const record = this.machineRecord(this.main);
    this.check(
      "the project pool record keeps every newer capability inert",
      activeFields(record, INERT_RECORD_FIELDS).length === 0,
      activeFields(record, INERT_RECORD_FIELDS).join(",")
    );
    this.check(
      "disk identity is unchanged at the end",
      JSON.stringify(this.diskIdentity()) === JSON.stringify(identity)
    );
  }

  // 11. An unclean stop of the provider VM, last because the release may not recover from it:
  // every answer is recorded, nothing is asserted.
  async uncleanStop(
    identity: Record<string, { size: number; ino: number; dev: number }>
  ): Promise<void> {
    await this.upForeground("up-before-unclean", "up");
    const providers = realpathSync(join(this.main, ".hack-local/providers"));
    const recorded = this.owner(this.main).process as
      | Record<string, unknown>
      | undefined;
    const pid = Number(recorded?.pid);
    const executable = String(recorded?.executable ?? "");
    const listed = this.processes(this.main).find((row) => row.pid === pid);
    const owned =
      Number.isInteger(pid) &&
      pid > 1 &&
      executable.startsWith(`${providers}/smolvm-`) &&
      listed !== undefined;
    this.check(
      "the receipt's provider runs from this home's provider tree",
      owned,
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
    const same =
      Number(uid) === Number(recorded?.uid) &&
      Number.isFinite(startedMs) &&
      Math.abs(startedMs - recordedMs) < 2000;
    this.check(
      "the live provider matches the receipt's user and start time",
      same,
      `${live} vs uid ${String(recorded?.uid)} start ${recordedMs}`
    );
    // Never signal a process that did not verify, even when --keep-going continues.
    if (!(owned && same)) {
      throw new Failure(
        "provider identity did not verify; nothing was signalled"
      );
    }
    process.kill(pid, "SIGKILL");
    for (
      let attempt = 0;
      attempt < 120 && this.processes(this.main).some((row) => row.pid === pid);
      attempt++
    ) {
      await Bun.sleep(500);
    }
    // The foreground is not signalled: whether it notices the lost provider is recorded.
    const code = await Promise.race([
      this.running()?.exited,
      Bun.sleep(120_000).then(() => "still running after 120 s"),
    ]);
    this.record("foreground_after_unclean_stop", String(code));
    const after = this.running();
    if (after && after.exitCode === null && after.signalCode === null) {
      this.strays.push(after);
    }
    this.foreground = null;
    const retired = this.hack(
      "down-recover-after-unclean",
      ["down", "--recover", "--path", this.project],
      300,
      true
    );
    this.record("down_recover_after_unclean_stop_exit", retired.code);
    const recover = this.exec(
      "runtime-recover",
      [
        this.options.native,
        "--candidate-root",
        this.main,
        "runtime",
        "recover",
        "--json",
      ],
      { timeout: 300, allowFailure: true }
    );
    this.record("runtime_recover_exit", recover.code);
    const status = this.exec(
      "runtime-status-after-recover",
      [
        this.options.native,
        "--candidate-root",
        this.main,
        "runtime",
        "status",
        "--json",
      ],
      { timeout: 60, allowFailure: true }
    );
    this.record(
      "runtime_status_after_recover",
      status.code === 0
        ? (JSON.parse(status.stdout) as Record<string, unknown>).phase
        : `exit ${status.code}`
    );
    const up = this.hack(
      "up-d-after-unclean",
      ["up", "-d", "--path", this.project],
      900,
      true
    );
    this.record("up_d_after_unclean_stop_exit", up.code);
    if (up.code === 0) {
      this.record(
        "disk_identity_unchanged_after_unclean_stop",
        JSON.stringify(this.diskIdentity()) === JSON.stringify(identity)
      );
    }
  }

  networkModes(): void {
    const [first, second] = this.options.approvedHosts;
    const mainRecord = this.machineRecord(this.main);
    // Recorded, not asserted: the frontend chooses the project pool's network.
    this.record("project_pool_network", {
      network: mainRecord.network,
      network_backend: mainRecord.network_backend ?? null,
      allowed_cidrs: mainRecord.allowed_cidrs ?? null,
      dns_filter_hosts: mainRecord.dns_filter_hosts ?? null,
    });
    this.runtime(
      this.aux,
      "aux-up-approved",
      [
        "runtime",
        "up",
        "--profile",
        this.options.profile,
        "--allow-host",
        first,
        "--json",
      ],
      600
    );
    let record = this.machineRecord(this.aux);
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
    record = this.machineRecord(this.aux);
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
    record = this.machineRecord(this.aux);
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
      [
        "runtime",
        "up",
        "--profile",
        this.options.profile,
        "--internet",
        "--json",
      ],
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
      activeFields(this.machineRecord(this.aux), INERT_RECORD_FIELDS).length ===
        0
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
        this.options.profile,
        "--internet",
        "--amd64-emulation",
        "--json",
      ],
      600
    );
    const record = this.machineRecord(this.aux);
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

/** A JSON object printed by a command, or null when it printed anything else. */
export function readJson(stdout: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(stdout);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
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
      "2a prepared base",
      "2b pool without internet",
      "3 templates",
      "4 disk identity",
      "5 lifecycle",
      "6 network modes",
      "7 mount-socket",
      "8 rosetta",
      "9 web+db",
      "10 measurements",
      "11 unclean stop (recorded)",
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
