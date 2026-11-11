/**
 * Inspect, apply and remove Hack's Linux host DNS route.
 *
 * All host effects go through {@link LinuxDnsHost}. Root-only steps are a
 * plain list of argv arrays: the caller shows them, and they run (each with
 * `sudo`) only after an interactive confirmation. A run that cannot prompt
 * gets the same list back with a stable code and changes nothing.
 */
import { DEFAULT_COREDNS_IP, DEFAULT_INGRESS_GATEWAY } from "../constants.ts";
import {
  detectLinuxResolver,
  dnsmasqRoutesDomains,
  isResolvedKind,
  LINUX_DNS_MIN_SYSTEMD,
  LINUX_DNS_UDEV_RULE_PATH,
  LINUX_DNS_UNIT_PATH,
  type LinuxDnsCode,
  type LinuxLinkRoute,
  type LinuxResolverDetection,
  linkRouteMatches,
  NM_DNSMASQ_DIR,
  renderLinuxDnsUdevRule,
  renderLinuxDnsUnit,
  renderLinuxManualDnsSteps,
  renderNetworkManagerDnsmasqConf,
} from "./linux-dns.ts";

/** Host boundary. Implementations must not write outside the staging dir. */
export type LinuxDnsHost = {
  /** File text, or `null` when absent or unreadable. */
  readonly readFile: (path: string) => Promise<string | null>;
  /** Entry names in a directory, or `[]` when absent. */
  readonly listDir: (path: string) => Promise<readonly string[]>;
  readonly isResolvedActive: () => Promise<boolean>;
  /** Major systemd version (`systemctl --version`), or `null` when unknown. */
  readonly systemdVersion: () => Promise<number | null>;
  /** The interface carrying `address`, or `null`. */
  readonly findLinkWithAddress: (address: string) => Promise<string | null>;
  /** systemd-resolved's per-link state, or `null` when unreadable. */
  readonly readLinkRoute: (link: string) => Promise<LinuxLinkRoute | null>;
  /** Write a user-owned copy for a privileged `install`; returns its path. */
  readonly stageFile: (opts: {
    readonly name: string;
    readonly content: string;
  }) => Promise<string>;
  /** Run `sudo <argv>` with the terminal attached; returns the exit code. */
  readonly runPrivileged: (argv: readonly string[]) => Promise<number>;
};

export type LinuxDnsRouteState =
  | "configured"
  | "missing"
  | "stale"
  | "not_applied"
  | "bridge_missing"
  | "manual";

export type LinuxDnsInspection = {
  readonly resolver: LinuxResolverDetection;
  readonly state: LinuxDnsRouteState;
  /** `null` exactly when `state` is `configured`. */
  readonly code: LinuxDnsCode | null;
  /** Hack's bridge interface when one carries the gateway address. */
  readonly link: string | null;
  readonly message: string;
  /** What fixes it: a command to run, or manual steps. */
  readonly fix: readonly string[];
};

const NM_CONF = "/etc/NetworkManager/NetworkManager.conf";
/** NetworkManager merges these by file name; a later directory wins a tie. */
const NM_CONF_DIRS = [
  "/usr/lib/NetworkManager/conf.d",
  "/run/NetworkManager/conf.d",
  "/etc/NetworkManager/conf.d",
] as const;

async function readNetworkManagerConf(
  host: LinuxDnsHost
): Promise<string | null> {
  const parts: string[] = [];
  const main = await host.readFile(NM_CONF);
  if (main !== null) {
    parts.push(main);
  }
  const byName = new Map<string, string>();
  for (const dir of NM_CONF_DIRS) {
    for (const name of await host.listDir(dir)) {
      if (name.endsWith(".conf")) {
        byName.set(name, `${dir}/${name}`);
      }
    }
  }
  for (const name of [...byName.keys()].sort()) {
    const text = await host.readFile(byName.get(name) ?? "");
    if (text !== null) {
      parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

export async function detectHostResolver(
  host: LinuxDnsHost
): Promise<LinuxResolverDetection> {
  const [resolvedActive, resolvConf, nsswitchConf, networkManagerConf] =
    await Promise.all([
      host.isResolvedActive(),
      host.readFile("/etc/resolv.conf"),
      host.readFile("/etc/nsswitch.conf"),
      readNetworkManagerConf(host),
    ]);
  return detectLinuxResolver({
    resolvedActive,
    resolvConf,
    nsswitchConf,
    networkManagerConf,
  });
}

async function nmDnsmasqRoutes(opts: {
  readonly host: LinuxDnsHost;
  readonly domains: readonly string[];
}): Promise<boolean> {
  const names = (await opts.host.listDir(NM_DNSMASQ_DIR)).filter((name) =>
    name.endsWith(".conf")
  );
  const texts = await Promise.all(
    names.map((name) => opts.host.readFile(`${NM_DNSMASQ_DIR}/${name}`))
  );
  return dnsmasqRoutesDomains({
    text: texts.filter((text) => text !== null).join("\n"),
    domains: opts.domains,
  });
}

/** Read-only assessment used by install, doctor and `hack global status`. */
export async function inspectLinuxDns(opts: {
  readonly host: LinuxDnsHost;
  readonly domains: readonly string[];
}): Promise<LinuxDnsInspection> {
  const { host, domains } = opts;
  const resolver = await detectHostResolver(host);
  const link = await host.findLinkWithAddress(DEFAULT_INGRESS_GATEWAY);

  if (!isResolvedKind(resolver.kind)) {
    if (
      resolver.kind === "networkmanager-dnsmasq" &&
      (await nmDnsmasqRoutes({ host, domains }))
    ) {
      return {
        resolver,
        state: "configured",
        code: null,
        link,
        message: `NetworkManager dnsmasq routes ${describeDomains(domains)}`,
        fix: [],
      };
    }
    return {
      resolver,
      state: "manual",
      code: "linux_dns_resolver_manual",
      link,
      message: `Hack configures DNS only through systemd-resolved; this host uses ${resolver.kind}`,
      fix: renderLinuxManualDnsSteps({ kind: resolver.kind, domains }),
    };
  }
  return await inspectResolvedRoute({ host, domains, resolver, link });
}

async function inspectResolvedRoute(opts: {
  readonly host: LinuxDnsHost;
  readonly domains: readonly string[];
  readonly resolver: LinuxResolverDetection;
  readonly link: string | null;
}): Promise<LinuxDnsInspection> {
  const { host, domains, resolver, link } = opts;
  const base = { resolver, link } as const;
  const version = await host.systemdVersion();
  if (version !== null && version < LINUX_DNS_MIN_SYSTEMD) {
    return {
      ...base,
      state: "manual",
      code: "linux_dns_systemd_too_old",
      message: `systemd ${version} is older than ${LINUX_DNS_MIN_SYSTEMD}; its resolvectl cannot set a routing-only link`,
      fix: [
        "Upgrade systemd, or route the suffixes another way, for example a local dnsmasq with:",
        ...renderNetworkManagerDnsmasqConf({ domains })
          .trimEnd()
          .split("\n")
          .map((line) => `  ${line}`),
      ],
    };
  }
  const [unit, rule] = await Promise.all([
    host.readFile(LINUX_DNS_UNIT_PATH),
    host.readFile(LINUX_DNS_UDEV_RULE_PATH),
  ]);
  if (link === null && unit === null && rule === null) {
    // Nothing installed yet and no host bridge to route to (network down,
    // Docker Desktop, rootless Docker): writing root files cannot help.
    return {
      ...base,
      state: "bridge_missing",
      code: "linux_dns_bridge_missing",
      message: BRIDGE_MISSING_MESSAGE,
      fix: [
        "hack global up, then hack global install (Docker Desktop and rootless Docker cannot use this route)",
      ],
    };
  }
  if (unit === null && rule === null) {
    return {
      ...base,
      state: "missing",
      code: "linux_dns_route_missing",
      message: `No Hack DNS route for ${describeDomains(domains)}`,
      fix: ["hack global install"],
    };
  }
  if (
    unit !== renderLinuxDnsUnit({ domains }) ||
    rule !== renderLinuxDnsUdevRule()
  ) {
    return {
      ...base,
      state: "stale",
      code: "linux_dns_route_stale",
      message: `${LINUX_DNS_UNIT_PATH} or ${LINUX_DNS_UDEV_RULE_PATH} is missing or differs from the expected route for ${describeDomains(domains)}`,
      fix: ["hack global install"],
    };
  }
  if (link === null) {
    return {
      ...base,
      state: "bridge_missing",
      code: "linux_dns_bridge_missing",
      message: BRIDGE_MISSING_MESSAGE,
      fix: ["hack global up"],
    };
  }
  const route = await host.readLinkRoute(link);
  if (!linkRouteMatches({ route, domains })) {
    return {
      ...base,
      state: "not_applied",
      code: "linux_dns_route_not_applied",
      message: `${link} has no Hack DNS route yet`,
      fix: [`sudo systemctl start hack-dns@${link}.service`],
    };
  }
  if (resolver.lookupsBypassResolved) {
    return {
      ...base,
      state: "manual",
      code: "linux_dns_resolved_bypassed",
      message: `${link} routes ${describeDomains(domains)}, but lookups bypass systemd-resolved`,
      fix: renderLinuxManualDnsSteps({ kind: resolver.kind, domains }),
    };
  }
  return {
    ...base,
    state: "configured",
    code: null,
    message: `${link} routes ${describeDomains(domains)}`,
    fix: [],
  };
}

const BRIDGE_MISSING_MESSAGE = `No host interface carries ${DEFAULT_INGRESS_GATEWAY}: the hack-dev network is down, or Docker runs in a VM (Docker Desktop) or rootless, where the host cannot route to its bridge`;

function describeDomains(domains: readonly string[]): string {
  return domains.map((domain) => `*.${domain}`).join(", ");
}

/** A privileged plan: every command runs as `sudo <argv>`. */
export type LinuxDnsPlan = {
  /** Files to install, with the rendered content shown to the user. */
  readonly files: readonly {
    readonly path: string;
    readonly content: string;
  }[];
  readonly commands: readonly (readonly string[])[];
  /** Caveats shown with the plan, before any prompt. */
  readonly notes?: readonly string[];
};

export function renderPrivilegedCommand(argv: readonly string[]): string {
  return ["sudo", ...argv].map(shellQuoteIfNeeded).join(" ");
}

const SAFE_SHELL_WORD = /^[\w@%+=:,./~-]+$/;

function shellQuoteIfNeeded(word: string): string {
  return SAFE_SHELL_WORD.test(word)
    ? word
    : `'${word.replaceAll("'", "'\\''")}'`;
}

export type LinuxDnsApplyOutcome =
  | { readonly status: "configured"; readonly inspection: LinuxDnsInspection }
  | {
      /** Nothing Hack can apply; `inspection.fix` holds the manual steps. */
      readonly status: "manual";
      readonly inspection: LinuxDnsInspection;
    }
  | {
      /** Not applied: no prompt was possible or the user declined. */
      readonly status: "pending";
      readonly code: LinuxDnsCode;
      readonly plan: LinuxDnsPlan;
      readonly inspection: LinuxDnsInspection;
    }
  | {
      readonly status: "failed";
      readonly code: LinuxDnsCode;
      readonly plan: LinuxDnsPlan;
      readonly failedCommand: readonly string[];
      readonly exitCode: number;
    }
  | {
      /** Commands ran; the route is still not active (see `inspection`). */
      readonly status: "applied_unverified";
      readonly inspection: LinuxDnsInspection;
    };

async function buildApplyPlan(opts: {
  readonly host: LinuxDnsHost;
  readonly domains: readonly string[];
  readonly inspection: LinuxDnsInspection;
}): Promise<LinuxDnsPlan> {
  const { host, domains, inspection } = opts;
  const files: { path: string; content: string }[] = [];
  const commands: string[][] = [];
  if (inspection.state === "missing" || inspection.state === "stale") {
    const unit = renderLinuxDnsUnit({ domains });
    const rule = renderLinuxDnsUdevRule();
    const unitStage = await host.stageFile({
      name: "hack-dns@.service",
      content: unit,
    });
    const ruleStage = await host.stageFile({
      name: "90-hack-dns.rules",
      content: rule,
    });
    files.push(
      { path: LINUX_DNS_UNIT_PATH, content: unit },
      { path: LINUX_DNS_UDEV_RULE_PATH, content: rule }
    );
    commands.push(
      installArgv({ source: unitStage, target: LINUX_DNS_UNIT_PATH }),
      installArgv({ source: ruleStage, target: LINUX_DNS_UDEV_RULE_PATH }),
      ["systemctl", "daemon-reload"],
      ["udevadm", "control", "--reload"]
    );
  }
  if (inspection.link !== null) {
    // `restart` re-runs the oneshot even if an earlier start already ran.
    commands.push([
      "systemctl",
      "restart",
      `hack-dns@${inspection.link}.service`,
    ]);
  }
  return { files, commands };
}

function installArgv(opts: {
  readonly source: string;
  readonly target: string;
}): string[] {
  return [
    "install",
    "-D",
    "-o",
    "root",
    "-g",
    "root",
    "-m",
    "0644",
    opts.source,
    opts.target,
  ];
}

/**
 * Bring the route to the configured state. `confirm` is asked once, after the
 * plan is shown through `show`, and only when `canPrompt` is true.
 */
export async function applyLinuxDns(opts: {
  readonly host: LinuxDnsHost;
  readonly domains: readonly string[];
  readonly canPrompt: boolean;
  readonly show: (plan: LinuxDnsPlan) => void;
  readonly confirm: () => Promise<boolean>;
}): Promise<LinuxDnsApplyOutcome> {
  const { host, domains } = opts;
  const inspection = await inspectLinuxDns({ host, domains });
  if (inspection.state === "configured") {
    return { status: "configured", inspection };
  }
  if (
    inspection.state === "manual" ||
    inspection.state === "bridge_missing" ||
    inspection.code === null
  ) {
    return { status: "manual", inspection };
  }
  const built = await buildApplyPlan({ host, domains, inspection });
  const plan: LinuxDnsPlan = inspection.resolver.lookupsBypassResolved
    ? {
        ...built,
        notes: [
          "Lookups on this host bypass systemd-resolved, so the route has no effect until /etc/resolv.conf points at its stub:",
          ...renderLinuxManualDnsSteps({
            kind: inspection.resolver.kind,
            domains,
          }),
        ],
      }
    : built;
  if (!opts.canPrompt) {
    return { status: "pending", code: inspection.code, plan, inspection };
  }
  opts.show(plan);
  if (!(await opts.confirm())) {
    return { status: "pending", code: inspection.code, plan, inspection };
  }
  for (const command of plan.commands) {
    const exitCode = await host.runPrivileged(command);
    if (exitCode !== 0) {
      return {
        status: "failed",
        code: inspection.code,
        plan,
        failedCommand: command,
        exitCode,
      };
    }
  }
  const after = await inspectLinuxDns({ host, domains });
  return after.state === "configured"
    ? { status: "configured", inspection: after }
    : { status: "applied_unverified", inspection: after };
}

export type LinuxDnsRemoveOutcome =
  | { readonly status: "absent" }
  | { readonly status: "declined"; readonly plan: LinuxDnsPlan }
  | { readonly status: "removed" }
  | {
      readonly status: "failed";
      readonly failedCommand: readonly string[];
      readonly exitCode: number;
    };

/** Undo {@link applyLinuxDns}: revert the link and delete both files. */
export async function removeLinuxDns(opts: {
  readonly host: LinuxDnsHost;
  readonly confirm: (plan: LinuxDnsPlan) => Promise<boolean>;
}): Promise<LinuxDnsRemoveOutcome> {
  const { host } = opts;
  const [unit, rule, link] = await Promise.all([
    host.readFile(LINUX_DNS_UNIT_PATH),
    host.readFile(LINUX_DNS_UDEV_RULE_PATH),
    host.findLinkWithAddress(DEFAULT_INGRESS_GATEWAY),
  ]);
  const route = link === null ? null : await host.readLinkRoute(link);
  // Any CoreDNS server on the link is Hack's, whatever domains it carries
  // (default_domain may have changed since install, or apply was partial).
  const routeActive = route?.dns.includes(DEFAULT_COREDNS_IP) === true;
  if (unit === null && rule === null && !routeActive) {
    return { status: "absent" };
  }
  const commands: string[][] = [];
  if (link !== null && routeActive) {
    commands.push(["resolvectl", "revert", link]);
  }
  if (unit !== null || rule !== null) {
    commands.push(
      ["rm", "-f", LINUX_DNS_UNIT_PATH, LINUX_DNS_UDEV_RULE_PATH],
      ["systemctl", "daemon-reload"],
      ["udevadm", "control", "--reload"]
    );
  }
  const plan: LinuxDnsPlan = { files: [], commands };
  if (!(await opts.confirm(plan))) {
    return { status: "declined", plan };
  }
  for (const command of commands) {
    const exitCode = await host.runPrivileged(command);
    if (exitCode !== 0) {
      return { status: "failed", failedCommand: command, exitCode };
    }
  }
  return { status: "removed" };
}
