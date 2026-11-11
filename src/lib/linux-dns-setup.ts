/**
 * Inspect, apply and remove Hack's Linux host DNS route.
 *
 * All host effects go through {@link LinuxDnsHost}. Root-only steps are a
 * plain list of argv arrays: the caller shows them, and they run (each with
 * `sudo`) only after an interactive confirmation. A run that cannot prompt
 * gets the same list back with a stable code and changes nothing.
 */
import { createHash } from "node:crypto";
import { DEFAULT_COREDNS_IP, DEFAULT_INGRESS_GATEWAY } from "../constants.ts";
import {
  detectLinuxResolver,
  dnsmasqRoutesDomains,
  isHackUdevRule,
  isResolvedKind,
  LINUX_DNS_MIN_SYSTEMD,
  LINUX_DNS_UDEV_RULE_PATH,
  LINUX_DNS_UNIT_PATH,
  type LinuxDnsCode,
  type LinuxLinkRoute,
  type LinuxResolverDetection,
  linkRouteMatches,
  NM_DNSMASQ_DIR,
  parseHackUnitDomains,
  renderLinuxDnsUdevRule,
  renderLinuxDnsUnit,
  renderLinuxManualDnsSteps,
  renderManualLinkRouteSteps,
  renderNetworkManagerDnsmasqConf,
  unitInstanceForInterface,
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
  /**
   * Write private copies for privileged installs. Called only after the user
   * confirmed. Each call uses a new, uniquely named 0700 directory and creates
   * every file exclusively (an existing path or link is never followed).
   * Returns the paths in order and a cleanup that removes the directory.
   */
  readonly stageFiles: (
    files: readonly { readonly name: string; readonly content: string }[]
  ) => Promise<{
    readonly paths: readonly string[];
    readonly cleanup: () => Promise<void>;
  }>;
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
        nameservers: resolver.nameservers,
        search: resolver.search,
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
      message: `${link} does not carry exactly Hack's DNS route`,
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
        nameservers: resolver.nameservers,
        search: resolver.search,
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
 * A privileged plan. Each file is installed as root from a private copy that
 * is checked against the digest of the content shown; then every command runs
 * as `sudo <argv>`.
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
 * The plan as commands a person can paste: each file through a quoted
 * heredoc (no expansion), then the commands. Used when Hack does not run it.
 */
export function renderManualPlan(plan: LinuxDnsPlan): readonly string[] {
  return [
    ...plan.files.flatMap((file) => [
      `sudo install -d -m 0755 ${shellQuoteIfNeeded(dirnameOf(file.path))}`,
      `sudo tee ${shellQuoteIfNeeded(file.path)} >/dev/null <<'${HEREDOC_END}'`,
      ...file.content.trimEnd().split("\n"),
      HEREDOC_END,
    ]),
    ...plan.commands.map(renderPrivilegedCommand),
  ];
}

function dirnameOf(path: string): string {
  return path.slice(0, path.lastIndexOf("/")) || "/";
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

/** Largest file the root install step copies (Hack's files are ~2 KiB). */
export const VERIFIED_INSTALL_MAX_BYTES = 65_536;
/** Seconds the root copy may take before it is killed. */
export const VERIFIED_INSTALL_TIMEOUT_SECONDS = 10;

/**
 * Root copies the private staged file into a root-owned 0700 directory it
 * creates under /tmp (named explicitly, never `TMPDIR`), checks the copy
 * against the digest of the bytes the user approved, and installs only that
 * copy, so a file replaced after the plan was shown is never installed.
 *
 * The copy itself is bounded, because a same-user process can still swap the
 * staged path: the source must be an absolute path to a regular file that is
 * not a link, `head -c` reads at most one byte past the limit (a swapped-in
 * `/dev/zero` cannot fill /tmp), and `timeout` kills a copy that blocks (a
 * swapped-in FIFO). An oversized copy fails before the digest check.
 */
export function renderVerifiedInstallScript(opts?: {
  readonly maxBytes?: number;
  readonly timeoutSeconds?: number;
}): string {
  const maxBytes = opts?.maxBytes ?? VERIFIED_INSTALL_MAX_BYTES;
  const seconds = opts?.timeoutSeconds ?? VERIFIED_INSTALL_TIMEOUT_SECONDS;
  return [
    "set -eu",
    "umask 077",
    'case "$1" in /*) ;; *) exit 64;; esac',
    '[ -f "$1" ] && [ ! -L "$1" ] || exit 65',
    "d=$(mktemp -d /tmp/hack-root.XXXXXXXX)",
    `trap 'rm -rf "$d"' EXIT`,
    't="$d/copy"',
    `timeout -k 1 ${seconds} head -c ${maxBytes + 1} -- "$1" > "$t"`,
    `[ "$(wc -c < "$t")" -le ${maxBytes} ] || exit 66`,
    'printf "%s  %s\\n" "$2" "$t" | sha256sum -c --status',
    'install -D -o root -g root -m 0644 "$t" "$3"',
  ].join("; ");
}

export const VERIFIED_INSTALL_SCRIPT = renderVerifiedInstallScript();

export function verifiedInstallArgv(opts: {
  readonly source: string;
  readonly sha256: string;
  readonly target: string;
}): string[] {
  return [
    "sh",
    "-c",
    VERIFIED_INSTALL_SCRIPT,
    "hack-install",
    opts.source,
    opts.sha256,
    opts.target,
  ];
}

export function sha256Hex(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function stageName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Run a confirmed plan. Files are staged only now, after the user said yes. */
async function runPlan(opts: {
  readonly host: LinuxDnsHost;
  readonly plan: LinuxDnsPlan;
}): Promise<{ readonly failedStep: string; readonly exitCode: number } | null> {
  const { host, plan } = opts;
  if (plan.files.length > 0) {
    const staged = await host.stageFiles(
      plan.files.map((file) => ({
        name: stageName(file.path),
        content: file.content,
      }))
    );
    try {
      for (const [index, file] of plan.files.entries()) {
        const exitCode = await host.runPrivileged(
          verifiedInstallArgv({
            source: staged.paths[index] ?? "",
            sha256: sha256Hex(file.content),
            target: file.path,
          })
        );
        if (exitCode !== 0) {
          return { failedStep: `install ${file.path}`, exitCode };
        }
      }
    } finally {
      await staged.cleanup();
    }
  }
  for (const command of plan.commands) {
    const exitCode = await host.runPrivileged(command);
    if (exitCode !== 0) {
      return { failedStep: renderPrivilegedCommand(command), exitCode };
    }
  }
  return null;
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
  const plan: LinuxDnsPlan = inspection.resolver.lookupsBypassResolved
    ? {
        ...built,
        notes: [
          "Lookups on this host bypass systemd-resolved, so the route has no effect until they reach it:",
          ...renderLinuxManualDnsSteps({
            kind: inspection.resolver.kind,
            domains,
            nameservers: inspection.resolver.nameservers,
            search: inspection.resolver.search,
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
 * Undo {@link applyLinuxDns}, touching only what is exactly Hack's: a file is
 * deleted only when it is byte-for-byte what Hack renders (for the current
 * domains or the domains in the installed unit), and the link is reverted
 * only when its DNS settings are exactly Hack's route. Anything else is left
 * in place and described in `leftInPlace` with how to remove it by hand.
 */
/** Hack's own route files present on disk, and notes for foreign ones. */
function classifyRouteFiles(opts: {
  readonly unit: string | null;
  readonly rule: string | null;
  readonly unitDomains: readonly string[] | null;
}): { readonly owned: readonly string[]; readonly foreign: readonly string[] } {
  const owned: string[] = [];
  const foreign: string[] = [];
  for (const [path, text, ours] of [
    [LINUX_DNS_UNIT_PATH, opts.unit, opts.unitDomains !== null],
    [
      LINUX_DNS_UDEV_RULE_PATH,
      opts.rule,
      opts.rule !== null && isHackUdevRule(opts.rule),
    ],
  ] as const) {
    if (text === null) {
      continue;
    }
    if (ours) {
      owned.push(path);
    } else {
      foreign.push(
        `${path} is not the file Hack writes, so it was left in place. If it is yours to remove: sudo rm -- ${path}`
      );
    }
  }
  return { owned, foreign };
}

/** Whether the link's DNS settings are exactly Hack's route, and a note when mixed. */
function classifyLinkRoute(opts: {
  readonly instance: string;
  readonly route: LinuxLinkRoute | null;
  readonly domainSets: readonly (readonly string[])[];
}): { readonly ours: boolean; readonly note: string | null } {
  const { instance, route } = opts;
  if (route === null) {
    return { ours: false, note: null };
  }
  if (opts.domainSets.some((domains) => linkRouteMatches({ route, domains }))) {
    return { ours: true, note: null };
  }
  if (!route.dns.includes(DEFAULT_COREDNS_IP)) {
    return { ours: false, note: null };
  }
  return {
    ours: false,
    note: `${instance} uses Hack's CoreDNS (${DEFAULT_COREDNS_IP}) but its DNS settings are not exactly Hack's route (dns: ${route.dns.join(" ") || "none"}; domains: ${route.domains.join(" ") || "none"}), so they were left in place. To clear all of that link's DNS settings: sudo resolvectl revert -- ${instance}`,
  };
}

/**
 * Undo {@link applyLinuxDns}, touching only what is exactly Hack's: a file is
 * deleted only when it is byte-for-byte what Hack renders (for the current
 * domains or the domains in the installed unit), and the link is reverted
 * only when its DNS settings are exactly Hack's route. Anything else is left
 * in place and described in `leftInPlace` with how to remove it by hand.
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
  const unitDomains = unit === null ? null : parseHackUnitDomains(unit);
  const { owned, foreign } = classifyRouteFiles({ unit, rule, unitDomains });
  const leftInPlace = [...foreign];
  const instance = link === null ? null : unitInstanceForInterface(link);
  const linkRoute =
    instance === null
      ? { ours: false, note: null }
      : classifyLinkRoute({
          instance,
          route: await host.readLinkRoute(instance),
          domainSets: [opts.domains, unitDomains ?? opts.domains],
        });
  if (linkRoute.note !== null) {
    leftInPlace.push(linkRoute.note);
  }
  const routeIsHacks = linkRoute.ours;
  const commands: string[][] = [];
  if (instance !== null && routeIsHacks) {
    commands.push(["resolvectl", "revert", "--", instance]);
  }
  if (owned.length > 0) {
    commands.push(
      ["rm", "-f", "--", ...owned],
      ["systemctl", "daemon-reload"],
      ["udevadm", "control", "--reload"]
    );
  }
  if (commands.length === 0) {
    return { status: "absent", leftInPlace };
  }
  const plan: LinuxDnsPlan = { files: [], commands };
  if (!(await opts.confirm(plan))) {
    return { status: "declined", plan, leftInPlace };
  }
  const failure = await runPlan({ host, plan });
  return failure === null
    ? { status: "removed", leftInPlace }
    : { status: "failed", ...failure, leftInPlace };
}
