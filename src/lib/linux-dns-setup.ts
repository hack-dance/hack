/**
 * Inspect, apply and remove Hack's Linux host DNS route.
 *
 * All host effects go through {@link LinuxDnsHost}. Root-only steps are
 * shown first and run (each with `sudo`) only after an interactive
 * confirmation. A run that cannot prompt gets the same plan back with a
 * stable code and changes nothing. Root never opens a path the user can
 * write: file content reaches root on stdin (`privileged-install.ts`).
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
  readLinuxDnsMarker,
  renderLinuxDnsUdevRule,
  renderLinuxDnsUnit,
  renderLinuxManualDnsSteps,
  renderManualLinkRouteSteps,
  renderNetworkManagerDnsmasqConf,
  unitInstanceForInterface,
} from "./linux-dns.ts";
import { stdinInstallStep } from "./privileged-install.ts";

/** Host boundary. Implementations write nothing except through `runPrivileged`. */
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
  /**
   * systemd's `NeedDaemonReload` for a unit: `true` when its file changed
   * since systemd loaded it, `null` when unknown.
   */
  readonly unitNeedsReload: (unit: string) => Promise<boolean | null>;
  /**
   * Run `sudo <argv>` with the terminal attached; returns the exit code.
   * `input`, when given, is the child's stdin (sudo prompts on the terminal).
   */
  readonly runPrivileged: (
    argv: readonly string[],
    opts?: { readonly input?: Uint8Array }
  ) => Promise<number>;
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
const NM_VENDOR_CONF_DIR = "/usr/lib/NetworkManager/conf.d";
const NM_RUN_CONF_DIR = "/run/NetworkManager/conf.d";
const NM_ETC_CONF_DIR = "/etc/NetworkManager/conf.d";

async function readNetworkManagerConf(
  host: LinuxDnsHost
): Promise<string | null> {
  // NetworkManager.conf(5): a snippet name in /etc shadows /run, which
  // shadows /usr/lib. Parse order: /usr/lib snippets, then /run snippets,
  // then NetworkManager.conf, then /etc snippets, each directory sorted by
  // name on its own; later values win.
  const byName = new Map<string, string>();
  for (const dir of NM_CONF_DIRS) {
    for (const name of await host.listDir(dir)) {
      if (name.endsWith(".conf")) {
        byName.set(name, dir);
      }
    }
  }
  const snippetsIn = (dir: string) =>
    [...byName.entries()]
      .filter(([, owner]) => owner === dir)
      .map(([name]) => name)
      .sort()
      .map((name) => `${dir}/${name}`);
  const paths = [
    ...snippetsIn(NM_VENDOR_CONF_DIR),
    ...snippetsIn(NM_RUN_CONF_DIR),
    NM_CONF,
    ...snippetsIn(NM_ETC_CONF_DIR),
  ];
  const parts: string[] = [];
  for (const path of paths) {
    const text = await host.readFile(path);
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
      fix: renderLinuxManualDnsSteps({
        kind: resolver.kind,
        domains,
      }),
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
  if (link !== null && unitInstanceForInterface(link) === null) {
    return {
      ...base,
      state: "manual",
      code: "linux_dns_interface_unsupported",
      message: `Hack's bridge has a name Hack does not configure automatically (${JSON.stringify(link)})`,
      fix: renderManualLinkRouteSteps({ link, domains }),
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
      message: `${link} does not carry exactly Hack's DNS route (CoreDNS only, Hack's suffixes only, default-route, DNSSEC and DNS-over-TLS off)`,
      fix: ["hack global install"],
    };
  }
  // Matching files and a matching link do not prove systemd loaded the
  // current unit: a failed daemon-reload leaves the old one cached.
  if ((await host.unitNeedsReload(`hack-dns@${link}.service`)) !== false) {
    return {
      ...base,
      state: "not_applied",
      code: "linux_dns_reload_pending",
      message: `systemd has not loaded the current ${LINUX_DNS_UNIT_PATH} (reload pending or unknown)`,
      fix: ["hack global install"],
    };
  }
  if (resolver.lookupsBypassResolved) {
    return {
      ...base,
      state: "manual",
      code: "linux_dns_resolved_bypassed",
      message: `${link} routes ${describeDomains(domains)}, but lookups bypass systemd-resolved`,
      fix: renderLinuxManualDnsSteps({
        kind: resolver.kind,
        domains,
      }),
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

/**
 * A privileged plan. Each file is installed by root from bytes Hack sends on
 * stdin, checked against the digest of the content shown; then every command
 * runs as `sudo <argv>`.
 */
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

const HEREDOC_END = "HACK_DNS_FILE_END";

/**
 * The plan as commands a person can paste. Each file goes through the same
 * root stdin installer Hack runs itself (same byte count, digest, directory
 * checks and rename into place; a missing directory is created only by it),
 * with the content as a quoted heredoc (no expansion). A heredoc adds one
 * trailing newline, so the content must end with exactly one and must not
 * contain the terminator line; Hack's rendered files satisfy both.
 */
export function renderManualPlan(plan: LinuxDnsPlan): readonly string[] {
  return [
    ...plan.files.flatMap((file) => {
      const body = file.content.slice(0, -1).split("\n");
      if (
        !file.content.endsWith("\n") ||
        file.content.endsWith("\n\n") ||
        body.includes(HEREDOC_END)
      ) {
        throw new Error(`Cannot render ${file.path} as an exact heredoc`);
      }
      const step = stdinInstallStep({
        target: file.path,
        content: file.content,
      });
      return [
        `${renderPrivilegedCommand(step.argv)} <<'${HEREDOC_END}'`,
        ...body,
        HEREDOC_END,
      ];
    }),
    ...plan.commands.map(renderPrivilegedCommand),
  ];
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
      /** The step that failed, as shown to the user. */
      readonly failedStep: string;
      readonly exitCode: number;
    }
  | {
      /** Commands ran; the route is still not active (see `inspection`). */
      readonly status: "applied_unverified";
      readonly inspection: LinuxDnsInspection;
    };

/**
 * Every repair runs the whole sequence: install the files when they differ,
 * then always reload systemd and udev and restart the instance. Matching
 * files on disk do not prove an earlier reload succeeded, so a retry after a
 * failed reload repeats it.
 */
function buildApplyPlan(opts: {
  readonly domains: readonly string[];
  readonly inspection: LinuxDnsInspection;
}): LinuxDnsPlan {
  const { domains, inspection } = opts;
  const files =
    inspection.state === "missing" || inspection.state === "stale"
      ? [
          {
            path: LINUX_DNS_UNIT_PATH,
            content: renderLinuxDnsUnit({ domains }),
          },
          { path: LINUX_DNS_UDEV_RULE_PATH, content: renderLinuxDnsUdevRule() },
        ]
      : [];
  const commands: string[][] = [
    ["systemctl", "daemon-reload"],
    ["udevadm", "control", "--reload"],
  ];
  const instance =
    inspection.link === null ? null : unitInstanceForInterface(inspection.link);
  if (instance !== null) {
    // `restart` re-runs the oneshot even if an earlier start already ran.
    commands.push([
      "systemctl",
      "restart",
      "--",
      `hack-dns@${instance}.service`,
    ]);
  }
  return { files, commands };
}

/** Notes for plan files that would replace a file Hack did not write. */
async function foreignFilesReplaced(opts: {
  readonly host: LinuxDnsHost;
  readonly plan: LinuxDnsPlan;
}): Promise<readonly string[]> {
  const notes: string[] = [];
  for (const file of opts.plan.files) {
    const existing = await opts.host.readFile(file.path);
    const marker = existing === null ? null : readLinuxDnsMarker(existing);
    if (marker?.kind === "none") {
      notes.push(
        `${file.path} exists without Hack's marker (Hack did not write it); installing replaces it.`
      );
    } else if (marker?.kind === "unknown-format") {
      notes.push(
        `${file.path} was written by a newer Hack (format=${marker.format}); installing replaces it with this Hack's version.`
      );
    }
  }
  return notes;
}

/** Run a confirmed plan: installs via stdin, then the commands, in order. */
async function runPlan(opts: {
  readonly host: LinuxDnsHost;
  readonly plan: LinuxDnsPlan;
}): Promise<{ readonly failedStep: string; readonly exitCode: number } | null> {
  const { host, plan } = opts;
  for (const step of linuxDnsRootSteps(plan)) {
    const exitCode = await host.runPrivileged(
      step.argv,
      step.input === undefined ? undefined : { input: step.input }
    );
    if (exitCode !== 0) {
      return { failedStep: step.description, exitCode };
    }
  }
  return null;
}

/** Ordered operations shared by the admin plan and the confirmed executor. */
export function linuxDnsRootSteps(plan: LinuxDnsPlan): readonly {
  readonly argv: readonly string[];
  readonly input?: Uint8Array;
  readonly description: string;
}[] {
  return [
    ...plan.files.map((file) => ({
      ...stdinInstallStep({ target: file.path, content: file.content }),
      description: `install ${file.path}`,
    })),
    ...plan.commands.map((argv) => ({
      argv,
      description: renderPrivilegedCommand(argv),
    })),
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
  const built = buildApplyPlan({ domains, inspection });
  const replaced = await foreignFilesReplaced({ host, plan: built });
  const withReplaced: LinuxDnsPlan =
    replaced.length > 0 ? { ...built, notes: replaced } : built;
  const plan: LinuxDnsPlan = inspection.resolver.lookupsBypassResolved
    ? {
        ...withReplaced,
        notes: [
          ...replaced,
          "Lookups on this host bypass systemd-resolved, so the route has no effect until they reach it:",
          ...renderLinuxManualDnsSteps({
            kind: inspection.resolver.kind,
            domains,
          }),
        ],
      }
    : withReplaced;
  if (!opts.canPrompt) {
    return { status: "pending", code: inspection.code, plan, inspection };
  }
  opts.show(plan);
  if (!(await opts.confirm())) {
    return { status: "pending", code: inspection.code, plan, inspection };
  }
  const failure = await runPlan({ host, plan });
  if (failure !== null) {
    return { status: "failed", code: inspection.code, plan, ...failure };
  }
  const after = await inspectLinuxDns({ host, domains });
  return after.state === "configured"
    ? { status: "configured", inspection: after }
    : { status: "applied_unverified", inspection: after };
}

export type LinuxDnsRemoveOutcome =
  | { readonly status: "absent"; readonly leftInPlace: readonly string[] }
  | {
      readonly status: "declined";
      readonly plan: LinuxDnsPlan;
      readonly leftInPlace: readonly string[];
    }
  | { readonly status: "removed"; readonly leftInPlace: readonly string[] }
  | {
      readonly status: "failed";
      readonly failedStep: string;
      readonly exitCode: number;
      readonly leftInPlace: readonly string[];
    };

/**
 * Hack's files at Hack's fixed root-owned paths, recognised by the marker on
 * their first line (any format version), and notes for files without it.
 */
function classifyRouteFiles(opts: {
  readonly unit: string | null;
  readonly rule: string | null;
}): { readonly owned: readonly string[]; readonly foreign: readonly string[] } {
  const owned: string[] = [];
  const foreign: string[] = [];
  for (const [path, text] of [
    [LINUX_DNS_UNIT_PATH, opts.unit],
    [LINUX_DNS_UDEV_RULE_PATH, opts.rule],
  ] as const) {
    if (text === null) {
      continue;
    }
    const marker = readLinuxDnsMarker(text);
    if (marker.kind === "known") {
      owned.push(path);
    } else if (marker.kind === "unknown-format") {
      foreign.push(
        `${path} carries Hack's marker with format=${marker.format}, which this Hack does not know (a newer Hack wrote it), so it was left in place. Remove it with that Hack, or by hand: sudo rm -- ${path}`
      );
    } else {
      foreign.push(
        `${path} does not carry Hack's marker, so it was left in place. If it is yours to remove: sudo rm -- ${path}`
      );
    }
  }
  return { owned, foreign };
}

/**
 * The link is Hack's to revert when its DNS servers are exactly Hack's
 * CoreDNS. `resolvectl revert` clears every per-link setting, so any setting
 * that is not Hack's is listed for the plan; a link with other servers next
 * to CoreDNS is left alone and reported.
 */
function classifyLinkRoute(opts: {
  readonly instance: string;
  readonly route: LinuxLinkRoute | null;
  readonly domains: readonly string[];
}): {
  readonly ours: boolean;
  readonly alsoCleared: readonly string[];
  readonly note: string | null;
} {
  const { instance, route } = opts;
  if (route === null || !route.dns.includes(DEFAULT_COREDNS_IP)) {
    return { ours: false, alsoCleared: [], note: null };
  }
  if (route.dns.some((server) => server !== DEFAULT_COREDNS_IP)) {
    return {
      ours: false,
      alsoCleared: [],
      note: `${instance} uses Hack's CoreDNS (${DEFAULT_COREDNS_IP}) next to other DNS servers (${route.dns.join(" ")}), so its settings were left in place. To clear all of that link's DNS settings: sudo resolvectl revert -- ${instance}`,
    };
  }
  const hackDomains = new Set(opts.domains.map((domain) => `~${domain}`));
  const otherDomains = route.domains.filter(
    (domain) => !hackDomains.has(domain)
  );
  const alsoCleared = [
    ...(otherDomains.length > 0
      ? [`domains not in Hack's current set: ${otherDomains.join(" ")}`]
      : []),
    ...(route.defaultRoute === true ? ["default-route yes"] : []),
    ...(route.dnssec !== null && route.dnssec !== "no"
      ? [`dnssec ${route.dnssec}`]
      : []),
    ...(route.dnsOverTls !== null && route.dnsOverTls !== "no"
      ? [`dnsovertls ${route.dnsOverTls}`]
      : []),
  ];
  return { ours: true, alsoCleared, note: null };
}

/**
 * Undo {@link applyLinuxDns}: delete the files at Hack's fixed paths that
 * carry Hack's marker, and revert the link when its servers are Hack's.
 * Anything else is left in place and described in `leftInPlace` with how to
 * remove it by hand; settings a revert also clears are listed in the plan.
 */
export async function removeLinuxDns(opts: {
  readonly host: LinuxDnsHost;
  readonly domains: readonly string[];
  readonly confirm: (plan: LinuxDnsPlan) => Promise<boolean>;
}): Promise<LinuxDnsRemoveOutcome> {
  const { host } = opts;
  const [unit, rule, link] = await Promise.all([
    host.readFile(LINUX_DNS_UNIT_PATH),
    host.readFile(LINUX_DNS_UDEV_RULE_PATH),
    host.findLinkWithAddress(DEFAULT_INGRESS_GATEWAY),
  ]);
  const { owned, foreign } = classifyRouteFiles({ unit, rule });
  const leftInPlace = [...foreign];
  const instance = link === null ? null : unitInstanceForInterface(link);
  const linkRoute =
    instance === null
      ? { ours: false, alsoCleared: [], note: null }
      : classifyLinkRoute({
          instance,
          route: await host.readLinkRoute(instance),
          domains: opts.domains,
        });
  if (linkRoute.note !== null) {
    leftInPlace.push(linkRoute.note);
  }
  const routeIsHacks = linkRoute.ours;
  if (link !== null && instance === null) {
    leftInPlace.push(
      `Hack's bridge ${JSON.stringify(link)} has a name Hack does not configure automatically, so any route set on it by hand was left in place. To clear it: sudo resolvectl revert -- '${link.replaceAll("'", "'\\''")}'`
    );
  }
  // Order matters: remove the files that re-apply the route and reload, then
  // stop any Hack instance that is still running its wait loop, and only then
  // revert the link, so nothing re-applies the route after the revert.
  const commands: string[][] = [];
  if (owned.length > 0) {
    commands.push(
      ["rm", "-f", "--", ...owned],
      ["systemctl", "daemon-reload"],
      ["udevadm", "control", "--reload"]
    );
  }
  // Instances are stopped only when the template is Hack's and this removal
  // deletes it: then every `hack-dns@` instance is Hack's. A template left in
  // place (foreign, or from a newer Hack) keeps its instances untouched, even
  // when Hack's udev rule is removed or the link is reverted.
  if (owned.includes(LINUX_DNS_UNIT_PATH)) {
    commands.push(["systemctl", "stop", "--", "hack-dns@*.service"]);
  }
  if (instance !== null && routeIsHacks) {
    commands.push(["resolvectl", "revert", "--", instance]);
  }
  if (commands.length === 0) {
    return { status: "absent", leftInPlace };
  }
  const plan: LinuxDnsPlan = {
    files: [],
    commands,
    ...(routeIsHacks && linkRoute.alsoCleared.length > 0
      ? {
          notes: [
            `Reverting ${instance} also clears settings that are not Hack's: ${linkRoute.alsoCleared.join("; ")}`,
          ],
        }
      : {}),
  };
  if (!(await opts.confirm(plan))) {
    return { status: "declined", plan, leftInPlace };
  }
  const failure = await runPlan({ host, plan });
  return failure === null
    ? { status: "removed", leftInPlace }
    : { status: "failed", ...failure, leftInPlace };
}
