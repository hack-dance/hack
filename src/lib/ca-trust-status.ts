/**
 * Whether the system trust store (and, on Linux, the user's NSS databases)
 * trusts Hack's Caddy Local CA (HACK-2218, R16). Read-only and bounded: it
 * reads the exported CA, the OS trust store and NSS listings, runs only the
 * read-only `security` (macOS) and `certutil -L` (Linux) queries below with
 * a deadline each, never prompts and never changes anything.
 *
 * Every part is `trusted`, `not_trusted` or `unknown`; a read that fails or
 * times out is unknown, never "not trusted".
 */
import type { X509Certificate } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  bundleContainsCertificate,
  detectLinuxDistroFamily,
  hasTlsIssuerTrust,
  linuxSystemBundlePath,
  nssExportArgv,
  nssListTrustArgv,
  parseNssTrustFlags,
  pemCertificateBodies,
} from "./linux-trust.ts";
import type { LinuxTrustHost } from "./linux-trust-setup.ts";
import { findNssDatabases } from "./linux-trust-setup.ts";
import { inspectMacCaEligibility } from "./mac-ca-trust.ts";
import type { ExecResult } from "./shell.ts";

export type TrustState = "trusted" | "not_trusted" | "unknown";

/** Deadline for each trust-store query. */
export const TRUST_QUERY_TIMEOUT_MS = 5000;

export const MAC_SYSTEM_KEYCHAIN = "/Library/Keychains/System.keychain";

export type CaTrustReport = {
  readonly platform: string;
  /** The exported CA every store is compared with. */
  readonly ca: {
    readonly path: string;
    readonly state: "valid" | "missing" | "invalid" | "unreadable";
    readonly fingerprint256: string | null;
  };
  readonly system: {
    readonly store: string | null;
    readonly state: TrustState;
    readonly detail: string;
  };
  /** Linux only: each NSS database found (browsers, the shared user db). */
  readonly nss: readonly {
    readonly db: string;
    readonly state: TrustState;
    readonly detail: string;
  }[];
  /** not_trusted if any store is; otherwise unknown if any is; else trusted. */
  readonly state: TrustState;
};

export type CaTrustDeps = {
  readonly platform: NodeJS.Platform;
  readonly caPath: string;
  /** Text, or "missing" (ENOENT/ENOTDIR), or "unreadable". */
  readonly readText: (
    path: string
  ) => Promise<{ readonly text: string } | "missing" | "unreadable">;
  /** A read-only query, bounded by {@link TRUST_QUERY_TIMEOUT_MS}. */
  readonly query: (argv: readonly string[]) => Promise<ExecResult>;
  /** Linux: the trust host (database discovery and the vetted certutil). */
  readonly linuxHost?: LinuxTrustHost;
  /** Whether a path exists: true, false, or "unknown" on any other error. */
  readonly exists: (path: string) => Promise<boolean | "unknown">;
  readonly now: () => number;
};

export async function inspectCaTrust(
  deps: CaTrustDeps
): Promise<CaTrustReport> {
  const ca = await readCa(deps);
  const unknownSystem = (detail: string) => ({
    store: null,
    state: "unknown" as const,
    detail,
  });
  if (ca.certificate === null) {
    return report({
      deps,
      ca: ca.summary,
      system: unknownSystem(ca.detail),
      nss: [],
    });
  }
  if (deps.platform === "darwin") {
    return report({
      deps,
      ca: ca.summary,
      system: await macSystemTrust({ deps, certificate: ca.certificate }),
      nss: [],
    });
  }
  if (deps.platform === "linux") {
    const [system, nss] = await Promise.all([
      linuxSystemTrust({ deps, pem: ca.pem }),
      linuxNssTrust({ deps, certificate: ca.certificate }),
    ]);
    return report({ deps, ca: ca.summary, system, nss });
  }
  return report({
    deps,
    ca: ca.summary,
    system: unknownSystem("Trust stores are not checked on this platform"),
    nss: [],
  });
}

function report(opts: {
  readonly deps: CaTrustDeps;
  readonly ca: CaTrustReport["ca"];
  readonly system: CaTrustReport["system"];
  readonly nss: CaTrustReport["nss"];
}): CaTrustReport {
  const states = [opts.system.state, ...opts.nss.map((db) => db.state)];
  let state: TrustState = "trusted";
  if (states.includes("not_trusted")) {
    state = "not_trusted";
  } else if (states.includes("unknown")) {
    state = "unknown";
  }
  return {
    platform: opts.deps.platform,
    ca: opts.ca,
    system: opts.system,
    nss: opts.nss,
    state,
  };
}

async function readCa(deps: CaTrustDeps): Promise<{
  readonly summary: CaTrustReport["ca"];
  readonly certificate: X509Certificate | null;
  readonly pem: string;
  readonly detail: string;
}> {
  const read = await deps.readText(deps.caPath);
  if (read === "missing" || read === "unreadable") {
    return {
      summary: { path: deps.caPath, state: read, fingerprint256: null },
      certificate: null,
      pem: "",
      detail:
        read === "missing"
          ? "No exported Caddy Local CA to compare (run: hack global trust)"
          : "The exported Caddy Local CA could not be read",
    };
  }
  // The same parse and validity rules as installing trust.
  const eligibility = await inspectMacCaEligibility({
    certPath: deps.caPath,
    readTextFile: async () => await Promise.resolve(read.text),
    now: deps.now(),
  });
  if (!eligibility.installable) {
    return {
      summary: {
        path: deps.caPath,
        state: "invalid",
        fingerprint256: eligibility.certificate?.fingerprint256 ?? null,
      },
      certificate: null,
      pem: "",
      detail: eligibility.issue,
    };
  }
  return {
    summary: {
      path: deps.caPath,
      state: "valid",
      fingerprint256: eligibility.certificate.fingerprint256,
    },
    certificate: eligibility.certificate,
    pem: read.text,
    detail: "",
  };
}

/**
 * macOS: the System keychain must hold the exact CA and `security
 * verify-cert` must accept it for TLS from the local trust settings only
 * (`-L`, no network). A query that fails to run or times out is unknown.
 */
async function macSystemTrust(opts: {
  readonly deps: CaTrustDeps;
  readonly certificate: X509Certificate;
}): Promise<CaTrustReport["system"]> {
  const store = MAC_SYSTEM_KEYCHAIN;
  const listed = await opts.deps.query([
    "security",
    "find-certificate",
    "-a",
    "-p",
    store,
  ]);
  if (listed.exitCode !== 0) {
    return {
      store,
      state: "unknown",
      detail: "The System keychain could not be listed",
    };
  }
  const der = opts.certificate.raw.toString("base64");
  if (!pemCertificateBodies(listed.stdout).includes(der)) {
    return {
      store,
      state: "not_trusted",
      detail:
        "The System keychain does not hold the current Caddy Local CA (run: hack global trust)",
    };
  }
  const verified = await opts.deps.query([
    "security",
    "verify-cert",
    "-c",
    opts.deps.caPath,
    "-p",
    "ssl",
    "-l",
    "-k",
    store,
    "-L",
    "-q",
  ]);
  if (verified.exitCode === 124) {
    return {
      store,
      state: "unknown",
      detail: "security verify-cert did not answer in time",
    };
  }
  return verified.exitCode === 0
    ? {
        store,
        state: "trusted",
        detail: "Trusted for TLS by the System keychain",
      }
    : {
        store,
        state: "not_trusted",
        detail:
          "The System keychain holds the CA but does not trust it for TLS (run: hack global trust)",
      };
}

/** Linux: the distribution's system bundle must contain the exact CA. */
async function linuxSystemTrust(opts: {
  readonly deps: CaTrustDeps;
  readonly pem: string;
}): Promise<CaTrustReport["system"]> {
  const osRelease = await opts.deps.readText("/etc/os-release");
  if (osRelease === "missing" || osRelease === "unreadable") {
    return {
      store: null,
      state: "unknown",
      detail:
        "/etc/os-release could not be read, so the trust store is unknown",
    };
  }
  const family = detectLinuxDistroFamily(osRelease.text);
  if (family === null) {
    return {
      store: null,
      state: "unknown",
      detail: "This distribution's trust store is not recognised",
    };
  }
  const store = linuxSystemBundlePath(family);
  const bundle = await opts.deps.readText(store);
  if (bundle === "unreadable") {
    return { store, state: "unknown", detail: `${store} could not be read` };
  }
  if (bundle === "missing") {
    return {
      store,
      state: "not_trusted",
      detail: `${store} does not exist (run: hack global trust)`,
    };
  }
  return bundleContainsCertificate({ bundle: bundle.text, certPem: opts.pem })
    ? { store, state: "trusted", detail: `In ${store}` }
    : {
        store,
        state: "not_trusted",
        detail: `${store} does not contain the current Caddy Local CA (run: hack global trust)`,
      };
}

/**
 * Linux NSS (browsers and the shared user db): each database that exists
 * must give Hack's entry TLS issuer trust and hold the exact CA. Databases
 * are only listed, never created; without a vetted certutil each is unknown.
 */
async function linuxNssTrust(opts: {
  readonly deps: CaTrustDeps;
  readonly certificate: X509Certificate;
}): Promise<CaTrustReport["nss"]> {
  const host = opts.deps.linuxHost;
  if (!host) {
    return [];
  }
  const candidates = await findNssDatabases(host).catch(() => null);
  if (candidates === null) {
    return [
      {
        db: host.homeDir,
        state: "unknown",
        detail: "NSS databases could not be listed",
      },
    ];
  }
  const dbs: string[] = [];
  const results: CaTrustReport["nss"][number][] = [];
  for (const dir of candidates) {
    const present = await opts.deps.exists(join(dir, "cert9.db"));
    if (present === "unknown") {
      results.push({
        db: dir,
        state: "unknown",
        detail: "The database could not be inspected",
      });
    } else if (present) {
      dbs.push(dir);
    }
  }
  if (dbs.length === 0) {
    return results;
  }
  const certutil = await host.resolveCommand("certutil").catch(() => null);
  for (const dbDir of dbs) {
    if (certutil === null) {
      results.push({
        db: dbDir,
        state: "unknown",
        detail: "certutil is not installed, so this database cannot be read",
      });
      continue;
    }
    results.push(
      await nssDbTrust({
        deps: opts.deps,
        db: { certutil, dbDir },
        certificate: opts.certificate,
      })
    );
  }
  return results;
}

async function nssDbTrust(opts: {
  readonly deps: CaTrustDeps;
  readonly db: { readonly certutil: string; readonly dbDir: string };
  readonly certificate: X509Certificate;
}): Promise<CaTrustReport["nss"][number]> {
  const { dbDir } = opts.db;
  const listed = await opts.deps.query(nssListTrustArgv(opts.db));
  if (listed.exitCode !== 0) {
    return {
      db: dbDir,
      state: "unknown",
      detail: "certutil -L did not answer",
    };
  }
  if (!hasTlsIssuerTrust(parseNssTrustFlags({ listing: listed.stdout }))) {
    return {
      db: dbDir,
      state: "not_trusted",
      detail: "No Hack CA entry with TLS issuer trust (run: hack global trust)",
    };
  }
  const exported = await opts.deps.query(nssExportArgv(opts.db));
  if (exported.exitCode !== 0) {
    return {
      db: dbDir,
      state: "unknown",
      detail: "Hack's CA entry could not be read back",
    };
  }
  const der = opts.certificate.raw.toString("base64");
  return pemCertificateBodies(exported.stdout).includes(der)
    ? { db: dbDir, state: "trusted", detail: "Trusted for TLS" }
    : {
        db: dbDir,
        state: "not_trusted",
        detail: "Hack's entry holds a different CA (run: hack global trust)",
      };
}

/** Strict reads for the real boundary: only a missing path is "missing". */
export async function readTextOutcome(
  path: string
): Promise<{ readonly text: string } | "missing" | "unreadable"> {
  try {
    return { text: await readFile(path, "utf8") };
  } catch (error: unknown) {
    return isMissing(error) ? "missing" : "unreadable";
  }
}

export async function pathExistsOutcome(
  path: string
): Promise<boolean | "unknown"> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    return isMissing(error) ? false : "unknown";
  }
}

function isMissing(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}
