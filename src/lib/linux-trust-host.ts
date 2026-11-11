import { constants } from "node:fs";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { readTextFile } from "./fs.ts";
import type { LinuxTrustHost } from "./linux-trust-setup.ts";
import { exec, run } from "./shell.ts";

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

/** A private (0700 dir, 0600 file) copy of `content`; `cleanup` removes it. */
export async function stagePrivateCopy(opts: {
  readonly content: string;
  readonly fileName: string;
}): Promise<{ readonly path: string; readonly cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "hack-trust-"));
  await chmod(dir, 0o700);
  const path = join(dir, opts.fileName);
  await writeFile(path, opts.content, { mode: 0o600, flag: "wx" });
  return {
    path,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
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
  return {
    homeDir,
    configHome:
      xdgConfig && isAbsolute(xdgConfig) ? xdgConfig : join(homeDir, ".config"),
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
        const realPath = await realpath(path);
        const info = await stat(realPath);
        return {
          realPath,
          uid: info.uid,
          mode: info.mode,
          isDirectory: info.isDirectory(),
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
    exec: async (argv) => {
      try {
        const res = await exec(argv, {
          stdin: "ignore",
          timeoutMs: CERTUTIL_TIMEOUT_MS,
        });
        return { exitCode: res.exitCode, stdout: res.stdout };
      } catch {
        return SPAWN_FAILED;
      }
    },
    runPrivileged: async (argv) => {
      try {
        return await run(["sudo", ...argv], { stdin: "inherit" });
      } catch {
        return SPAWN_FAILED.exitCode;
      }
    },
  };
}
