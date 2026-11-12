import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { readTextFile } from "./fs.ts";
import type { LinuxTrustHost } from "./linux-trust-setup.ts";
import { runTrustedSudo } from "./privileged-sudo.ts";
import { exec } from "./shell.ts";
import { vettedHelperEnv } from "./vetted-env.ts";

const CERTUTIL_TIMEOUT_MS = 10_000;
const FALLBACK_DIRS = ["/usr/sbin", "/sbin", "/usr/bin", "/bin"] as const;
const SPAWN_FAILED = { exitCode: 127, stdout: "" } as const;

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    if (!info.isFile()) {
      return false;
    }
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Absolute path of `name`: the first executable regular file on PATH, then
 * the usual sbin/bin directories (tools such as update-ca-certificates live
 * in /usr/sbin, which a user PATH may omit). The returned path is the one
 * executed, so discovery and execution cannot disagree.
 */
export async function resolveExecutable(
  name: string,
  pathEnv: string | undefined = process.env.PATH
): Promise<string | null> {
  const dirs = [
    ...(pathEnv ?? "").split(delimiter).filter((dir) => isAbsolute(dir)),
    ...FALLBACK_DIRS,
  ];
  for (const dir of dirs) {
    const candidate = join(dir, name);
    if (await isExecutableFile(candidate)) {
      return candidate;
    }
  }
  return null;
}

/**
 * Real host boundary: reads files, runs `certutil` (by absolute path) as the
 * current user, and runs root steps as `sudo <argv>` with the terminal
 * attached.
 */
export function createLinuxTrustHost(opts?: {
  readonly homeDir?: string;
}): LinuxTrustHost {
  const homeDir = opts?.homeDir ?? homedir();
  const xdgConfig = process.env.XDG_CONFIG_HOME;
  const xdgData = process.env.XDG_DATA_HOME;
  return {
    homeDir,
    configHome:
      xdgConfig && isAbsolute(xdgConfig) ? xdgConfig : join(homeDir, ".config"),
    dataHome:
      xdgData && isAbsolute(xdgData)
        ? xdgData
        : join(homeDir, ".local", "share"),
    uid: process.getuid?.() ?? -1,
    readFile: async (path) => await readTextFile(path),
    listDir: async (path) => {
      try {
        return await readdir(path);
      } catch {
        return [];
      }
    },
    inspectPath: async (path) => {
      try {
        const entry = await lstat(path);
        if (entry.isSymbolicLink()) {
          // Keep dangling links observable so initialization cannot follow one.
          try {
            await realpath(path);
          } catch {
            return {
              realPath: path,
              uid: entry.uid,
              mode: entry.mode,
              identity: `${entry.dev}:${entry.ino}`,
              isDirectory: false,
              isFile: false,
            };
          }
        }
        const realPath = await realpath(path);
        const info = await stat(realPath);
        return {
          realPath,
          uid: info.uid,
          mode: info.mode,
          isDirectory: info.isDirectory(),
          isFile: info.isFile() && !entry.isSymbolicLink(),
          identity: `${info.dev}:${info.ino}`,
        };
      } catch {
        return null;
      }
    },
    makeDir: async (path) => {
      try {
        await mkdir(path, { recursive: true, mode: 0o700 });
        return true;
      } catch {
        return false;
      }
    },
    resolveCommand: async (name) => await resolveExecutable(name),
    exec: async (argv, input) => {
      try {
        const res = await exec(argv, {
          ...vettedHelperEnv(),
          stdin: input === undefined ? "ignore" : new Blob([input]),
          timeoutMs: CERTUTIL_TIMEOUT_MS,
        });
        return { exitCode: res.exitCode, stdout: res.stdout };
      } catch {
        return SPAWN_FAILED;
      }
    },
    runPrivileged: async (argv, input) =>
      await runTrustedSudo(argv, {
        input:
          input === undefined ? undefined : new TextEncoder().encode(input),
      }),
  };
}
