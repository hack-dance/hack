import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readTextFile } from "./fs.ts";
import type { LinuxTrustHost } from "./linux-trust-setup.ts";
import { exec, findExecutableInPath, run } from "./shell.ts";

const CERTUTIL_TIMEOUT_MS = 10_000;
const PATH_SBIN = ["/usr/sbin", "/sbin", "/usr/bin", "/bin"] as const;

/**
 * Real host boundary: reads files, runs `certutil` as the current user, and
 * runs root steps as `sudo <argv>` with the terminal attached.
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
    readFile: async (path) => await readTextFile(path),
    makeDir: async (path) => {
      try {
        await mkdir(path, { recursive: true, mode: 0o700 });
        return true;
      } catch {
        return false;
      }
    },
    listDir: async (path) => {
      try {
        return await readdir(path);
      } catch {
        return [];
      }
    },
    hasCommand: async (name) =>
      findExecutableInPath(name) !== null ||
      (await Promise.all(
        PATH_SBIN.map((dir) => Bun.file(`${dir}/${name}`).exists())
      ).then((found) => found.some(Boolean))),
    exec: async (argv) => {
      const res = await exec(argv, {
        stdin: "ignore",
        timeoutMs: CERTUTIL_TIMEOUT_MS,
      });
      return { exitCode: res.exitCode, stdout: res.stdout };
    },
    runPrivileged: async (argv) =>
      await run(["sudo", ...argv], { stdin: "inherit" }),
  };
}
