import { exec, findExecutableInPath } from "./shell.ts";

export function isMac(): boolean {
  return process.platform === "darwin";
}

export function isLinux(): boolean {
  return process.platform === "linux";
}

export async function openUrl(url: string): Promise<number> {
  const cmd = buildOpenUrlCommand(url);
  const res = await exec(cmd, { stdin: "ignore" });
  return res.exitCode;
}

/**
 * Whether this machine has the program {@link openUrl} runs. Servers,
 * containers and cloud sandboxes usually have no `xdg-open`; callers then
 * print the URL instead of failing on a missing executable.
 */
export function urlOpenerAvailable(
  opts: {
    readonly platform?: NodeJS.Platform;
    readonly which?: (name: string) => string | null;
  } = {}
): boolean {
  const platform = opts.platform ?? process.platform;
  if (platform === "darwin" || platform === "win32") {
    return true;
  }
  return (opts.which ?? findExecutableInPath)("xdg-open") !== null;
}

function buildOpenUrlCommand(url: string): string[] {
  const platform = process.platform;
  if (platform === "darwin") {
    return ["open", url];
  }
  if (platform === "win32") {
    return ["cmd", "/c", "start", url];
  }
  return ["xdg-open", url];
}
