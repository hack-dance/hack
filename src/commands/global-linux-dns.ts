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
  renderManualPlan,
  renderPrivilegedCommand,
} from "../lib/linux-dns-setup.ts";
import { logger } from "../ui/logger.ts";

function defaultHost(): LinuxDnsHost {
  return createLinuxDnsHost({
    stageRoot: resolve(resolveGlobalHackDir(), "tmp"),
  });
}

async function resolveRoutedDomains(): Promise<readonly string[]> {
  return managedLocalDomains(await resolveDefaultDomain());
}

function renderPlanLines(plan: LinuxDnsPlan): string[] {
  return [
    ...(plan.notes ?? []),
    ...plan.files.flatMap((file) => [
      `Install ${file.path} (root installs a private copy only if it matches this content):`,
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
 * Linux DNS result of `hack global install`: `configured`; `skipped` when
 * nothing was changed (declined, non-interactive, or a manual-only host;
 * the steps are printed); `failed` when a step the user confirmed failed or
 * left the route inactive. Only `failed` makes the install exit non-zero.
 */
export type LinuxDnsInstallResult = "configured" | "skipped" | "failed";

/**
 * `hack global install` on Linux. Never runs sudo without an interactive yes;
 * a run that cannot prompt prints the commands and a stable code instead.
 */
export async function bootstrapLinuxGlobalDns(opts: {
  readonly useStaticIps: boolean;
  readonly host?: LinuxDnsHost;
  /** Test seam; defaults to the terminal prompt. */
  readonly prompt?: {
    readonly canPrompt: boolean;
    readonly confirm: () => Promise<boolean>;
  };
}): Promise<LinuxDnsInstallResult> {
  const domains = await resolveRoutedDomains();
  if (!opts.useStaticIps) {
    logger.warn({
      message: `Skipping Linux DNS setup: the hack-dev network has no ${DEFAULT_INGRESS_SUBNET} subnet, so CoreDNS has no fixed address (${DEFAULT_COREDNS_IP}) to route to. Recreate the network with hack global install after removing it.`,
    });
    return "skipped";
  }
  const host = opts.host ?? defaultHost();
  const outcome = await applyLinuxDns({
    host,
    domains,
    canPrompt: opts.prompt?.canPrompt ?? canPrompt(),
    show: (plan) => note(renderPlanLines(plan).join("\n"), "Linux DNS"),
    confirm:
      opts.prompt?.confirm ??
      (async () => {
        try {
          return await confirmSafe({
            message: "Apply these DNS changes now? (requires sudo)",
            initialValue: true,
            nonInteractive: "decline",
          });
        } catch (error) {
          // Ctrl-C at the prompt (confirmSafe throws "Canceled"): treat as
          // "no" so install still finishes. Any other error propagates.
          if (error instanceof Error && error.message === "Canceled") {
            return false;
          }
          throw error;
        }
      }),
  });
  switch (outcome.status) {
    case "configured":
      logger.success({ message: `DNS: ${outcome.inspection.message}` });
      return "configured";
    case "manual":
      reportInspection({ inspection: outcome.inspection });
      return "skipped";
    case "pending":
      logger.warn({
        message: [
          `Linux DNS not applied (code=${outcome.code}). Run these commands, then check with hack doctor:`,
          ...(outcome.plan.notes ?? []),
          ...renderManualPlan(outcome.plan).map((line) => `  ${line}`),
        ].join("\n"),
      });
      return "skipped";
    case "failed":
      logger.error({
        message: `Linux DNS setup failed (code=${outcome.code}): \`${outcome.failedStep}\` exited ${outcome.exitCode}. Rerun hack global install, or run these commands by hand:\n${renderManualPlan(
          outcome.plan
        )
          .map((line) => `  ${line}`)
          .join("\n")}`,
      });
      return "failed";
    case "applied_unverified":
      reportInspection({ inspection: outcome.inspection });
      // The confirmed steps ran; only the bypassed-resolver note is expected.
      return outcome.inspection.code === "linux_dns_resolved_bypassed"
        ? "skipped"
        : "failed";
    default:
      return "failed";
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
 * Only files and link settings that are exactly Hack's are removed.
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
      message: `Removing Hack's Linux DNS route failed: \`${outcome.failedStep}\` exited ${outcome.exitCode}`,
    });
  }
  if (outcome.leftInPlace.length > 0) {
    logger.warn({
      message: [
        "Linux DNS: left in place",
        ...outcome.leftInPlace.map((line) => `  ${line}`),
      ].join("\n"),
    });
  }
}
