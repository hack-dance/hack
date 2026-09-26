import { pathExists, readTextFile } from "./fs.ts";
import {
  findHackLocalCaCertPath,
  resolveHackHostTrustBundlePath,
  resolveHackHostTrustEnvScriptPath,
} from "./local-ca.ts";
import { checkMacCaTrust, containsCertificate } from "./mac-ca-trust.ts";
import { exec } from "./shell.ts";

export async function checkMacHostTlsTrust(input?: {
  readonly certPath?: string | null;
  readonly bundlePath?: string;
  readonly envScriptPath?: string;
  readonly pathExists?: typeof pathExists;
  readonly exec?: typeof exec;
  readonly readTextFile?: typeof readTextFile;
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
  const keychainTrust = await checkMacCaTrust({
    certPath,
    exec: execFn,
    readTextFile: input?.readTextFile,
  });
  if (!keychainTrust.trusted) {
    issues.push(keychainTrust.issue ?? "macOS TLS trust verification failed");
  }

  const bundlePath = input?.bundlePath ?? resolveHackHostTrustBundlePath();
  if (!(await pathExistsFn(bundlePath))) {
    issues.push(`missing ${bundlePath}`);
  } else if (
    keychainTrust.certificate &&
    !containsCertificate({
      pem: (await (input?.readTextFile ?? readTextFile)(bundlePath)) ?? "",
      certificate: keychainTrust.certificate,
    })
  ) {
    issues.push("host trust bundle is missing the current Caddy Local CA");
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
