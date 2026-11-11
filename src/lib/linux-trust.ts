/**
 * Linux trust for Caddy's local root CA (`hack global trust`).
 *
 * Two independent stores:
 * - the distribution trust store (root): the anchor directory and refresh
 *   command differ per distribution family;
 * - NSS databases (no root): Chromium-family browsers read the user's
 *   `~/.pki/nssdb`, and each Firefox profile has its own `cert9.db`.
 *
 * Root steps are returned as argv arrays; the caller shows them and runs each
 * as `sudo <argv>` only after an interactive yes. NSS steps need no root.
 */
import { createHash, X509Certificate } from "node:crypto";
import { inspectMacCaEligibility } from "./mac-ca-trust.ts";

export type LinuxDistroFamily = "debian" | "arch" | "fedora" | "suse";

/** Nickname for the NSS entry; stable so a rerun replaces, not duplicates. */
export const NSS_CA_NICKNAME = "Hack Caddy Local CA";
/** File name used in anchor directories. Debian requires the `.crt` suffix. */
export const LINUX_ANCHOR_FILENAME = "hack-caddy-local-ca.crt";

const OS_RELEASE_LINE = /^([A-Z_]+)=(.*)$/;
const WHITESPACE = /\s+/;
const WHITESPACE_GLOBAL = /\s+/g;
const PEM_BODY =
  /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/g;

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    (trimmed.startsWith('"') || trimmed.startsWith("'")) &&
    trimmed.endsWith(trimmed[0] ?? "")
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Family from `/etc/os-release` `ID` and `ID_LIKE`, or `null` when unknown. */
export function detectLinuxDistroFamily(
  osRelease: string | null
): LinuxDistroFamily | null {
  if (osRelease === null) {
    return null;
  }
  const fields = new Map<string, string>();
  for (const line of osRelease.split("\n")) {
    const match = OS_RELEASE_LINE.exec(line.trim());
    if (match?.[1] && match[2] !== undefined) {
      fields.set(match[1], unquote(match[2]).toLowerCase());
    }
  }
  const ids = [
    fields.get("ID") ?? "",
    ...(fields.get("ID_LIKE") ?? "").split(WHITESPACE),
  ].filter((id) => id.length > 0);
  for (const id of ids) {
    if (id === "debian" || id === "ubuntu") {
      return "debian";
    }
    if (id === "arch" || id === "archlinux") {
      return "arch";
    }
    if (
      id === "fedora" ||
      id === "rhel" ||
      id === "centos" ||
      id === "rocky" ||
      id === "almalinux"
    ) {
      return "fedora";
    }
    if (id === "suse" || id.startsWith("opensuse") || id === "sles") {
      return "suse";
    }
  }
  return null;
}

/** Where each family keeps local anchors (`null`: managed by `trust`). */
export function linuxAnchorPath(family: LinuxDistroFamily): string | null {
  switch (family) {
    case "debian":
      return `/usr/local/share/ca-certificates/${LINUX_ANCHOR_FILENAME}`;
    case "fedora":
      return `/etc/pki/ca-trust/source/anchors/${LINUX_ANCHOR_FILENAME}`;
    case "suse":
      return `/etc/pki/trust/anchors/${LINUX_ANCHOR_FILENAME}`;
    case "arch":
      return null;
    default:
      return null;
  }
}

/** The extracted bundle each family's refresh command writes. */
export function linuxSystemBundlePath(family: LinuxDistroFamily): string {
  switch (family) {
    case "debian":
      return "/etc/ssl/certs/ca-certificates.crt";
    case "fedora":
      return "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem";
    case "suse":
      return "/var/lib/ca-certificates/ca-bundle.pem";
    case "arch":
      return "/etc/ssl/certs/ca-certificates.crt";
    default:
      return "/etc/ssl/certs/ca-certificates.crt";
  }
}

/**
 * Root copies the user-writable CA file into a root-owned temp file, checks
 * the copy against the sha256 of the bytes Hack read and showed, and acts
 * only on that copy. A CA file replaced after the prompt fails the step
 * instead of becoming a trusted root.
 */
const VERIFY_COPY =
  'set -eu; t=$(mktemp); trap \'rm -f "$t"\' EXIT; cat -- "$1" > "$t"; printf "%s  %s\\n" "$2" "$t" | sha256sum -c --status';
export const VERIFIED_ANCHOR_INSTALL_SCRIPT = `${VERIFY_COPY}; install -D -o root -g root -m 0644 "$t" "$3"`;
export const VERIFIED_TRUST_ANCHOR_SCRIPT = `${VERIFY_COPY}; trust anchor --store "$t"`;

/** Root commands that add the CA at `certPath` (digest `sha256`) to the trust store. */
export function linuxSystemTrustCommands(opts: {
  readonly family: LinuxDistroFamily;
  readonly certPath: string;
  readonly sha256: string;
}): readonly (readonly string[])[] {
  const anchor = linuxAnchorPath(opts.family);
  const install = (target: string) => [
    "sh",
    "-c",
    VERIFIED_ANCHOR_INSTALL_SCRIPT,
    "hack-install",
    opts.certPath,
    opts.sha256,
    target,
  ];
  switch (opts.family) {
    case "debian":
      return [install(anchor ?? ""), ["update-ca-certificates"]];
    case "fedora":
      return [install(anchor ?? ""), ["update-ca-trust", "extract"]];
    case "suse":
      return [install(anchor ?? ""), ["update-ca-certificates"]];
    case "arch":
      return [
        [
          "sh",
          "-c",
          VERIFIED_TRUST_ANCHOR_SCRIPT,
          "hack-trust",
          opts.certPath,
          opts.sha256,
        ],
      ];
    default:
      return [];
  }
}

/** Normalized base64 bodies of every PEM certificate in `text`. */
export function pemCertificateBodies(text: string): readonly string[] {
  return [...text.matchAll(PEM_BODY)].map((match) =>
    (match[1] ?? "").replace(WHITESPACE_GLOBAL, "")
  );
}

/** Whether `bundle` already contains the certificate in `certPem`. */
export function bundleContainsCertificate(opts: {
  readonly bundle: string;
  readonly certPem: string;
}): boolean {
  const [cert] = pemCertificateBodies(opts.certPem);
  if (!cert) {
    return false;
  }
  return pemCertificateBodies(opts.bundle).includes(cert);
}

/** Every `certutil` call names the resolved absolute binary, never a bare name. */
type CertutilDb = { readonly certutil: string; readonly dbDir: string };

/** `certutil` argv that adds the CA as a trusted TLS issuer to one NSS db. */
export function nssAddArgv(
  opts: CertutilDb & { readonly certPath: string }
): readonly string[] {
  return [
    opts.certutil,
    "-d",
    `sql:${opts.dbDir}`,
    "-A",
    "-t",
    NSS_TLS_ISSUER_TRUST,
    "-n",
    NSS_CA_NICKNAME,
    "-i",
    opts.certPath,
  ];
}

/** `certutil` argv that sets the TLS issuer trust on Hack's existing entry. */
export function nssModifyTrustArgv(opts: CertutilDb): readonly string[] {
  return [
    opts.certutil,
    "-d",
    `sql:${opts.dbDir}`,
    "-M",
    "-n",
    NSS_CA_NICKNAME,
    "-t",
    NSS_TLS_ISSUER_TRUST,
  ];
}

/** `certutil` argv that creates an empty user NSS db (no password). */
export function nssCreateArgv(opts: CertutilDb): readonly string[] {
  return [opts.certutil, "-d", `sql:${opts.dbDir}`, "-N", "--empty-password"];
}

/** `certutil` argv that deletes Hack's entry (before replacing it). */
export function nssDeleteArgv(opts: CertutilDb): readonly string[] {
  return [
    opts.certutil,
    "-d",
    `sql:${opts.dbDir}`,
    "-D",
    "-n",
    NSS_CA_NICKNAME,
  ];
}

/** `certutil` argv that prints the entry as PEM, exit 0 when it exists. */
export function nssExportArgv(opts: CertutilDb): readonly string[] {
  return [
    opts.certutil,
    "-d",
    `sql:${opts.dbDir}`,
    "-L",
    "-n",
    NSS_CA_NICKNAME,
    "-a",
  ];
}

/** `certutil` argv that lists every entry with its trust attributes. */
export function nssListTrustArgv(opts: CertutilDb): readonly string[] {
  return [opts.certutil, "-d", `sql:${opts.dbDir}`, "-L"];
}

/** SSL/TLS trust "C" (trusted CA for server certificates); e-mail and code signing unset. */
export const NSS_TLS_ISSUER_TRUST = "C,,";

/**
 * Trust attributes for `nickname` from `certutil -L` output, whose rows are
 * "<nickname padded with spaces> <ssl>,<email>,<object>". `null` when absent.
 */
export function parseNssTrustFlags(opts: {
  readonly listing: string;
  readonly nickname?: string;
}): string | null {
  const nickname = opts.nickname ?? NSS_CA_NICKNAME;
  for (const line of opts.listing.split("\n")) {
    const trimmed = line.trimEnd();
    if (!trimmed.startsWith(nickname)) {
      continue;
    }
    const rest = trimmed.slice(nickname.length);
    if (rest.length > 0 && !WHITESPACE_START.test(rest)) {
      continue;
    }
    const flags = rest.trim();
    if (NSS_FLAGS.test(flags)) {
      return flags;
    }
  }
  return null;
}

const WHITESPACE_START = /^\s/;
const NSS_FLAGS = /^[A-Za-z]*,[A-Za-z]*,[A-Za-z]*$/;

/** The SSL segment carries the trusted-CA flag "C" for server certificates. */
export function hasTlsIssuerTrust(flags: string | null): boolean {
  return (flags?.split(",")[0] ?? "").includes("C");
}

const SAFE_SHELL_WORD = /^[\w@%+=:,./~-]+$/;

/** Render argv as one copyable POSIX shell command line. */
export function renderShellCommand(argv: readonly string[]): string {
  return argv
    .map((word) =>
      SAFE_SHELL_WORD.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`
    )
    .join(" ");
}

/**
 * Manual steps when the family is unknown, rendered from the same argument
 * arrays and quoting as the supported families (a path with spaces or shell
 * syntax stays one literal argument).
 */
export function renderUnknownDistroTrustSteps(opts: {
  readonly certPath: string;
  readonly sha256: string;
}): readonly string[] {
  const steps: string[] = [
    "Unknown distribution (no matching ID or ID_LIKE in /etc/os-release). Run the commands for your distribution family:",
  ];
  const families: readonly [string, LinuxDistroFamily][] = [
    ["Debian/Ubuntu", "debian"],
    ["Fedora/RHEL", "fedora"],
    ["Arch", "arch"],
    ["openSUSE", "suse"],
  ];
  for (const [label, family] of families) {
    steps.push(`  ${label}:`);
    for (const command of linuxSystemTrustCommands({
      family,
      certPath: opts.certPath,
      sha256: opts.sha256,
    })) {
      steps.push(`    sudo ${renderShellCommand(command)}`);
    }
  }
  return steps;
}

/** A validated Caddy root: exactly one self-signed CA, currently valid. */
export type ValidatedCa = {
  readonly pem: string;
  readonly certificate: X509Certificate;
  /** SHA-256 of the DER certificate, colon-separated (shown to the user). */
  readonly fingerprint256: string;
  /** SHA-256 of the exact PEM bytes installed (bound into root steps). */
  readonly pemSha256: string;
};

/**
 * Validate the exported CA before any trust writer sees it: exactly one PEM
 * certificate (the macOS eligibility gate: single block, size limit, CA,
 * within validity), and self-signed, so it is eligible as a trust root.
 */
export async function validateCaddyRootPem(opts: {
  readonly pem: string;
  readonly now?: number;
}): Promise<
  | { readonly ok: true; readonly ca: ValidatedCa }
  | { readonly ok: false; readonly issue: string }
> {
  const eligibility = await inspectMacCaEligibility({
    certPath: "<exported Caddy root>",
    readTextFile: async () => opts.pem,
    now: opts.now,
  });
  if (!eligibility.installable) {
    return { ok: false, issue: eligibility.issue };
  }
  const { certificate } = eligibility;
  if (
    certificate.issuer !== certificate.subject ||
    !certificate.checkIssued(certificate) ||
    !certificate.verify(certificate.publicKey)
  ) {
    return {
      ok: false,
      issue: "Current Caddy Local CA is not a self-signed root",
    };
  }
  return {
    ok: true,
    ca: {
      pem: opts.pem,
      certificate,
      fingerprint256: certificate.fingerprint256,
      pemSha256: createHash("sha256").update(opts.pem).digest("hex"),
    },
  };
}

const CADDY_ROOT_SUBJECT = "Caddy Local Authority";

/**
 * Caddy roots in a trust bundle other than `current` (by DER): roots left
 * trusted after Caddy rotated its CA. Only public fingerprints are returned.
 */
export function findOtherCaddyRoots(opts: {
  readonly bundle: string;
  readonly current: X509Certificate;
}): readonly string[] {
  const others: string[] = [];
  for (const match of opts.bundle.matchAll(PEM_BLOCK)) {
    try {
      const certificate = new X509Certificate(match[0]);
      if (
        certificate.subject.includes(CADDY_ROOT_SUBJECT) &&
        !certificate.raw.equals(opts.current.raw)
      ) {
        others.push(certificate.fingerprint256);
      }
    } catch {
      // Not a parseable certificate; ignore it.
    }
  }
  return others;
}

const PEM_BLOCK =
  /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
