import { chmod, mkdir, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { isRecord } from "../../src/lib/guards.ts";
import { findExecutableInPath } from "../../src/lib/shell.ts";

const LIMIT = 64 * 1024;
const MAX_QUERIES = 2048;
const REFUSAL = "Initial process-policy trace unavailable; values omitted";
const ID = /^[a-f0-9]{64}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const TOKEN = /^[a-f0-9]{32}$/;
const KINDS = ["container", "volume", "network"] as const;
type Kind = (typeof KINDS)[number];

// Exact production ownership projections only. No environment, command, image
// configuration, arbitrary label map, raw inspect or daemon stderr is recorded.
export const processPolicyInitialTraceFormats = {
  container: {
    list: '{"id":{{json .ID}},"name":{{json .Names}},"project":{{json (.Label "com.docker.compose.project")}}}',
    inspect: '{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"version":{{json (index .Config.Labels "io.hack.native-config.version")}},"instance":{{json (index .Config.Labels "io.hack.native-config.instance")}},"owner":{{json (index .Config.Labels "io.hack.native-config.owner")}},"generation":{{json (index .Config.Labels "io.hack.native-config.generation")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"oneoff":{{json (index .Config.Labels "com.docker.compose.oneoff")}},"state":{{json .State.Status}},"exitCode":{{json .State.ExitCode}},"health":{{with (index .State "Health")}}{{json .Status}}{{else}}null{{end}},"networks":{{json .NetworkSettings.Networks}}}',
  },
  volume: {
    list: '{"id":{{json .Name}},"name":{{json .Name}},"project":{{json (.Label "com.docker.compose.project")}}}',
    inspect: '{"id":{{json .Name}},"name":{{json .Name}},"project":{{json (index .Labels "com.docker.compose.project")}},"version":{{json (index .Labels "io.hack.native-config.version")}},"instance":{{json (index .Labels "io.hack.native-config.instance")}},"owner":{{json (index .Labels "io.hack.native-config.owner")}},"storage":{{json (index .Labels "io.hack.native-config.storage")}},"createdAt":{{json .CreatedAt}}}',
  },
  network: {
    list: '{"id":{{json .ID}},"name":{{json .Name}},"project":{{json (.Label "com.docker.compose.project")}}}',
    inspect: '{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Labels "com.docker.compose.project")}},"version":{{json (index .Labels "io.hack.native-config.version")}},"instance":{{json (index .Labels "io.hack.native-config.instance")}},"owner":{{json (index .Labels "io.hack.native-config.owner")}},"driver":{{json .Driver}},"internal":{{json .Internal}},"containers":{{json .Containers}}}',
  },
} as const;

function equal(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Admit the original owner's six fixed read protocols, never an arbitrary format. */
export function processPolicyInitialTraceQuery(args: readonly string[]): {
  readonly kind: Kind;
  readonly action: "ls" | "inspect";
} | null {
  const kind = KINDS.find((value) => value === args[0]);
  if (!kind) {
    return null;
  }
  if (args[1] === "ls") {
    const expected = [
      kind,
      "ls",
      ...(kind === "container" ? ["--all"] : []),
      ...(kind === "volume" ? [] : ["--no-trunc"]),
      "--format",
      processPolicyInitialTraceFormats[kind].list,
    ];
    return equal(args, expected) ? { kind, action: "ls" } : null;
  }
  const ids = args.slice(4);
  return args[1] === "inspect" &&
    args[2] === "--format" &&
    args[3] === processPolicyInitialTraceFormats[kind].inspect &&
    ids.length > 0 &&
    ids.length <= 64 &&
    ids.every((id) => (kind === "volume" ? NAME : ID).test(id)) &&
    new Set(ids).size === ids.length
    ? { kind, action: "inspect" }
    : null;
}

type BinaryPin = { readonly path: string; readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number };
type ForwarderOptions = {
  readonly directory: string;
  readonly binary: BinaryPin;
};
export type ProcessPolicyInitialTraceQuery = {
  readonly token: string;
  readonly startedAt: number;
  readonly startedNs: string;
  readonly reapedAt: number;
  readonly args: readonly string[];
  readonly stdout: string;
  readonly exitCode: number;
};

async function writePrivate(path: string, value: unknown): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
  } finally {
    await handle.close();
  }
}

/** Fixture-only forwarding preserves original bytes/exit and performs no extra Docker query. */
export async function runProcessPolicyInitialTraceForwarder(opts: ForwarderOptions): Promise<number> {
  const args = process.argv.slice(2);
  const current = await stat(opts.binary.path);
  if (!current.isFile() || current.dev !== opts.binary.dev || current.ino !== opts.binary.ino || current.size !== opts.binary.size || current.mtimeMs !== opts.binary.mtimeMs || current.ctimeMs !== opts.binary.ctimeMs) {
    throw new Error(REFUSAL);
  }
  const query = processPolicyInitialTraceQuery(args);
  const composeUp = args[0] === "compose" && args.includes("up");
  const token = crypto.randomUUID().replaceAll("-", "");
  const startedAt = Date.now();
  const startedNs = process.hrtime.bigint().toString();
  const path = join(opts.directory, `${token}.json`);
  let recorded = true;
  const record = async (suffix: string, value: unknown): Promise<void> => {
    try {
      if ((await readdir(opts.directory)).length > MAX_QUERIES * 3) {
        throw new Error(REFUSAL);
      }
      await writePrivate(`${path}.${suffix}`, value);
    } catch {
      recorded = false;
    }
  };
  if (query || composeUp) {
    await record("start", { token, startedAt, startedNs, kind: query?.kind ?? "compose-up", action: query?.action ?? "effect" });
  }
  const child = Bun.spawn([opts.binary.path, ...args], {
    stdin: "inherit",
    stdout: query ? "pipe" : "inherit",
    stderr: "inherit",
  });
  let reaped = false;
  const onInterrupt = (): void => { if (!reaped) { child.kill("SIGINT"); } };
  const onTerminate = (): void => { if (!reaped) { child.kill("SIGTERM"); } };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const exited = child.exited.then((code) => {
    reaped = true;
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    return code;
  });
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    if (query && child.stdout) {
      for await (const chunk of child.stdout) {
        await Bun.write(Bun.stdout, chunk);
        bytes += chunk.byteLength;
        if (bytes <= LIMIT) {
          chunks.push(chunk);
        }
      }
    }
    const exitCode = await exited;
    const reapedAt = Date.now();
    const reapedNs = process.hrtime.bigint().toString();
    if (query && bytes <= LIMIT) {
      await record("reply", { token, startedAt, startedNs, reapedAt, args, stdout: Buffer.concat(chunks).toString("utf8"), exitCode });
    }
    if (query || composeUp) {
      await record("reap", { token, reapedAt, reapedNs, exitCode, recorded: recorded && (!query || bytes <= LIMIT) });
    }
    return exitCode;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}

/** The initial up alone gets this shim; cleanup and later diagnostic probes keep the original PATH. */
export async function prepareProcessPolicyInitialTrace(opts: { readonly directory: string }) {
  const selected = findExecutableInPath("docker");
  if (!selected || !isAbsolute(selected)) {
    throw new Error(REFUSAL);
  }
  const path = await realpath(selected);
  const info = await stat(path);
  if (!info.isFile() || (info.mode & 0o111) === 0) {
    throw new Error(REFUSAL);
  }
  await mkdir(opts.directory, { mode: 0o700 });
  const replies = join(opts.directory, "replies");
  await mkdir(replies, { mode: 0o700 });
  const executable = join(opts.directory, "docker");
  const forwarder: ForwarderOptions = {
    directory: replies,
    binary: { path, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, ctimeMs: info.ctimeMs },
  };
  await Bun.write(executable, `#!${process.execPath} --no-env-file\nimport {runProcessPolicyInitialTraceForwarder} from ${JSON.stringify(import.meta.path)};\nprocess.exit(await runProcessPolicyInitialTraceForwarder(${JSON.stringify(forwarder)}));\n`);
  await chmod(executable, 0o700);
  return { path: `${opts.directory}:${process.env.PATH ?? ""}`, directory: replies };
}

/** Private replies are never returned by the public log summary. Missing/truncated pairs refuse replay. */
export async function readProcessPolicyInitialTrace(directory: string): Promise<{
  readonly queries: readonly ProcessPolicyInitialTraceQuery[];
  readonly upStartedNs: string;
  readonly upReapedNs: string;
}> {
  const names = await readdir(directory);
  if (names.length > MAX_QUERIES * 3) {
    throw new Error(REFUSAL);
  }
  const rows: ProcessPolicyInitialTraceQuery[] = [];
  const effects: { startedNs: string; reapedNs: string }[] = [];
  let total = 0;
  for (const name of names.filter((value) => value.endsWith(".json.start"))) {
    const token = name.slice(0, -".json.start".length);
    if (!TOKEN.test(token)) {
      throw new Error(REFUSAL);
    }
    const start: unknown = await Bun.file(join(directory, name)).json();
    const reap: unknown = await Bun.file(join(directory, `${token}.json.reap`)).json();
    if (!(isRecord(start) && isRecord(reap) && reap.recorded === true && start.token === token && reap.token === token)) {
      throw new Error(REFUSAL);
    }
    if (start.kind === "compose-up") {
      if (!(typeof start.startedNs === "string" && /^[0-9]{1,24}$/.test(start.startedNs) && typeof reap.reapedNs === "string" && /^[0-9]{1,24}$/.test(reap.reapedNs) && BigInt(reap.reapedNs) >= BigInt(start.startedNs))) {
        throw new Error(REFUSAL);
      }
      effects.push({ startedNs: start.startedNs, reapedNs: reap.reapedNs });
      continue;
    }
    const path = join(directory, `${token}.json.reply`);
    const size = (await stat(path)).size;
    total += size;
    if (size > LIMIT || total > 32 * 1024 * 1024) {
      throw new Error(REFUSAL);
    }
    const row: unknown = await Bun.file(path).json();
    if (!(isRecord(row) && row.token === token && Number.isFinite(row.startedAt) && Number.isFinite(row.reapedAt) && typeof row.startedAt === "number" && typeof row.reapedAt === "number" && row.reapedAt >= row.startedAt && typeof row.startedNs === "string" && /^[0-9]{1,24}$/.test(row.startedNs) && row.startedNs === start.startedNs && row.startedAt === start.startedAt && row.reapedAt === reap.reapedAt && row.exitCode === reap.exitCode && Array.isArray(row.args) && row.args.every((value: unknown) => typeof value === "string") && processPolicyInitialTraceQuery(row.args) && typeof row.stdout === "string" && Number.isInteger(row.exitCode) && typeof row.exitCode === "number" && row.exitCode >= 0 && row.exitCode <= 255)) {
      throw new Error(REFUSAL);
    }
    rows.push({ token, startedAt: row.startedAt, startedNs: row.startedNs, reapedAt: row.reapedAt, args: row.args, stdout: row.stdout, exitCode: row.exitCode });
  }
  if (names.length !== rows.length * 3 + effects.length * 2) {
    throw new Error(REFUSAL);
  }
  rows.sort((left, right) => BigInt(left.startedNs) < BigInt(right.startedNs) ? -1 : 1);
  if (new Set(rows.map((row) => row.startedNs)).size !== rows.length) {
    throw new Error(REFUSAL);
  }
  const effect = effects[0];
  if (effects.length !== 1 || !effect || rows.length === 0) {
    throw new Error(REFUSAL);
  }
  return { queries: rows, upStartedNs: effect.startedNs, upReapedNs: effect.reapedNs };
}
