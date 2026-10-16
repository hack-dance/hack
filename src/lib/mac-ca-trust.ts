import { X509Certificate } from "node:crypto";
import { readTextFile } from "./fs.ts";
import { exec } from "./shell.ts";

const SYSTEM_KEYCHAIN = "/Library/Keychains/System.keychain";
const PEM_CERTIFICATE =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

export function containsCertificate(input: {
  readonly pem: string;
  readonly certificate: X509Certificate;
}): boolean {
  return [...input.pem.matchAll(PEM_CERTIFICATE)].some(([pem]) => {
    try {
      return new X509Certificate(pem).raw.equals(input.certificate.raw);
    } catch {
      return false;
    }
  });
}

/** Check the exported CA itself, never a similarly named keychain entry.
 * Do not supply it as a verification anchor: that would manufacture trust.
 */
export async function checkMacCaTrust(input: {
  readonly certPath: string;
  readonly exec?: typeof exec;
  readonly readTextFile?: typeof readTextFile;
  readonly now?: number;
}): Promise<{
  readonly trusted: boolean;
  readonly issue?: string;
  readonly certificate?: X509Certificate;
}> {
  const read = input.readTextFile ?? readTextFile;
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate((await read(input.certPath)) ?? "");
  } catch {
    return {
      trusted: false,
      issue: "Current Caddy Local CA is missing or invalid",
    };
  }
  const now = input.now ?? Date.now();
  if (
    !(
      certificate.ca &&
      now >= Date.parse(certificate.validFrom) &&
      now <= Date.parse(certificate.validTo)
    )
  ) {
    return {
      trusted: false,
      issue: "Current Caddy Local CA is not a valid CA at the current time",
      certificate,
    };
  }
  const execute = input.exec ?? exec;
  const installed = await execute(
    ["security", "find-certificate", "-a", "-p", SYSTEM_KEYCHAIN],
    { stdin: "ignore" }
  );
  if (
    installed.exitCode !== 0 ||
    !containsCertificate({ pem: installed.stdout, certificate })
  ) {
    return {
      trusted: false,
      issue:
        "macOS System keychain is missing the current Caddy Local CA (it may contain an older root)",
      certificate,
    };
  }
  const verified = await execute(
    [
      "security",
      "verify-cert",
      "-c",
      input.certPath,
      "-p",
      "ssl",
      "-l",
      "-k",
      SYSTEM_KEYCHAIN,
      "-L",
      "-q",
    ],
    { stdin: "ignore" }
  );
  return verified.exitCode === 0
    ? { trusted: true, certificate }
    : {
        trusted: false,
        issue:
          "Current Caddy Local CA does not pass macOS TLS trust verification",
        certificate,
      };
}
