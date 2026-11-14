/**
 * Whether the system trust store (and, on Linux, the user's NSS databases)
 * trusts Hack's Caddy Local CA (HACK-2218, R16). Read-only and bounded: it
 * reads the exported CA, the OS trust store and NSS listings, runs only the
 * read-only `security` (macOS) and `certutil -L` (Linux) queries below, never
 * prompts and never changes anything. The whole inspection has one budget
 * ({@link TRUST_INSPECTION_BUDGET_MS}): no read or query starts after it,
 * each query's deadline is cut to what is left, and whatever was not reached
 * is reported unknown, so the report is always complete.
 *
 * Every part is `trusted`, `not_trusted` or `unknown`; a read that fails or
 * times out is unknown, never "not trusted".
 */
import type { X509Certificate } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
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

/** Deadline for each trust-store query (cut to the remaining budget). */
export const TRUST_QUERY_TIMEOUT_MS = 5000;

/** The whole inspection's budget; doctor's own check timeout is longer. */
export const TRUST_INSPECTION_BUDGET_MS = 20_000;

/** NSS databases inspected at most; any beyond are reported unknown. */
export const MAX_NSS_DATABASES = 16;

/** Largest file read (a system CA bundle is well below this). */
export const MAX_TRUST_FILE_BYTES = 32 * 1024 * 1024;

/** Exit code the budget gives a query it refused to start (as a timeout). */
const NOT_STARTED = 124;

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
  /**
   * A read-only query, stopped after `timeoutMs` (exit 124 on timeout, 127
   * when it cannot be started).
   */
  readonly query: (
    argv: readonly string[],
    opts: { readonly timeoutMs: number }
  ) => Promise<ExecResult>;
  /** Linux: the trust host (database discovery and the vetted certutil). */
  readonly linuxHost?: LinuxTrustHost;
  /** Whether a path exists: true, false, or "unknown" on any other error. */
  readonly exists: (path: string) => Promise<boolean | "unknown">;
  /** Directory entries; [] only when absent, "unknown" on any other error. */
  readonly listDir: (path: string) => Promise<readonly string[] | "unknown">;
  readonly now: () => number;
  /** Default {@link TRUST_INSPECTION_BUDGET_MS}. */
  readonly budgetMs?: number;
};

export async function inspectCaTrust(
  input: CaTrustDeps
): Promise<CaTrustReport> {
  const deps = withBudget(input);
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
  const listed = await opts.deps.query(
    ["security", "find-certificate", "-a", "-p", store],
    { timeoutMs: TRUST_QUERY_TIMEOUT_MS }
  );
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
  const verified = await opts.deps.query(
    [
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
    ],
    { timeoutMs: TRUST_QUERY_TIMEOUT_MS }
  );
  if (verified.exitCode === 0) {
    return {
      store,
      state: "trusted",
      detail: "Trusted for TLS by the System keychain",
    };
  }
  // Exit 1 is a completed evaluation that failed; anything else (a timeout,
  // a launch failure, a signal) is not an answer.
  if (verified.exitCode === 1) {
    return {
      store,
      state: "not_trusted",
      detail:
        "The System keychain holds the CA but does not trust it for TLS (run: hack global trust)",
    };
  }
  return {
    store,
    state: "unknown",
    detail: `security verify-cert gave no answer (exit ${verified.exitCode})`,
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
  // The same discovery walk as hack global trust, but a directory that
  // exists and cannot be listed is reported, not taken as empty.
  const unlisted: string[] = [];
  const strictHost: LinuxTrustHost = {
    ...host,
    listDir: async (path) => {
      const entries = await opts.deps.listDir(path);
      if (entries === "unknown") {
        unlisted.push(path);
        return [];
      }
      return entries;
    },
  };
  const candidates = await findNssDatabases(strictHost).catch(() => null);
  const results: CaTrustReport["nss"][number][] = [...new Set(unlisted)].map(
    (dir) => ({
      db: dir,
      state: "unknown" as const,
      detail: "Could not be listed, so NSS databases in it are unknown",
    })
  );
  if (candidates === null) {
    return [
      ...results,
      {
        db: host.homeDir,
        state: "unknown",
        detail: "NSS databases could not be listed",
      },
    ];
  }
  const dbs: string[] = [];
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
  for (const dbDir of dbs.slice(MAX_NSS_DATABASES)) {
    results.push({
      db: dbDir,
      state: "unknown",
      detail: `Not inspected: more than ${MAX_NSS_DATABASES} NSS databases`,
    });
  }
  const certutil = await host.resolveCommand("certutil").catch(() => null);
  for (const dbDir of dbs.slice(0, MAX_NSS_DATABASES)) {
    if (certutil === null) {
      results.push({
        db: dbDir,
        state: "unknown",
        detail:
          "certutil was not found (or could not be located in time), so this database cannot be read",
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
  const listed = await opts.deps.query(nssListTrustArgv(opts.db), {
    timeoutMs: TRUST_QUERY_TIMEOUT_MS,
  });
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
  const exported = await opts.deps.query(nssExportArgv(opts.db), {
    timeoutMs: TRUST_QUERY_TIMEOUT_MS,
  });
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

/**
 * Every boundary under one budget: once it is spent, reads answer
 * "unreadable"/"unknown" and queries are not started (exit 124), so the
 * inspection finishes with those parts unknown instead of running on after a
 * caller's timeout.
 */
function withBudget(deps: CaTrustDeps): CaTrustDeps {
  const deadline = deps.now() + (deps.budgetMs ?? TRUST_INSPECTION_BUDGET_MS);
  const left = () => deadline - deps.now();
  /**
   * Admit `run` only while budget is left, and settle by the deadline: an
   * operation still pending then (a stalled read, say) answers `fallback`.
   * Its late result is dropped; every boundary here only reads, so nothing
   * it does after the deadline matters to the report.
   */
  const bounded = async <T>(run: () => Promise<T>, fallback: T): Promise<T> => {
    const remaining = left();
    if (remaining <= 0) {
      return fallback;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), remaining);
    });
    try {
      return await Promise.race([run().catch(() => fallback), expired]);
    } finally {
      clearTimeout(timer);
    }
  };
  const host = deps.linuxHost;
  return {
    ...deps,
    readText: async (path) =>
      await bounded(async () => await deps.readText(path), "unreadable"),
    exists: async (path) =>
      await bounded(async () => await deps.exists(path), "unknown"),
    listDir: async (path) =>
      await bounded(async () => await deps.listDir(path), "unknown"),
    query: async (argv, opts) => {
      const remaining = left();
      // The query's own deadline also stops its process; the race covers a
      // runner that does not return.
      return await bounded(
        async () =>
          await deps.query(argv, {
            timeoutMs: Math.min(opts.timeoutMs, remaining),
          }),
        { exitCode: NOT_STARTED, stdout: "", stderr: "" }
      );
    },
    ...(host
      ? {
          linuxHost: {
            ...host,
            resolveCommand: async (name) =>
              await bounded(async () => await host.resolveCommand(name), null),
          },
        }
      : {}),
  };
}

/** Strict reads for the real boundary: only a missing path is "missing". */
export async function readTextOutcome(
  path: string
): Promise<{ readonly text: string } | "missing" | "unreadable"> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_TRUST_FILE_BYTES) {
      return "unreadable";
    }
    return { text: await readFile(path, "utf8") };
  } catch (error: unknown) {
    return isMissing(error) ? "missing" : "unreadable";
  }
}

export async function listDirOutcome(
  path: string
): Promise<readonly string[] | "unknown"> {
  try {
    return await readdir(path);
  } catch (error: unknown) {
    return isMissing(error) ? [] : "unknown";
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
