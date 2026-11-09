import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  realpath,
  rmdir,
  unlink,
} from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

const KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PREFIX = "hack-mux-env-";
const MAX_BYTES = 1024 * 1024;

/** The pane consumes and deletes this one-shot, owner-only payload before spawning. */
export async function stageMuxEnvironment(
  env: Readonly<Record<string, string>>
) {
  if (
    Object.entries(env).some(
      ([key, value]) => !KEY.test(key) || value.includes("\0")
    )
  ) {
    throw new Error("Invalid mux environment; values omitted");
  }
  const bytes = JSON.stringify(env);
  if (Buffer.byteLength(bytes) > MAX_BYTES) {
    throw new Error("Mux environment exceeds the private input limit");
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), PREFIX)));
  const path = join(root, "env.json");
  let identity: { dev: number; ino: number } | undefined;
  const cleanup = async () => {
    const current = await lstat(path).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return undefined;
      }
      throw error;
    });
    if (current) {
      if (
        !identity ||
        current.dev !== identity.dev ||
        current.ino !== identity.ino
      ) {
        throw new Error("Private mux input was replaced; cleanup refused");
      }
      await unlink(path);
    }
    await rmdir(root).catch((error: unknown) => {
      if (
        !(error instanceof Error && "code" in error && error.code === "ENOENT")
      ) {
        throw error;
      }
    });
  };
  try {
    const file = await open(path, "wx", 0o600);
    try {
      identity = await file.stat();
      await file.writeFile(bytes);
    } finally {
      await file.close();
    }
    return { path, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

/** Read only a bounded private payload; never emit values in diagnostics or argv. */
export async function runMuxEnvironment(
  path: string,
  args: readonly string[]
): Promise<number> {
  const root = dirname(path);
  if (
    !isAbsolute(path) ||
    basename(path) !== "env.json" ||
    !basename(root).startsWith(PREFIX)
  ) {
    return 1;
  }
  const parent = await lstat(root);
  if (
    !parent.isDirectory() ||
    parent.uid !== process.getuid?.() ||
    (parent.mode & 0o077) !== 0
  ) {
    return 1;
  }
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  let value: unknown;
  let identity: { dev: number; ino: number };
  try {
    const info = await file.stat();
    identity = info;
    if (
      !info.isFile() ||
      info.uid !== parent.uid ||
      info.nlink !== 1 ||
      (info.mode & 0o077) !== 0 ||
      info.size > MAX_BYTES
    ) {
      return 1;
    }
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead !== info.size || bytesRead > MAX_BYTES) {
      return 1;
    }
    value = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
  } finally {
    await file.close();
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return 1;
  }
  const env = new Map(Object.entries(process.env));
  for (const [key, entry] of Object.entries(value)) {
    if (!KEY.test(key) || typeof entry !== "string" || entry.includes("\0")) {
      return 1;
    }
    env.set(key, entry);
  }
  const command = applyCommandAssignments({ args, env });
  const current = await lstat(path);
  const currentParent = await lstat(root);
  if (
    current.dev !== identity.dev ||
    current.ino !== identity.ino ||
    currentParent.dev !== parent.dev ||
    currentParent.ino !== parent.ino
  ) {
    return 1;
  }
  await unlink(path);
  await rmdir(root);
  if (command.length === 0) {
    return 1;
  }
  return await runInForeground(command, env);
}

/** The terminal signals the whole foreground group, so the command already receives these. */
const TERMINAL_SIGNALS = ["SIGINT", "SIGQUIT"] as const;
/** Signals sent to this launcher alone; the command would have received them under exec. */
const FORWARDED_SIGNALS = ["SIGTERM", "SIGHUP"] as const;

/**
 * Stand in for `exec`: the pane shell waits on this launcher, so it stays alive
 * until the command exits, even when the command handles a terminal interrupt,
 * and then reports the command's own status.
 */
async function runInForeground(
  command: readonly string[],
  env: Map<string, string | undefined>
): Promise<number> {
  const ignore = () => undefined;
  for (const signal of TERMINAL_SIGNALS) {
    process.on(signal, ignore);
  }
  const forwards: [NodeJS.Signals, () => void][] = [];
  try {
    const child = Bun.spawn([...command], {
      env: Object.fromEntries(env),
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    for (const signal of FORWARDED_SIGNALS) {
      const forward = () => child.kill(signal);
      forwards.push([signal, forward]);
      process.on(signal, forward);
    }
    const code = await child.exited;
    if (child.signalCode) {
      return 128 + (osConstants.signals[child.signalCode] ?? 0);
    }
    return code;
  } finally {
    for (const signal of TERMINAL_SIGNALS) {
      process.off(signal, ignore);
    }
    for (const [signal, forward] of forwards) {
      process.off(signal, forward);
    }
  }
}

/** These assignments are authored command text, already tokenized by the pane shell. */
function applyCommandAssignments(opts: {
  readonly args: readonly string[];
  readonly env: Map<string, string | undefined>;
}): readonly string[] {
  let first = 0;
  for (const arg of opts.args) {
    const equals = arg.indexOf("=");
    if (equals < 1 || !KEY.test(arg.slice(0, equals))) {
      break;
    }
    opts.env.set(arg.slice(0, equals), arg.slice(equals + 1));
    first++;
  }
  return opts.args.slice(first);
}
