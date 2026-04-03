import { pathExists } from "./fs.ts";
import {
  findHackLocalCaCertPath,
  resolveHackHostTrustBundlePath,
  resolveHackHostTrustEnvScriptPath,
} from "./local-ca.ts";
import { exec } from "./shell.ts";

export async function checkMacHostTlsTrust(input?: {
  readonly certPath?: string | null;
  readonly bundlePath?: string;
  readonly envScriptPath?: string;
  readonly pathExists?: typeof pathExists;
  readonly exec?: typeof exec;
}): Promise<{
  readonly name: string;
  readonly status: "ok" | "warn";
  readonly message: string;
}> {
  const pathExistsFn = input?.pathExists ?? pathExists;
  const execFn = input?.exec ?? exec;
  const certPath = input?.certPath ?? (await findHackLocalCaCertPath());
  if (!certPath) {
    return {
      name: "host tls trust",
      status: "warn",
      message: "Missing Caddy Local CA (run: hack doctor --fix)",
    };
  }

  const issues: string[] = [];
  const keychainTrust = await execFn(
    [
      "security",
      "find-certificate",
      "-c",
      "Caddy Local Authority",
      "/Library/Keychains/System.keychain",
    ],
    { stdin: "ignore" }
  );
  if (keychainTrust.exitCode !== 0) {
    issues.push("macOS System keychain trust missing");
  }

  const bundlePath = input?.bundlePath ?? resolveHackHostTrustBundlePath();
  if (!(await pathExistsFn(bundlePath))) {
    issues.push(`missing ${bundlePath}`);
  }

  const envScriptPath =
    input?.envScriptPath ?? resolveHackHostTrustEnvScriptPath();
  if (!(await pathExistsFn(envScriptPath))) {
    issues.push(`missing ${envScriptPath}`);
  }

  return {
    name: "host tls trust",
    status: issues.length > 0 ? "warn" : "ok",
    message:
      issues.length > 0
        ? `${issues.join("; ")} (run: hack doctor --fix)`
        : `Ready (${envScriptPath})`,
  };
}
