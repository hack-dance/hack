/**
 * `hack global trust` wiring for Linux: the distribution trust store (root,
 * confirmed) and NSS browser databases (no root). Decisions live in
 * `lib/linux-trust*.ts`.
 */
import { note } from "@clack/prompts";
import { canPrompt, confirmSafe } from "../lib/interactivity.ts";
import { createLinuxTrustHost } from "../lib/linux-trust-host.ts";
import {
  applyLinuxNssTrust,
  applyLinuxSystemTrust,
  type LinuxTrustHost,
} from "../lib/linux-trust-setup.ts";
import { logger } from "../ui/logger.ts";

const SAFE_SHELL_WORD = /^[\w@%+=:,./~-]+$/;

function renderSudo(argv: readonly string[]): string {
  return ["sudo", ...argv]
    .map((word) =>
      SAFE_SHELL_WORD.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`
    )
    .join(" ");
}

/** Returns false only when a step Hack attempted failed. */
export async function configureLinuxSystemAndBrowserTrust(opts: {
  readonly certPath: string;
  readonly host?: LinuxTrustHost;
}): Promise<boolean> {
  const host = opts.host ?? createLinuxTrustHost();
  let ok = true;

  const system = await applyLinuxSystemTrust({
    host,
    certPath: opts.certPath,
    canPrompt: canPrompt(),
    show: (commands) =>
      note(
        [
          `Add ${opts.certPath} to the system trust store. Commands (each runs with sudo):`,
          ...commands.map((command) => `  ${renderSudo(command)}`),
        ].join("\n"),
        "System trust"
      ),
    confirm: async () =>
      await confirmSafe({
        message: "Trust Caddy's local CA system-wide now? (requires sudo)",
        initialValue: true,
        nonInteractive: "decline",
      }),
  });
  switch (system.status) {
    case "trusted":
      logger.success({
        message: `System trust store (${system.family}) trusts Caddy's local CA`,
      });
      break;
    case "manual":
      logger.warn({
        message: [
          `System trust not changed (code=${system.code}):`,
          ...system.steps,
        ].join("\n"),
      });
      break;
    case "pending":
      logger.warn({
        message: [
          `System trust not changed (code=${system.code}). Run:`,
          ...system.commands.map((command) => `  ${renderSudo(command)}`),
        ].join("\n"),
      });
      break;
    case "failed":
      ok = false;
      logger.warn({
        message: `System trust failed (code=${system.code}): \`${renderSudo(system.failedCommand)}\` exited ${system.exitCode}`,
      });
      break;
    case "applied_unverified":
      logger.warn({
        message: `System trust commands ran, but ${system.bundlePath} still lacks Caddy's local CA.`,
      });
      break;
    default:
      break;
  }

  const nss = await applyLinuxNssTrust({ host, certPath: opts.certPath });
  if (nss.status === "certutil_missing") {
    logger.warn({ message: `${nss.hint} (code=${nss.code})` });
    return ok;
  }
  for (const db of nss.databases) {
    if (db.status === "failed") {
      ok = false;
      logger.warn({ message: `Could not add the CA to NSS db ${db.dbDir}` });
    } else if (db.status !== "trusted") {
      logger.success({
        message: `${db.status === "replaced" ? "Replaced" : "Added"} Caddy's local CA in NSS db ${db.dbDir}`,
      });
    }
  }
  if (nss.databases.some((db) => db.status !== "trusted")) {
    note("Restart the browser so it reloads its certificate store.", "TLS");
  }
  return ok;
}
