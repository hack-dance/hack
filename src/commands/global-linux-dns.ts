/**
 * `hack global` wiring for Linux host DNS. Decisions live in
 * `lib/linux-dns*.ts`; this file renders them and supplies the prompts.
 */
import { resolve } from "node:path";
import { note } from "@clack/prompts";
import { DEFAULT_COREDNS_IP, DEFAULT_INGRESS_SUBNET } from "../constants.ts";
import { resolveGlobalHackDir } from "../lib/config-paths.ts";
import {
  managedLocalDomains,
  resolveDefaultDomain,
} from "../lib/default-domain.ts";
import { canPrompt, confirmSafe } from "../lib/interactivity.ts";
import { createLinuxDnsHost } from "../lib/linux-dns-host.ts";
import {
  applyLinuxDns,
  inspectLinuxDns,
  type LinuxDnsHost,
  type LinuxDnsInspection,
  type LinuxDnsPlan,
  removeLinuxDns,
  renderPrivilegedCommand,
} from "../lib/linux-dns-setup.ts";
import { logger } from "../ui/logger.ts";

function defaultHost(): LinuxDnsHost {
  return createLinuxDnsHost({
    stageDir: resolve(resolveGlobalHackDir(), "tmp", "linux-dns"),
  });
}

async function resolveRoutedDomains(): Promise<readonly string[]> {
  return managedLocalDomains(await resolveDefaultDomain());
}

function renderPlanLines(plan: LinuxDnsPlan): string[] {
  return [
    ...plan.files.flatMap((file) => [
      `Write ${file.path}:`,
      ...file.content
        .trimEnd()
        .split("\n")
        .map((line) => `  ${line}`),
    ]),
    "Commands (each runs with sudo):",
    ...plan.commands.map((command) => `  ${renderPrivilegedCommand(command)}`),
  ];
}

/**
 * `hack global install` on Linux. Never runs sudo without an interactive yes;
 * a run that cannot prompt prints the commands and a stable code instead.
 */
export async function bootstrapLinuxGlobalDns(opts: {
  readonly useStaticIps: boolean;
  readonly host?: LinuxDnsHost;
}): Promise<void> {
  const domains = await resolveRoutedDomains();
  if (!opts.useStaticIps) {
    logger.warn({
      message: `Skipping Linux DNS setup: the hack-dev network has no ${DEFAULT_INGRESS_SUBNET} subnet, so CoreDNS has no fixed address (${DEFAULT_COREDNS_IP}) to route to. Recreate the network with hack global install after removing it.`,
    });
    return;
  }
  const host = opts.host ?? defaultHost();
  const outcome = await applyLinuxDns({
    host,
    domains,
    canPrompt: canPrompt(),
    show: (plan) => note(renderPlanLines(plan).join("\n"), "Linux DNS"),
    confirm: async () =>
      await confirmSafe({
        message: "Apply these DNS changes now? (requires sudo)",
        initialValue: true,
        nonInteractive: "decline",
      }),
  });
  switch (outcome.status) {
    case "configured":
      logger.success({ message: `DNS: ${outcome.inspection.message}` });
      return;
    case "manual":
      reportInspection({ inspection: outcome.inspection });
      return;
    case "pending":
      logger.warn({
        message: [
          `Linux DNS not applied (code=${outcome.code}). Run these commands, then check with hack doctor:`,
          ...outcome.plan.commands.map(
            (command) => `  ${renderPrivilegedCommand(command)}`
          ),
        ].join("\n"),
      });
      return;
    case "failed":
      logger.warn({
        message: `Linux DNS setup failed (code=${outcome.code}): \`${renderPrivilegedCommand(outcome.failedCommand)}\` exited ${outcome.exitCode}. Rerun hack global install, or run the remaining commands by hand.`,
      });
      return;
    case "applied_unverified":
      reportInspection({ inspection: outcome.inspection });
      return;
    default:
      return;
  }
}

function reportInspection(opts: {
  readonly inspection: LinuxDnsInspection;
}): void {
  const { inspection } = opts;
  const code = inspection.code ? ` (code=${inspection.code})` : "";
  logger.warn({
    message: [
      `Linux DNS: ${inspection.message}${code}`,
      ...inspection.fix.map((line) => `  ${line}`),
    ].join("\n"),
  });
}

/** Read-only state for `hack doctor` and `hack global status`. */
export async function inspectLinuxGlobalDns(opts?: {
  readonly host?: LinuxDnsHost;
}): Promise<LinuxDnsInspection> {
  return await inspectLinuxDns({
    host: opts?.host ?? defaultHost(),
    domains: await resolveRoutedDomains(),
  });
}

/** JSON shape for `hack global status --json`. */
export function linuxDnsStatusPayload(inspection: LinuxDnsInspection) {
  return {
    platform: "linux",
    resolver: inspection.resolver.kind,
    state: inspection.state,
    code: inspection.code,
    link: inspection.link,
    message: inspection.message,
    fix: inspection.fix,
  } as const;
}

/**
 * `hack global down` on Linux: offer to undo the DNS route (the counterpart
 * of stopping dnsmasq on macOS). Defaults to no; non-interactive runs keep it.
 */
export async function offerLinuxGlobalDnsRemoval(opts?: {
  readonly host?: LinuxDnsHost;
}): Promise<void> {
  const outcome = await removeLinuxDns({
    host: opts?.host ?? defaultHost(),
    domains: await resolveRoutedDomains(),
    confirm: async (plan) =>
      await confirmSafe({
        message: [
          "Remove Hack's Linux DNS route? (disables Hack's routed suffixes on this host; requires sudo)",
          ...renderPlanLines(plan),
        ].join("\n"),
        initialValue: false,
        nonInteractive: "accept-default",
      }),
  });
  if (outcome.status === "removed") {
    logger.success({ message: "Removed Hack's Linux DNS route" });
  } else if (outcome.status === "failed") {
    logger.warn({
      message: `Removing Hack's Linux DNS route failed: \`${renderPrivilegedCommand(outcome.failedCommand)}\` exited ${outcome.exitCode}`,
    });
  }
}
