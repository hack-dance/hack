import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";

const privateRoots = new Set<string>();
let installed = false;

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
      if (command && basename(command[0] ?? "") === "tmux") {
        // Without explicit env Bun can use its startup snapshot. Validate
        // exactly what the child will receive, including after a preload
        // replaced inherited TMUX/TMUX_TMPDIR.
        const env = record?.env ?? { ...process.env };
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
}
