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

/** Root commands that add `certPath` to the family's trust store. */
export function linuxSystemTrustCommands(opts: {
  readonly family: LinuxDistroFamily;
  readonly certPath: string;
}): readonly (readonly string[])[] {
  const anchor = linuxAnchorPath(opts.family);
  const install = (target: string) => [
    "install",
    "-D",
    "-o",
    "root",
    "-g",
    "root",
    "-m",
    "0644",
    opts.certPath,
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
      return [["trust", "anchor", "--store", opts.certPath]];
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

/** `certutil` argv that adds the CA as a trusted TLS issuer to one NSS db. */
export function nssAddArgv(opts: {
  readonly dbDir: string;
  readonly certPath: string;
}): readonly string[] {
  return [
    "certutil",
    "-d",
    `sql:${opts.dbDir}`,
    "-A",
    "-t",
    "C,,",
    "-n",
    NSS_CA_NICKNAME,
    "-i",
    opts.certPath,
  ];
}

/** `certutil` argv that creates an empty user NSS db (no password). */
export function nssCreateArgv(dbDir: string): readonly string[] {
  return ["certutil", "-d", `sql:${dbDir}`, "-N", "--empty-password"];
}

/** `certutil` argv that deletes Hack's entry (before replacing it). */
export function nssDeleteArgv(dbDir: string): readonly string[] {
  return ["certutil", "-d", `sql:${dbDir}`, "-D", "-n", NSS_CA_NICKNAME];
}

/** `certutil` argv that prints the entry, exit 0 when it exists. */
export function nssListArgv(dbDir: string): readonly string[] {
  return ["certutil", "-d", `sql:${dbDir}`, "-L", "-n", NSS_CA_NICKNAME, "-a"];
}

/** Manual steps when the family is unknown. */
export function renderUnknownDistroTrustSteps(
  certPath: string
): readonly string[] {
  return [
    "Unknown distribution (no matching ID or ID_LIKE in /etc/os-release). Add the CA to your trust store, for example:",
    `  Debian/Ubuntu: sudo install -m 0644 ${certPath} /usr/local/share/ca-certificates/${LINUX_ANCHOR_FILENAME} && sudo update-ca-certificates`,
    `  Fedora/RHEL:   sudo install -m 0644 ${certPath} /etc/pki/ca-trust/source/anchors/${LINUX_ANCHOR_FILENAME} && sudo update-ca-trust extract`,
    `  Arch:          sudo trust anchor --store ${certPath}`,
  ];
}
