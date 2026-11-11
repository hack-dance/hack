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
const SEARCH_LINE = /^\s*(?:search|domain)\s+(.+)$/;
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
  | "linux_dns_systemd_too_old"
  | "linux_dns_interface_unsupported";

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
  /** resolv.conf `search` domains, shown so a resolver change can keep them. */
  readonly search: readonly string[];
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

/**
 * Whether glibc lookups for names outside /etc/hosts reach `nss-resolve`.
 *
 * Comments are stripped first. Conservatively, `resolve` counts only when it
 * comes before `dns` and no earlier module carries a `[...=return]` action
 * (for example `files [NOTFOUND=return] resolve` never reaches resolve).
 */
export function nsswitchUsesResolve(text: string | null): boolean {
  if (text === null) {
    return false;
  }
  for (const raw of text.split("\n")) {
    const line = raw.split("#")[0] ?? "";
    const match = NSSWITCH_HOSTS_LINE.exec(line);
    if (!match?.[1]) {
      continue;
    }
    for (const entry of match[1].trim().split(WHITESPACE)) {
      if (entry === "resolve") {
        return true;
      }
      if (
        entry === "dns" ||
        (entry.startsWith("[") && entry.toLowerCase().includes("=return"))
      ) {
        return false;
      }
    }
    return false;
  }
  return false;
}

/** `search`/`domain` entries from resolv.conf, in order (the last line wins in glibc). */
export function parseResolvConfSearch(text: string | null): readonly string[] {
  let search: string[] = [];
  for (const line of (text ?? "").split("\n")) {
    const match = SEARCH_LINE.exec(line.split("#")[0] ?? "");
    if (match?.[1]) {
      search = match[1].trim().split(WHITESPACE);
    }
  }
  return search;
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
  const search = parseResolvConfSearch(facts.resolvConf);
  const pointsAtStub = nameservers.some((server) =>
    RESOLVED_STUB_ADDRESSES.has(server)
  );
  if (facts.resolvedActive && pointsAtStub) {
    return {
      kind: "systemd-resolved-stub",
      nameservers,
      search,
      lookupsBypassResolved: false,
    };
  }
  if (parseNetworkManagerDnsMode(facts.networkManagerConf) === "dnsmasq") {
    return {
      kind: "networkmanager-dnsmasq",
      nameservers,
      search,
      lookupsBypassResolved: false,
    };
  }
  if (facts.resolvedActive) {
    return {
      kind: "systemd-resolved",
      nameservers,
      search,
      lookupsBypassResolved: !nsswitchUsesResolve(facts.nsswitchConf),
    };
  }
  return {
    kind: nameservers.length > 0 ? "resolv-conf" : "none",
    nameservers,
    search,
    lookupsBypassResolved: false,
  };
}

export function isResolvedKind(kind: LinuxResolverKind): boolean {
  return kind === "systemd-resolved-stub" || kind === "systemd-resolved";
}

/** Routing-only domains as shell words, double-quoted against tilde expansion. */
export function quotedRoutingDomains(domains: readonly string[]): string {
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
    // Hack only routes names in the conservative set (see
    // isConfigurableInterfaceName); never pass an option-like name on.
    'case "$$1" in ""|-*) exit 0;; esac',
    "n=0",
    "found=0",
    `while [ "$$n" -lt 40 ]; do if ip -o -4 addr show dev "$$1" 2>/dev/null | grep -qF " inet ${gatewayIp}/"; then found=1; break; fi`,
    "n=$$((n+1))",
    "sleep 0.25",
    "done",
    '[ "$$found" = 1 ] || exit 0',
    `resolvectl dns -- "$$1" ${dnsIp}`,
    // Quoted: an unquoted `~hack` is tilde-expanded to user hack's home.
    `resolvectl domain -- "$$1" ${quotedRoutingDomains(opts.domains)}`,
    'resolvectl default-route -- "$$1" no',
    'resolvectl dnssec -- "$$1" no',
    // CoreDNS serves plain DNS; a global DNSOverTLS=yes must not apply here.
    'resolvectl dnsovertls -- "$$1" no',
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

/**
 * Interface names Hack configures automatically: letters, digits, `_`, `.`
 * and `-`, not starting with `-` or `.`, at most 15 bytes (IFNAMSIZ - 1).
 * Every character is valid in a systemd unit name as is, so `%i`/`%k` carry
 * the name unchanged (see {@link unitInstanceForInterface}); a leading `-`
 * could read as an option. Docker's own bridge names (`docker0`,
 * `br-<12 hex>`) are inside this set; anything else gets manual steps.
 */
const CONFIGURABLE_INTERFACE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,14}$/;

export function isConfigurableInterfaceName(name: string): boolean {
  return CONFIGURABLE_INTERFACE.test(name);
}

/**
 * The `hack-dns@<instance>.service` instance for an interface, or `null` when
 * the name is outside the configurable set. Every character of that set is
 * valid in a unit name, so the instance is the name itself: the udev rule
 * passes it raw through `%k` and the unit reads it raw through `%i`. (`%I`
 * would unescape `-` to `/`, so the unit must not use it.)
 */
export function unitInstanceForInterface(name: string): string | null {
  return isConfigurableInterfaceName(name) ? name : null;
}

/** Find the interface carrying `address` in `ip -j -4 addr show` output. */
export function parseLinkForAddress(opts: {
  readonly ipJson: string;
  readonly address: string;
}): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(opts.ipJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) {
    return null;
  }
  for (const link of parsed) {
    if (!isObject(link) || typeof link.ifname !== "string") {
      continue;
    }
    const addresses = Array.isArray(link.addr_info) ? link.addr_info : [];
    if (
      addresses.some(
        (entry: unknown) =>
          isObject(entry) &&
          entry.family === "inet" &&
          entry.local === opts.address
      )
    ) {
      return link.ifname;
    }
  }
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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

function sameSet(actual: readonly string[], expected: readonly string[]) {
  const want = new Set(expected);
  const have = new Set(actual);
  return have.size === want.size && [...have].every((value) => want.has(value));
}

/**
 * The link carries exactly Hack's route: CoreDNS as its only server, exactly
 * Hack's routing-only suffixes (an extra `~.` would send every lookup to
 * CoreDNS) and no default route.
 */
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
  return (
    sameSet(route.dns, [dnsIp]) &&
    sameSet(
      route.domains,
      opts.domains.map((domain) => `~${domain}`)
    ) &&
    route.defaultRoute === false
  );
}

const UNIT_DOMAINS = /resolvectl domain -- "\$\$1" ((?:"~[a-z0-9.-]+" ?)+);/;

/**
 * The domains of a unit file Hack wrote, or `null` when the text is not
 * byte-for-byte what Hack renders for some domain set (edited or foreign).
 */
export function parseHackUnitDomains(text: string): readonly string[] | null {
  const match = UNIT_DOMAINS.exec(text);
  if (!match?.[1]) {
    return null;
  }
  const domains = match[1]
    .trim()
    .split(" ")
    .map((word) => word.slice(2, -1));
  return text === renderLinuxDnsUnit({ domains }) ? domains : null;
}

export function isHackUdevRule(text: string): boolean {
  return text === renderLinuxDnsUdevRule();
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

const STUB_RESOLV_CONF = "/run/systemd/resolve/stub-resolv.conf";
const RESOLV_BACKUP = "/etc/resolv.conf.before-hack";

/**
 * Steps for a host where resolved runs but glibc bypasses it. They change
 * /etc/resolv.conf only after the user confirms resolved already has this
 * host's upstream servers and search domains, keep a backup, and end with a
 * verification plus the restore command.
 */
function stubSwitchSteps(opts: {
  readonly nameservers: readonly string[];
  readonly search: readonly string[];
  readonly domains: readonly string[];
}): readonly string[] {
  const upstream =
    opts.nameservers.length > 0 ? opts.nameservers.join(" ") : "(none listed)";
  const search = opts.search.length > 0 ? opts.search.join(" ") : "(none)";
  return [
    `1. Check that systemd-resolved already uses this host's upstream DNS (/etc/resolv.conf lists nameservers ${upstream}, search ${search}):`,
    "  resolvectl dns",
    "  resolvectl domain",
    "   If they are missing there, stop: add them to resolved first (resolved.conf DNS= and Domains=, or your network manager), or leave /etc/resolv.conf as it is.",
    "2. Keep a copy, then point /etc/resolv.conf at the resolved stub:",
    `  sudo cp -P /etc/resolv.conf ${RESOLV_BACKUP}`,
    `  sudo ln -sf ${STUB_RESOLV_CONF} /etc/resolv.conf`,
    "3. Verify ordinary and Hack lookups:",
    `  getent hosts example.com && resolvectl query hack-check.${opts.domains[0] ?? "hack"}`,
    `   If ordinary lookups fail, restore the copy: sudo mv ${RESOLV_BACKUP} /etc/resolv.conf`,
  ];
}

function forwardingSteps(opts: {
  readonly intro: string;
  readonly conf: string;
}): readonly string[] {
  return [
    opts.intro,
    "Hack does not change this host's resolver. To use Hack's names, have the resolver you run forward these suffixes to Hack's CoreDNS, for example as dnsmasq lines:",
    ...opts.conf.split("\n").map((line) => `  ${line}`),
    "Or switch the host to systemd-resolved (keeping its upstream DNS), then rerun hack global install. See docs/guides/linux-setup.md.",
  ];
}

/**
 * Exact manual steps for resolvers Hack does not configure itself.
 * Commands are printed for the user; Hack never runs them.
 */
export function renderLinuxManualDnsSteps(opts: {
  readonly kind: LinuxResolverKind;
  readonly domains: readonly string[];
  readonly dnsIp?: string;
  /** resolv.conf contents, carried into the resolved-bypassed steps. */
  readonly nameservers?: readonly string[];
  readonly search?: readonly string[];
}): readonly string[] {
  const dnsIp = opts.dnsIp ?? DEFAULT_COREDNS_IP;
  const conf = renderNetworkManagerDnsmasqConf({
    domains: opts.domains,
    dnsIp,
  }).trimEnd();
  switch (opts.kind) {
    case "networkmanager-dnsmasq":
      return [
        `NetworkManager runs dnsmasq for this host. Add ${NM_DNSMASQ_HACK_PATH} with:`,
        ...conf.split("\n").map((line) => `  ${line}`),
        "Then reload NetworkManager:",
        "  sudo systemctl reload NetworkManager",
      ];
    case "resolv-conf":
      return forwardingSteps({
        intro:
          "This host sends every lookup straight to the nameservers in /etc/resolv.conf, which cannot route by suffix.",
        conf,
      });
    case "none":
      return forwardingSteps({
        intro:
          "No resolver configuration was found (/etc/resolv.conf has no nameserver).",
        conf,
      });
    case "systemd-resolved":
      return [
        "systemd-resolved is running, but /etc/resolv.conf does not point at its stub and /etc/nsswitch.conf does not reach its `resolve` module, so lookups bypass it.",
        ...stubSwitchSteps({
          nameservers: opts.nameservers ?? [],
          search: opts.search ?? [],
          domains: opts.domains,
        }),
      ];
    case "systemd-resolved-stub":
      return [];
    default:
      return [];
  }
}

/**
 * Manual route for a bridge whose name Hack does not configure
 * automatically. Not persistent: it lasts until the bridge is recreated.
 */
export function renderManualLinkRouteSteps(opts: {
  readonly link: string;
  readonly domains: readonly string[];
  readonly dnsIp?: string;
}): readonly string[] {
  const dnsIp = opts.dnsIp ?? DEFAULT_COREDNS_IP;
  const link = `'${opts.link.replaceAll("'", "'\\''")}'`;
  return [
    `Hack configures only interface names made of letters, digits, _, . and - (not starting with - or .); set the route by hand (it lasts until ${opts.link} is recreated):`,
    `  sudo resolvectl dns -- ${link} ${dnsIp}`,
    `  sudo resolvectl domain -- ${link} ${quotedRoutingDomains(opts.domains)}`,
    `  sudo resolvectl default-route -- ${link} no`,
    `  sudo resolvectl dnssec -- ${link} no`,
    `  sudo resolvectl dnsovertls -- ${link} no`,
  ];
}
