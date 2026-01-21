import { exec } from "./shell.ts";

export function isMac(): boolean {
  return process.platform === "darwin";
}

export async function openUrl(url: string): Promise<number> {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", url]
        : ["xdg-open", url];
  const res = await exec(cmd, { stdin: "ignore" });
  return res.exitCode;
}
