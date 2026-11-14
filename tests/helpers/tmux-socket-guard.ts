import childProcess from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname, isAbsolute } from "node:path";

const privateRoots = new Set<string>();
let installed = false;
const nativeSpawnSync = Bun.spawnSync.bind(Bun);

/** Fixed read-only probe: the state guard must still see Bun's native env. */
export function probeNativeTestEnvironment() {
  return nativeSpawnSync(["/usr/bin/env", "-0"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
}

/** Every child inherits a private socket, even with an otherwise minimal env. */
function isolatedChildEnv(
  input?: Record<string, string | undefined>
): Record<string, string | undefined> {
  const env = { ...(input ?? process.env) };
  const root = env.TMUX_TMPDIR ?? process.env.TMUX_TMPDIR;
  assertPrivateTmuxSocket(["tmux", "list-sessions"], { TMUX_TMPDIR: root });
  env.TMUX_TMPDIR = root;
  Reflect.deleteProperty(env, "TMUX");
  return env;
}

/** Parse only client options, never session names or keys after the command. */
function explicitSocket(command: readonly string[]): string | undefined {
  let socket: string | undefined;
  for (let index = 1; index < command.length; index++) {
    const argument = command[index] ?? "";
    if (!argument.startsWith("-")) {
      break;
    }
    if (["-u", "-2", "-8", "-C", "-D", "-N", "-v", "-V"].includes(argument)) {
      continue;
    }
    if (["-S", "-L", "-f"].includes(argument)) {
      const value = command[++index];
      if (
        !value ||
        (argument === "-S" && (socket !== undefined || !isAbsolute(value)))
      ) {
        throw new Error(
          "[tmux-socket-guard] invalid or repeated socket option."
        );
      }
      if (argument === "-S") {
        socket = value;
      }
      continue;
    }
    throw new Error(
      "[tmux-socket-guard] unsupported client option; use separate explicit options."
    );
  }
  return socket;
}

/** Register only a directory the calling fixture just created and owns. */
export function registerPrivateTmuxRoot(root: string): () => void {
  const canonical = realpathSync(root);
  privateRoots.add(canonical);
  return () => privateRoots.delete(canonical);
}

/** Refuse default-socket access before a tmux client is started by a test. */
export function assertPrivateTmuxSocket(
  command: readonly string[],
  env: Readonly<Record<string, string | undefined>>
): void {
  if (basename(command[0] ?? "") !== "tmux") {
    return;
  }
  const socket = explicitSocket(command);
  const root = socket ? dirname(socket) : env.TMUX_TMPDIR;
  if ((!socket && env.TMUX) || !root || !isAbsolute(root)) {
    throw new Error(
      "[tmux-socket-guard] tmux requires a private socket directory; inherited TMUX is refused."
    );
  }
  const info = lstatSync(root);
  if (
    !(privateRoots.has(realpathSync(root)) && info.isDirectory()) ||
    (info.mode & 0o077) !== 0 ||
    info.uid !== process.getuid?.()
  ) {
    throw new Error(
      "[tmux-socket-guard] socket directory must be registered by its fixture, owned by this user and private (0700)."
    );
  }
}

/** Install before the global-state baseline; cover both Bun spawn overloads. */
export function installTmuxSocketGuard(): void {
  if (installed) {
    return;
  }
  installed = true;
  for (const key of ["spawn", "spawnSync"] as const) {
    const original = Bun[key];
    const guarded = function (this: unknown, ...args: unknown[]) {
      const first = args[0];
      const options = Array.isArray(first) ? args[1] : first;
      const record = options as
        | { cmd?: string[]; env?: Record<string, string | undefined> }
        | undefined;
      const command = Array.isArray(first) ? first : record?.cmd;
      if (command) {
        // Without explicit env Bun can use its startup snapshot. Validate
        // exactly what the child will receive, including after a preload
        // replaced inherited TMUX/TMUX_TMPDIR.
        const env = isolatedChildEnv(record?.env);
        assertPrivateTmuxSocket(command, env);
        const optionsWithEnv = { ...record, env };
        const forwarded = Array.isArray(first)
          ? [first, optionsWithEnv]
          : [optionsWithEnv];
        return Reflect.apply(original, this, forwarded);
      }
      return Reflect.apply(original, this, args);
    };
    // Bun's overloaded generic spawn signatures cannot express this forwarding wrapper.
    Object.assign(Bun, { [key]: guarded });
  }
  installNodeChildIsolation();
}

/** Node runners with literal envs need the same containment as Bun runners. */
function installNodeChildIsolation(): void {
  for (const key of [
    "spawn",
    "spawnSync",
    "execFile",
    "execFileSync",
    "exec",
    "execSync",
    "fork",
  ] as const) {
    const original = childProcess[key];
    const guarded = function (this: unknown, ...args: unknown[]) {
      const shell = key === "exec" || key === "execSync";
      const index = !shell && Array.isArray(args[1]) ? 2 : 1;
      const value = args[index];
      const options =
        typeof value === "object" && value !== null
          ? (value as { env?: Record<string, string | undefined> })
          : undefined;
      const env = isolatedChildEnv(options?.env);
      validateNodeCommand({ shell, args, env });
      const forwarded = [...args];
      if (typeof value === "function") {
        forwarded.splice(index, 0, { env });
      } else {
        forwarded[index] = { ...options, env };
      }
      return Reflect.apply(original, this, forwarded);
    };
    Object.assign(childProcess, { [key]: guarded });
  }
  syncBuiltinESMExports();
}

function validateNodeCommand(opts: {
  shell: boolean;
  args: unknown[];
  env: Record<string, string | undefined>;
}): void {
  if (!opts.shell && typeof opts.args[0] === "string") {
    const argv = Array.isArray(opts.args[1]) ? opts.args[1] : [];
    assertPrivateTmuxSocket([opts.args[0], ...argv], opts.env);
  }
}
