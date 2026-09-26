import { X509Certificate } from "node:crypto";
import { readTextFile } from "./fs.ts";
import { exec } from "./shell.ts";

const SYSTEM_KEYCHAIN = "/Library/Keychains/System.keychain";
const PEM_CERTIFICATE =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

const SINGLE_PEM_CERTIFICATE =
  /^[ \t\r\n]*-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END CERTIFICATE-----[ \t\r\n]*$/;
const PEM_LINE_BREAKS = /[\r\n]/g;
const MAX_CA_PEM_BYTES = 64 * 1024;

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

/** Read-only eligibility gate shared by keychain and host trust writers. */
export async function inspectMacCaEligibility(input: {
  readonly certPath: string;
  readonly readTextFile?: typeof readTextFile;
  readonly now?: number;
}): Promise<
  | { readonly installable: true; readonly certificate: X509Certificate }
  | {
      readonly installable: false;
      readonly issue: string;
      readonly certificate?: X509Certificate;
    }
> {
  const read = input.readTextFile ?? readTextFile;
  let certificate: X509Certificate;
  try {
    const pem = (await read(input.certPath)) ?? "";
    if (Buffer.byteLength(pem, "utf8") > MAX_CA_PEM_BYTES) {
      throw new Error("invalid CA input");
    }
    const match = SINGLE_PEM_CERTIFICATE.exec(pem);
    if (!match?.[1]) {
      throw new Error("invalid CA input");
    }
    const base64 = match[1].replace(PEM_LINE_BREAKS, "");
    const der = Buffer.from(base64, "base64");
    certificate = new X509Certificate(pem);
    if (der.toString("base64") !== base64 || !certificate.raw.equals(der)) {
      throw new Error("invalid CA input");
    }
  } catch {
    return {
      installable: false,
      issue: "Current Caddy Local CA is missing or invalid",
    };
  }
  const now = input.now ?? Date.now();
  let invalidReason: string | null = null;
  if (!certificate.ca) {
    invalidReason = "Current Caddy Local CA certificate is not a CA";
  } else if (now < Date.parse(certificate.validFrom)) {
    invalidReason =
      "Current Caddy Local CA is not yet valid at the current time";
  } else if (now > Date.parse(certificate.validTo)) {
    invalidReason = "Current Caddy Local CA has expired at the current time";
  } else if (
    !(
      Number.isFinite(now) &&
      Number.isFinite(Date.parse(certificate.validFrom)) &&
      Number.isFinite(Date.parse(certificate.validTo))
    )
  ) {
    invalidReason = "Current Caddy Local CA validity dates cannot be verified";
  }
  if (invalidReason) {
    return {
      installable: false,
      issue: invalidReason,
      certificate,
    };
  }
  return { installable: true, certificate };
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
  /** Only a parseable CA valid now is eligible for an explicit trust installation. */
  readonly installable: boolean;
  readonly issue?: string;
  readonly certificate?: X509Certificate;
}> {
  const eligibility = await inspectMacCaEligibility(input);
  if (!eligibility.installable) {
    return { trusted: false, ...eligibility };
  }
  const { certificate } = eligibility;
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
      installable: true,
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
    ? { trusted: true, installable: true, certificate }
    : {
        trusted: false,
        installable: true,
        issue:
          "Current Caddy Local CA does not pass macOS TLS trust verification",
        certificate,
      };
}
