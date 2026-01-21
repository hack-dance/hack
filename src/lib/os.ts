import { exec } from "./shell.ts";

export function isMac(): boolean {
  return process.platform === "darwin";
}

export async function openUrl(url: string): Promise<number> {
  const cmd = buildOpenUrlCommand(url);
  const res = await exec(cmd, { stdin: "ignore" });
  return res.exitCode;
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
