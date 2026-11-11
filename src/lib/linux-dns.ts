/**
 * Linux host DNS for Hack's routed suffixes (`*.hack`, `*.hack.local`, the
 * OAuth alias root and a custom `default_domain`).
 *
 * Mechanism (systemd-resolved hosts): a per-link route on the Docker bridge
 * that carries the hack-dev gateway address. Two root-owned files make it
 * survive network recreation and reboot without naming the bridge:
 *
 * - a udev rule starts `hack-dns@<ifname>.service` whenever any bridge
 *   interface appears (Docker creates `br-<id>` names that change when the
 *   network is recreated);
 * - the template unit's `ExecCondition` waits briefly for the gateway address
 *   on that interface and skips every other bridge, then sets the link's DNS
 *   server to Hack's CoreDNS, its routing-only domains to Hack's suffixes,
 *   and turns off default-route and DNSSEC for the link.
 *
 * Only queries for Hack's suffixes reach CoreDNS; every other lookup keeps the
 * host's normal route. This module holds the pure decisions and renderers;
 * effects live in `linux-dns-host.ts` and the flow in `linux-dns-setup.ts`.
 */
import { DEFAULT_COREDNS_IP, DEFAULT_INGRESS_GATEWAY } from "../constants.ts";

/** Template unit started once per bridge interface by the udev rule. */
export const LINUX_DNS_UNIT_PATH = "/etc/systemd/system/hack-dns@.service";
/** udev rule that starts the template unit for every new bridge. */
export const LINUX_DNS_UDEV_RULE_PATH = "/etc/udev/rules.d/90-hack-dns.rules";
/** NetworkManager's dnsmasq plugin reads extra config from this directory. */
export const NM_DNSMASQ_DIR = "/etc/NetworkManager/dnsmasq.d";
export const NM_DNSMASQ_HACK_PATH = `${NM_DNSMASQ_DIR}/hack.conf`;

/** The resolved stub listens on these loopback addresses. */
const RESOLVED_STUB_ADDRESSES: ReadonlySet<string> = new Set([
  "127.0.0.53",
  "127.0.0.54",
]);
const NAMESERVER_LINE = /^\s*nameserver\s+(\S+)/;
const NM_DNS_LINE = /^\s*dns\s*=\s*(\S+)\s*$/;
const NSSWITCH_HOSTS_LINE = /^\s*hosts\s*:(.*)$/;
const WHITESPACE = /\s+/;

/** Closed codes reported by install, doctor and status. Stable for scripts. */
export type LinuxDnsCode =
  | "linux_dns_route_missing"
  | "linux_dns_route_stale"
  | "linux_dns_route_not_applied"
  | "linux_dns_bridge_missing"
  | "linux_dns_resolver_manual"
  | "linux_dns_resolved_bypassed"
  | "linux_dns_systemd_too_old";

export type LinuxResolverKind =
  | "systemd-resolved-stub"
  | "systemd-resolved"
  | "networkmanager-dnsmasq"
  | "resolv-conf"
  | "none";

/** Read-only facts gathered from the host; `null` means the file is absent. */
export type LinuxResolverFacts = {
  readonly resolvedActive: boolean;
  readonly resolvConf: string | null;
  readonly nsswitchConf: string | null;
  /** Concatenated NetworkManager.conf and conf.d/*.conf text, in load order. */
  readonly networkManagerConf: string | null;
};

export type LinuxResolverDetection = {
  readonly kind: LinuxResolverKind;
  readonly nameservers: readonly string[];
  /**
   * systemd-resolved runs but glibc lookups do not reach it: resolv.conf does
   * not point at the stub and nsswitch has no `resolve` module.
   */
  readonly lookupsBypassResolved: boolean;
};

export function parseResolvConfNameservers(
  text: string | null
): readonly string[] {
  if (text === null) {
    return [];
  }
  const servers: string[] = [];
  for (const line of text.split("\n")) {
    const match = NAMESERVER_LINE.exec(line);
    if (match?.[1]) {
      servers.push(match[1]);
    }
  }
  return servers;
}

/** The effective `[main] dns=` value; later files override earlier ones. */
export function parseNetworkManagerDnsMode(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  let section = "";
  let mode: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[") && line.endsWith("]")) {
      section = line.slice(1, -1).trim().toLowerCase();
      continue;
    }
    if (section !== "main") {
      continue;
    }
    const match = NM_DNS_LINE.exec(line);
    if (match?.[1]) {
      mode = match[1].toLowerCase();
    }
  }
  return mode;
}

function nsswitchUsesResolve(text: string | null): boolean {
  if (text === null) {
    return false;
  }
  for (const line of text.split("\n")) {
    const match = NSSWITCH_HOSTS_LINE.exec(line);
    if (match?.[1]) {
      return match[1]
        .trim()
        .split(WHITESPACE)
        .some((entry) => entry === "resolve");
    }
  }
  return false;
}

/**
 * Classify how glibc lookups on this host are answered.
 *
 * Order matters: a resolv.conf that points at the resolved stub wins, then
 * NetworkManager's dnsmasq plugin (it owns resolv.conf when enabled), then a
 * running resolved reached only through nsswitch, then plain resolv.conf.
 */
export function detectLinuxResolver(
  facts: LinuxResolverFacts
): LinuxResolverDetection {
  const nameservers = parseResolvConfNameservers(facts.resolvConf);
  const pointsAtStub = nameservers.some((server) =>
    RESOLVED_STUB_ADDRESSES.has(server)
  );
  if (facts.resolvedActive && pointsAtStub) {
    return {
      kind: "systemd-resolved-stub",
      nameservers,
      lookupsBypassResolved: false,
    };
  }
  if (parseNetworkManagerDnsMode(facts.networkManagerConf) === "dnsmasq") {
    return {
      kind: "networkmanager-dnsmasq",
      nameservers,
      lookupsBypassResolved: false,
    };
  }
  if (facts.resolvedActive) {
    return {
      kind: "systemd-resolved",
      nameservers,
      lookupsBypassResolved: !nsswitchUsesResolve(facts.nsswitchConf),
    };
  }
  return {
    kind: nameservers.length > 0 ? "resolv-conf" : "none",
    nameservers,
    lookupsBypassResolved: false,
  };
}

export function isResolvedKind(kind: LinuxResolverKind): boolean {
  return kind === "systemd-resolved-stub" || kind === "systemd-resolved";
}

/** Routing-only domains as shell words, double-quoted against tilde expansion. */
function quotedRoutingDomains(domains: readonly string[]): string {
  return domains.map((domain) => `"~${domain}"`).join(" ");
}

/** Oldest systemd with every `resolvectl` verb the unit uses (`default-route`). */
export const LINUX_DNS_MIN_SYSTEMD = 240;

/**
 * Render the template unit. `%i` is the bridge interface name passed by the
 * udev rule; `$$` is a literal `$` for the shell after systemd's expansion.
 *
 * One `ExecStart` shell step waits up to about ten seconds for the gateway
 * address on the interface and exits 0 without touching any other bridge.
 * The check lives in the same step as the `resolvectl` calls, not in
 * `ExecCondition=` (which systemd before 243 ignores), so no systemd version
 * applies the route to the wrong bridge. Domains are validated suffixes
 * (`[a-z0-9.-]`); each `~domain` is double-quoted only to stop tilde expansion.
 */
export function renderLinuxDnsUnit(opts: {
  readonly domains: readonly string[];
  readonly gatewayIp?: string;
  readonly dnsIp?: string;
}): string {
  const gatewayIp = opts.gatewayIp ?? DEFAULT_INGRESS_GATEWAY;
  const dnsIp = opts.dnsIp ?? DEFAULT_COREDNS_IP;
  const script = [
    "n=0",
    "found=0",
    `while [ "$$n" -lt 40 ]; do if ip -o -4 addr show dev "$$1" 2>/dev/null | grep -qF " inet ${gatewayIp}/"; then found=1; break; fi`,
    "n=$$((n+1))",
    "sleep 0.25",
    "done",
    '[ "$$found" = 1 ] || exit 0',
    `resolvectl dns "$$1" ${dnsIp}`,
    // Quoted: an unquoted `~hack` is tilde-expanded to user hack's home.
    `resolvectl domain "$$1" ${quotedRoutingDomains(opts.domains)}`,
    'resolvectl default-route "$$1" no',
    'resolvectl dnssec "$$1" no',
  ].join("; ");
  return [
    "# Managed by hack (hack global install). Remove with: hack global down",
    "# Routes Hack's DNS suffixes to Hack's CoreDNS on the Docker bridge that",
    `# carries ${gatewayIp}. Started for each new bridge by ${LINUX_DNS_UDEV_RULE_PATH}.`,
    "[Unit]",
    "Description=Hack split DNS on %i",
    "After=systemd-resolved.service",
    "",
    "[Service]",
    "Type=oneshot",
    `ExecStart=/bin/sh -ec '${script}' hack-dns %i`,
    "",
  ].join("\n");
}

export function renderLinuxDnsUdevRule(): string {
  return [
    "# Managed by hack (hack global install). Remove with: hack global down",
    "# Starts hack-dns@<ifname>.service for every new bridge; the unit skips",
    "# bridges that are not Hack's ingress network.",
    'ACTION=="add", SUBSYSTEM=="net", ENV{DEVTYPE}=="bridge", TAG+="systemd", ENV{SYSTEMD_WANTS}+="hack-dns@%k.service"',
    "",
  ].join("\n");
}

/** dnsmasq lines for NetworkManager's dnsmasq plugin (printed, not written). */
export function renderNetworkManagerDnsmasqConf(opts: {
  readonly domains: readonly string[];
  readonly dnsIp?: string;
}): string {
  const dnsIp = opts.dnsIp ?? DEFAULT_COREDNS_IP;
  return `${opts.domains.map((domain) => `server=/${domain}/${dnsIp}`).join("\n")}\n`;
}

/** Find the interface carrying `address` in `ip -o -4 addr show` output. */
export function parseLinkForAddress(opts: {
  readonly ipOutput: string;
  readonly address: string;
}): string | null {
  for (const line of opts.ipOutput.split("\n")) {
    // "5: br-0123abcd    inet 172.30.0.1/16 brd 172.30.255.255 scope global br-0123abcd\ ..."
    const fields = line.trim().split(WHITESPACE);
    const inetIndex = fields.indexOf("inet");
    const cidr = inetIndex >= 0 ? fields[inetIndex + 1] : undefined;
    const name = fields[1];
    if (name && cidr?.split("/")[0] === opts.address) {
      return name.split("@")[0] ?? name;
    }
  }
  return null;
}

/** Values after "Link N (name):" in `resolvectl dns|domain|default-route LINK`. */
export function parseResolvectlLinkValues(output: string): readonly string[] {
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("Link "));
  if (!line) {
    return [];
  }
  const colon = line.indexOf("):");
  if (colon < 0) {
    return [];
  }
  return line
    .slice(colon + 2)
    .trim()
    .split(WHITESPACE)
    .filter((value) => value.length > 0);
}

const SYSTEMD_VERSION_LINE = /^systemd (\d+)/;

/** Major version from `systemctl --version` ("systemd 255 (255.4-1)"). */
export function parseSystemdVersion(output: string): number | null {
  const match = SYSTEMD_VERSION_LINE.exec(output.trim());
  return match?.[1] ? Number(match[1]) : null;
}

/** Per-link resolver state read back from systemd-resolved. */
export type LinuxLinkRoute = {
  readonly dns: readonly string[];
  readonly domains: readonly string[];
  readonly defaultRoute: boolean | null;
};

export function linkRouteMatches(opts: {
  readonly route: LinuxLinkRoute | null;
  readonly domains: readonly string[];
  readonly dnsIp?: string;
}): boolean {
  const route = opts.route;
  if (!route) {
    return false;
  }
  const dnsIp = opts.dnsIp ?? DEFAULT_COREDNS_IP;
  const actual = new Set(route.domains);
  return (
    route.dns.includes(dnsIp) &&
    opts.domains.every((domain) => actual.has(`~${domain}`)) &&
    route.defaultRoute !== true
  );
}

/** Whether a NetworkManager dnsmasq config already routes every domain. */
export function dnsmasqRoutesDomains(opts: {
  readonly text: string;
  readonly domains: readonly string[];
  readonly dnsIp?: string;
}): boolean {
  const dnsIp = opts.dnsIp ?? DEFAULT_COREDNS_IP;
  const lines = new Set(opts.text.split("\n").map((line) => line.trim()));
  return opts.domains.every((domain) =>
    lines.has(`server=/${domain}/${dnsIp}`)
  );
}

/**
 * Exact manual steps for resolvers Hack does not configure itself.
 * Commands are printed for the user; Hack never runs them.
 */
export function renderLinuxManualDnsSteps(opts: {
  readonly kind: LinuxResolverKind;
  readonly domains: readonly string[];
  readonly dnsIp?: string;
}): readonly string[] {
  const dnsIp = opts.dnsIp ?? DEFAULT_COREDNS_IP;
  const conf = renderNetworkManagerDnsmasqConf({
    domains: opts.domains,
    dnsIp,
  }).trimEnd();
  const enableResolved = [
    "Recommended: switch lookups to systemd-resolved, then rerun hack global install:",
    "  sudo systemctl enable --now systemd-resolved",
    "  sudo ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf",
  ];
  switch (opts.kind) {
    case "networkmanager-dnsmasq":
      return [
        `NetworkManager runs dnsmasq for this host. Add ${NM_DNSMASQ_HACK_PATH} with:`,
        ...conf.split("\n").map((line) => `  ${line}`),
        "Then reload NetworkManager:",
        "  sudo systemctl reload NetworkManager",
      ];
    case "resolv-conf":
      return [
        "This host sends every lookup straight to the nameservers in /etc/resolv.conf, which cannot route by suffix.",
        ...enableResolved,
        "Or run a local dnsmasq with these lines and point /etc/resolv.conf at it:",
        ...conf.split("\n").map((line) => `  ${line}`),
      ];
    case "none":
      return [
        "No resolver configuration was found (/etc/resolv.conf has no nameserver).",
        ...enableResolved,
      ];
    case "systemd-resolved":
      return [
        "systemd-resolved is running, but /etc/resolv.conf does not point at its stub and /etc/nsswitch.conf has no `resolve` module, so lookups bypass it.",
        "Point resolv.conf at the stub:",
        "  sudo ln -sf /run/systemd/resolve/stub-resolv.conf /etc/resolv.conf",
      ];
    case "systemd-resolved-stub":
      return [];
    default:
      return [];
  }
}
