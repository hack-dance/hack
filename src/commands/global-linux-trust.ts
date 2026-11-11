/**
 * `hack global trust` wiring for Linux: the distribution trust store (root,
 * confirmed) and NSS browser databases (no root). Decisions live in
 * `lib/linux-trust*.ts`.
 *
 * Before any trust writer runs, the exported CA must be exactly one valid,
 * self-signed CA whose bytes equal the running Caddy root of this Hack home.
 * Writers then use a private copy of those inspected bytes.
 */
import { X509Certificate } from "node:crypto";
import { note } from "@clack/prompts";
import {
  type CaddyCaIdentity,
  inspectCaddyCaIdentity,
} from "../lib/caddy-ca-identity.ts";
import { readTextFile } from "../lib/fs.ts";
import { canPrompt, confirmSafe } from "../lib/interactivity.ts";
import {
  renderShellCommand,
  type ValidatedCa,
  validateCaddyRootPem,
} from "../lib/linux-trust.ts";
import {
  createLinuxTrustHost,
  stagePrivateCopy,
} from "../lib/linux-trust-host.ts";
import {
  applyLinuxNssTrust,
  applyLinuxSystemTrust,
  type LinuxSystemTrustOutcome,
  type LinuxTrustHost,
} from "../lib/linux-trust-setup.ts";
import { logger } from "../ui/logger.ts";

function renderSudo(argv: readonly string[]): string {
  return `sudo ${renderShellCommand(argv)}`;
}

/** Effects the command needs besides the trust host; injectable for tests. */
export type LinuxTrustCommandDeps = {
  readonly host: LinuxTrustHost;
  readonly readFile: (path: string) => Promise<string | null>;
  readonly inspectIdentity: (opts: {
    readonly composeFile: string;
    readonly certPath: string;
  }) => Promise<CaddyCaIdentity>;
  readonly stage: (content: string) => Promise<{
    readonly path: string;
    readonly cleanup: () => Promise<void>;
  }>;
  readonly canPrompt: () => boolean;
  readonly confirm: (message: string) => Promise<boolean>;
};

function defaultDeps(): LinuxTrustCommandDeps {
  return {
    host: createLinuxTrustHost(),
    readFile: readTextFile,
    inspectIdentity: inspectCaddyCaIdentity,
    stage: async (content) =>
      await stagePrivateCopy({ content, fileName: "caddy-local-ca.crt" }),
    canPrompt,
    confirm: async (message) =>
      await confirmSafe({
        message,
        initialValue: true,
        nonInteractive: "decline",
      }),
  };
}

/**
 * Validate the export and tie it to the running Caddy root. Returns the
 * validated CA, or logs why it is refused and returns `null`.
 */
async function loadVerifiedCa(opts: {
  readonly certPath: string;
  readonly composeFile: string;
  readonly deps: LinuxTrustCommandDeps;
}): Promise<ValidatedCa | null> {
  const pem = (await opts.deps.readFile(opts.certPath)) ?? "";
  const validated = await validateCaddyRootPem({ pem });
  if (!validated.ok) {
    logger.error({
      message: `${validated.issue}; no trust store was changed (code=linux_trust_ca_invalid). Run hack global up, then hack global trust, so Hack exports Caddy's CA again.`,
    });
    return null;
  }
  const identity = await opts.deps.inspectIdentity({
    composeFile: opts.composeFile,
    certPath: opts.certPath,
  });
  const runtime =
    identity.state === "current" && identity.currentPem
      ? safeCertificate(identity.currentPem)
      : null;
  if (!runtime?.raw.equals(validated.ca.certificate.raw)) {
    logger.error({
      message: `The exported CA (SHA-256 ${validated.ca.fingerprint256}) is not confirmed as this Hack home's running Caddy root: ${identity.message}. No trust store was changed (code=linux_trust_ca_unverified). Run hack global up, then hack global trust.`,
    });
    return null;
  }
  return validated.ca;
}

function safeCertificate(pem: string): X509Certificate | null {
  try {
    return new X509Certificate(pem);
  } catch {
    return null;
  }
}

/** Returns false when the CA was refused or a step Hack attempted failed. */
export async function configureLinuxSystemAndBrowserTrust(opts: {
  readonly certPath: string;
  readonly composeFile: string;
  readonly deps?: LinuxTrustCommandDeps;
}): Promise<boolean> {
  const deps = opts.deps ?? defaultDeps();
  const ca = await loadVerifiedCa({
    certPath: opts.certPath,
    composeFile: opts.composeFile,
    deps,
  });
  if (!ca) {
    return false;
  }
  const staged = await deps.stage(ca.pem);
  try {
    const systemOk = await applySystem({
      deps,
      ca,
      stagedPath: staged.path,
      manualCertPath: opts.certPath,
    });
    const nssOk = await applyNss({ deps, ca, stagedPath: staged.path });
    return systemOk && nssOk;
  } finally {
    await staged.cleanup();
  }
}

async function applySystem(opts: {
  readonly deps: LinuxTrustCommandDeps;
  readonly ca: ValidatedCa;
  readonly stagedPath: string;
  readonly manualCertPath: string;
}): Promise<boolean> {
  const { deps, ca } = opts;
  const system = await applyLinuxSystemTrust({
    host: deps.host,
    ca,
    stagedPath: opts.stagedPath,
    manualCertPath: opts.manualCertPath,
    canPrompt: deps.canPrompt(),
    show: (commands, fingerprint256) =>
      note(
        [
          "Add Caddy's local CA to the system trust store:",
          `  ${ca.certificate.subject.replaceAll("\n", ", ")}`,
          `  SHA-256 ${fingerprint256}`,
          "Commands (each runs with sudo; root installs only bytes with this digest):",
          ...commands.map((command) => `  ${renderSudo(command)}`),
        ].join("\n"),
        "System trust"
      ),
    confirm: async () =>
      await deps.confirm(
        `Trust this CA (SHA-256 ${ca.fingerprint256}) system-wide now? (requires sudo)`
      ),
  });
  reportSystem(system);
  return system.status !== "failed";
}

function reportSystem(system: LinuxSystemTrustOutcome): void {
  switch (system.status) {
    case "trusted":
      logger.success({
        message: `System trust store (${system.family}) trusts Caddy's local CA`,
      });
      if (system.otherCaddyRoots.length > 0) {
        logger.warn({
          message: [
            "Other Caddy roots are still trusted system-wide (for example after Caddy rotated its CA). Hack does not remove them; see docs/guides/linux-certificate-trust.md.",
            ...system.otherCaddyRoots.map((fp) => `  SHA-256 ${fp}`),
          ].join("\n"),
        });
      }
      return;
    case "manual":
      logger.warn({
        message: [
          `System trust not changed (code=${system.code}):`,
          ...system.steps,
        ].join("\n"),
      });
      return;
    case "pending":
      logger.warn({
        message: [
          `System trust not changed (code=${system.code}). Run:`,
          ...system.commands.map((command) => `  ${renderSudo(command)}`),
        ].join("\n"),
      });
      return;
    case "failed":
      logger.warn({
        message: `System trust failed (code=${system.code}): \`${renderSudo(system.failedCommand)}\` exited ${system.exitCode}`,
      });
      return;
    case "applied_unverified":
      logger.warn({
        message: `System trust commands ran, but ${system.bundlePath} still lacks Caddy's local CA.`,
      });
      return;
    default:
      return;
  }
}

const NSS_VERBS = {
  added: "Added Caddy's local CA to",
  replaced: "Replaced the CA in",
  trust_set: "Set TLS issuer trust on Caddy's local CA in",
} as const;

async function applyNss(opts: {
  readonly deps: LinuxTrustCommandDeps;
  readonly ca: ValidatedCa;
  readonly stagedPath: string;
}): Promise<boolean> {
  const nss = await applyLinuxNssTrust({
    host: opts.deps.host,
    ca: opts.ca,
    stagedPath: opts.stagedPath,
  });
  if (nss.status === "certutil_missing") {
    logger.warn({ message: `${nss.hint} (code=${nss.code})` });
    return true;
  }
  let ok = true;
  for (const db of nss.databases) {
    if (db.status === "failed") {
      ok = false;
      logger.warn({
        message: `Could not trust the CA in NSS db ${db.dbDir}: ${db.reason ?? "unknown error"}`,
      });
    } else if (db.status === "refused") {
      logger.warn({
        message: `Skipped NSS db ${db.dbDir}: ${db.reason ?? "not owned by you"}`,
      });
    } else if (db.status !== "trusted") {
      logger.success({ message: `${NSS_VERBS[db.status]} NSS db ${db.dbDir}` });
    }
  }
  if (
    nss.databases.some(
      (db) =>
        db.status === "added" ||
        db.status === "replaced" ||
        db.status === "trust_set"
    )
  ) {
    note("Restart the browser so it reloads its certificate store.", "TLS");
  }
  return ok;
}
