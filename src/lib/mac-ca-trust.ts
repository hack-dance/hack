import { createHash, X509Certificate } from "node:crypto";
import { readTextFile } from "./fs.ts";
import { exec } from "./shell.ts";

const SYSTEM_KEYCHAIN = "/Library/Keychains/System.keychain";
const PEM_CERTIFICATE =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;

const SINGLE_PEM_CERTIFICATE =
  /^[ \t\r\n]*-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]+)-----END CERTIFICATE-----[ \t\r\n]*$/;
const PEM_LINE_BREAKS = /[\r\n]/g;
const MAX_CA_PEM_BYTES = 64 * 1024;
/** Caddy writes the creation year into its root name, e.g. "- 2025 ECC Root". */
const ROOT_NAME_YEAR = /\b\d{4}\b/g;
const MAX_LISTED_FINGERPRINTS = 32;
const MAX_MESSAGE_FINGERPRINTS = 8;

/**
 * Same-family roots left in the System keychain whose exact DER differs from
 * the current root. Only counts and public SHA-256 fingerprints are recorded:
 * never paths, PEM bodies or other keychain values.
 */
export interface SupersededRootInventory {
  readonly count: number;
  readonly expired: number;
  readonly notYetValid: number;
  /** Uppercase hex SHA-256 of each root's DER, as `security find-certificate -Z` prints it. */
  readonly sha256: readonly string[];
}

function rootFamily(subject: string): string {
  return subject.replace(ROOT_NAME_YEAR, "YYYY");
}

/**
 * Inventory superseded roots from `security find-certificate -a -p` output.
 * Classification is by exact DER; the subject (ignoring Caddy's year) only
 * groups self-issued CA candidates into the current root's family. This never
 * establishes trust and never selects anything for removal.
 */
export function inventorySupersededRoots(input: {
  readonly pem: string;
  readonly certificate: X509Certificate;
  readonly now: number;
}): SupersededRootInventory {
  const family = rootFamily(input.certificate.subject);
  const roots = new Map<string, X509Certificate>();
  for (const [pem] of input.pem.matchAll(PEM_CERTIFICATE)) {
    let candidate: X509Certificate;
    try {
      candidate = new X509Certificate(pem);
    } catch {
      continue;
    }
    if (
      candidate.raw.equals(input.certificate.raw) ||
      !candidate.ca ||
      candidate.issuer !== candidate.subject ||
      rootFamily(candidate.subject) !== family
    ) {
      continue;
    }
    const sha256 = createHash("sha256")
      .update(candidate.raw)
      .digest("hex")
      .toUpperCase();
    roots.set(sha256, candidate);
  }
  let expired = 0;
  let notYetValid = 0;
  for (const root of roots.values()) {
    if (input.now > Date.parse(root.validTo)) {
      expired += 1;
    } else if (input.now < Date.parse(root.validFrom)) {
      notYetValid += 1;
    }
  }
  return {
    count: roots.size,
    expired,
    notYetValid,
    sha256: [...roots.keys()].sort().slice(0, MAX_LISTED_FINGERPRINTS),
  };
}

/** Informational Doctor text; removal stays a user-run, fingerprint-exact step. */
export function describeSupersededRoots(
  inventory: SupersededRootInventory | undefined
): {
  readonly status: "ok" | "warn";
  readonly message: string;
} {
  if (!inventory) {
    return {
      status: "warn",
      message:
        "Not inventoried: the current Caddy root or the System keychain listing is unavailable.",
    };
  }
  if (inventory.count === 0) {
    return {
      status: "ok",
      message: "0 superseded Caddy roots remain in the macOS System keychain.",
    };
  }
  const validity = [`${inventory.expired} expired`];
  if (inventory.notYetValid > 0) {
    validity.push(`${inventory.notYetValid} not yet valid`);
  }
  const listed = inventory.sha256.slice(0, MAX_MESSAGE_FINGERPRINTS);
  const more = inventory.count - listed.length;
  const noun = inventory.count === 1 ? "root remains" : "roots remain";
  return {
    status: "warn",
    message: `${inventory.count} superseded Caddy ${noun} in the macOS System keychain (${validity.join(", ")}). SHA-256: ${listed.join(", ")}${more > 0 ? ` (+${more} more)` : ""}. Hack does not remove them; see docs/guides/macos-certificate-trust.md to remove one by exact fingerprint.`,
  };
}

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

/**
 * Read-only System-keychain inventory relative to the exported current root.
 * Returns undefined when the current root or the keychain listing is unreadable.
 */
export async function inspectSupersededMacRoots(input: {
  readonly certPath: string;
  readonly exec?: typeof exec;
  readonly readTextFile?: typeof readTextFile;
  readonly now?: number;
}): Promise<SupersededRootInventory | undefined> {
  const { certificate } = await inspectMacCaEligibility(input);
  if (!certificate) {
    return undefined;
  }
  const execute = input.exec ?? exec;
  const listed = await execute(
    ["security", "find-certificate", "-a", "-p", SYSTEM_KEYCHAIN],
    { stdin: "ignore" }
  );
  if (listed.exitCode !== 0) {
    return undefined;
  }
  return inventorySupersededRoots({
    pem: listed.stdout,
    certificate,
    now: input.now ?? Date.now(),
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
  /** Only a parseable CA valid now is eligible for an explicit trust installation. */
  readonly installable: boolean;
  readonly issue?: string;
  readonly certificate?: X509Certificate;
  /** Present only when the System keychain listing was read successfully. */
  readonly supersededRoots?: SupersededRootInventory;
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
  if (installed.exitCode !== 0) {
    return {
      trusted: false,
      installable: true,
      issue:
        "macOS System keychain is missing the current Caddy Local CA (it may contain an older root)",
      certificate,
    };
  }
  const supersededRoots = inventorySupersededRoots({
    pem: installed.stdout,
    certificate,
    now: input.now ?? Date.now(),
  });
  if (!containsCertificate({ pem: installed.stdout, certificate })) {
    return {
      trusted: false,
      installable: true,
      issue:
        "macOS System keychain is missing the current Caddy Local CA (it may contain an older root)",
      certificate,
      supersededRoots,
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
    ? { trusted: true, installable: true, certificate, supersededRoots }
    : {
        trusted: false,
        installable: true,
        issue:
          "Current Caddy Local CA does not pass macOS TLS trust verification",
        certificate,
        supersededRoots,
      };
}
