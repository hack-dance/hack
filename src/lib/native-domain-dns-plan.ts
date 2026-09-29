import { createHash } from "node:crypto";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import {
  DEFAULT_CADDY_IP,
  DEFAULT_HOST_DNS_IP,
  DEFAULT_NEW_PROJECT_TLD,
  DEFAULT_OAUTH_ALIAS_ROOT,
  DEFAULT_PROJECT_TLD,
} from "../constants.ts";
import { parseDefaultDomain } from "./default-domain.ts";

const MAX_FILES = 256;
const MAX_FILE_BYTES = 1024 * 1024;
const RESOLVER_CONTENT = `nameserver ${DEFAULT_HOST_DNS_IP}\n`;
const BUILT_IN_DOMAINS = [
  DEFAULT_PROJECT_TLD,
  DEFAULT_NEW_PROJECT_TLD,
  DEFAULT_OAUTH_ALIAS_ROOT,
] as const;
const V4_TARGETS: ReadonlySet<string> = new Set([
  DEFAULT_CADDY_IP,
  DEFAULT_HOST_DNS_IP,
  "::1",
]);
const NON_CLAIM_DIRECTIVES: ReadonlySet<string> = new Set([
  "conf-dir",
  "conf-file",
  "log-facility",
  "pid-file",
  "resolv-file",
  "dhcp-hostsfile",
  "addn-hosts",
]);
const DOMAIN_TOKEN = /[a-z0-9-]+(?:\.[a-z0-9-]+)*/gi;
const LINE_BREAK = /\r?\n/;
const NUMERIC_DOMAIN = /^\d+(?:\.\d+)+$/;
const WHITESPACE = /\s+/;
const TRAILING_DOT = /\.$/;

/** A complete, bounded read of a file; null means the file does not exist. */
export interface NativeDnsFileSnapshot {
  readonly path: string;
  readonly content: string | null;
}

/** Persist in a private location before/after activation; only active proves ownership. */
export interface NativeDnsReceipt {
  readonly version: 1;
  readonly state: "pending" | "active" | "removing" | "inactive";
  readonly domain: string;
  readonly dnsmasqPath: string;
  readonly resolverPath: string;
  readonly dnsmasqSha256: string;
  readonly resolverSha256: string;
}

export interface NativeDnsPlan {
  readonly domain: string;
  readonly dnsmasqPath: string;
  readonly resolverPath: string;
  readonly dnsmasqContent: string;
  readonly resolverContent: string;
  /** Active means the supplied disk snapshots and private receipt match, not live DNS proof. */
  readonly status: "available" | "active";
  readonly pendingReceipt: NativeDnsReceipt;
  readonly activeReceipt: NativeDnsReceipt;
  readonly removingReceipt: NativeDnsReceipt;
  readonly inactiveReceipt: NativeDnsReceipt;
  /** Verified parent claim used to prove fallback after scoped deactivation. */
  readonly parentAddress: string | null;
  readonly activation: readonly string[];
}

export interface NativeDnsPlanOptions {
  /** Already validated and normalized by the selecting configuration boundary. */
  readonly domain: string;
  readonly mainConfig: NativeDnsFileSnapshot;
  readonly includeDir: string;
  readonly includeFiles: readonly NativeDnsFileSnapshot[];
  readonly resolverDir: string;
  readonly resolverFiles: readonly NativeDnsFileSnapshot[];
  readonly hosts: NativeDnsFileSnapshot;
  /** Arguments observed from the running dnsmasq process, including its include directory. */
  readonly dnsmasqArgs: readonly string[];
  readonly receipt: NativeDnsReceipt | null;
  /** Explicit permission to nest beneath the existing v4 hack.gy DNS claim. */
  readonly builtInParentClaim?: "hack.gy";
}

function refuse(reason: string): never {
  throw new Error(`Native domain DNS plan refused: ${reason}`);
}

function checkPath(path: string): string {
  if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0")) {
    return refuse("paths must be absolute and normalized");
  }
  return path;
}

function checkSnapshot(snapshot: NativeDnsFileSnapshot): void {
  checkPath(snapshot.path);
  if (
    snapshot.content !== null &&
    Buffer.byteLength(snapshot.content, "utf8") > MAX_FILE_BYTES
  ) {
    refuse("a supplied file snapshot exceeds the size limit");
  }
}

function checkFiles(
  files: readonly NativeDnsFileSnapshot[],
  directory: string
): void {
  if (files.length > MAX_FILES) {
    refuse("too many supplied file snapshots");
  }
  const seen = new Set<string>();
  for (const file of files) {
    checkSnapshot(file);
    if (dirname(file.path) !== directory || file.content === null) {
      refuse("directory snapshots must contain existing direct-child files");
    }
    const key = file.path.toLowerCase();
    if (seen.has(key)) {
      refuse("duplicate directory snapshot path");
    }
    seen.add(key);
  }
}

function overlaps(a: string, b: string): boolean {
  return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

function claimsInConfig(
  content: string
): readonly { domain: string; line: string }[] {
  const claims: { domain: string; line: string }[] = [];
  for (const rawLine of content.split(LINE_BREAK)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const equal = line.indexOf("=");
    if (equal < 0) {
      continue;
    }
    const directive = line.slice(0, equal).trim().toLowerCase();
    if (NON_CLAIM_DIRECTIVES.has(directive)) {
      continue;
    }
    const value = line.slice(equal + 1).split("#", 1)[0] ?? "";
    for (const token of value.match(DOMAIN_TOKEN) ?? []) {
      const domain = token.toLowerCase();
      if (domain.includes(".") && !NUMERIC_DOMAIN.test(domain)) {
        claims.push({ domain, line });
      }
    }
  }
  return claims;
}

function hasRuntimeInclude(
  args: readonly string[],
  includeDir: string
): boolean {
  const expected = `${includeDir},*.conf`;
  return args.some(
    (arg, index) =>
      (arg === "-7" && args[index + 1] === expected) ||
      arg === `-7${expected}` ||
      arg === `--conf-dir=${expected}`
  );
}

function checkRuntimeConfigSource(opts: {
  readonly arg: string;
  readonly next: string | undefined;
  readonly included: string;
  readonly mainPath: string;
}): void {
  const { arg, next, included, mainPath } = opts;
  if (
    arg.startsWith("-H") ||
    arg.startsWith("--addn-hosts") ||
    arg.startsWith("--hostsdir")
  ) {
    refuse("an uninspected dnsmasq hosts source is active");
  }
  const unexpectedDir =
    ((arg === "-7" || arg === "--conf-dir") && next !== included) ||
    (arg.startsWith("-7") && arg !== "-7" && arg !== `-7${included}`) ||
    (arg.startsWith("--conf-dir=") && arg !== `--conf-dir=${included}`);
  if (unexpectedDir) {
    refuse("an uninspected dnsmasq include directory is active");
  }
  const unexpectedMain =
    ((arg === "-C" || arg === "--conf-file") && next !== mainPath) ||
    (arg.startsWith("-C") && arg !== "-C" && arg !== `-C${mainPath}`) ||
    (arg.startsWith("--conf-file=") && arg !== `--conf-file=${mainPath}`);
  if (unexpectedMain) {
    refuse("an uninspected dnsmasq main configuration is active");
  }
}

function checkConfigSources(opts: NativeDnsPlanOptions): void {
  const included = `${opts.includeDir},*.conf`;
  for (const [index, arg] of opts.dnsmasqArgs.entries()) {
    checkRuntimeConfigSource({
      arg,
      next: opts.dnsmasqArgs[index + 1],
      included,
      mainPath: opts.mainConfig.path,
    });
  }
  for (const rawLine of (opts.mainConfig.content ?? "").split(LINE_BREAK)) {
    const line = rawLine.trim();
    if (line.startsWith("#")) {
      continue;
    }
    const equal = line.indexOf("=");
    const directive = line
      .slice(0, equal < 0 ? undefined : equal)
      .trim()
      .toLowerCase();
    const value = equal < 0 ? "" : line.slice(equal + 1).trim();
    if (
      (directive === "conf-dir" && value !== included) ||
      directive === "conf-file" ||
      directive === "addn-hosts" ||
      directive === "hostsdir"
    ) {
      refuse("the main configuration loads uninspected DNS files");
    }
  }
}

function checkParentClaim(opts: NativeDnsPlanOptions): string {
  if (opts.builtInParentClaim !== "hack.gy") {
    refuse("a nested built-in suffix needs an explicit parent claim");
  }
  const parentLines = (opts.mainConfig.content ?? "")
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("address=/.hack.gy/"));
  if (
    parentLines.length !== 1 ||
    !V4_TARGETS.has(parentLines[0]?.slice("address=/.hack.gy/".length) ?? "")
  ) {
    refuse("the built-in hack.gy parent dnsmasq claim is missing or ambiguous");
  }
  const parentResolvers = opts.resolverFiles.filter(
    (file) => basename(file.path).toLowerCase() === "hack.gy"
  );
  if (
    parentResolvers.length !== 1 ||
    parentResolvers[0]?.content !== RESOLVER_CONTENT
  ) {
    refuse(
      "the built-in hack.gy parent resolver claim is missing or unexpected"
    );
  }
  return (
    parentLines[0]?.slice("address=/.hack.gy/".length) ??
    refuse("missing parent address")
  );
}

function hash(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function matchesReceipt(
  actual: NativeDnsReceipt,
  expected: NativeDnsReceipt
): boolean {
  return (
    actual.version === expected.version &&
    actual.state === expected.state &&
    actual.domain === expected.domain &&
    actual.dnsmasqPath === expected.dnsmasqPath &&
    actual.resolverPath === expected.resolverPath &&
    actual.dnsmasqSha256 === expected.dnsmasqSha256 &&
    actual.resolverSha256 === expected.resolverSha256
  );
}

function validateInputs(opts: NativeDnsPlanOptions): {
  domain: string;
  builtInParent: "hack.gy" | undefined;
  parentAddress: string | null;
} {
  const domain = parseDefaultDomain(opts.domain);
  if (
    domain !== opts.domain ||
    BUILT_IN_DOMAINS.some((root) => root === domain)
  ) {
    refuse("the selected suffix must be a canonical custom domain");
  }
  checkSnapshot(opts.mainConfig);
  checkSnapshot(opts.hosts);
  if (opts.hosts.content === null) {
    refuse("a hosts-file snapshot is required");
  }
  const includeDir = checkPath(opts.includeDir);
  const resolverDir = checkPath(opts.resolverDir);
  checkFiles(opts.includeFiles, includeDir);
  checkFiles(opts.resolverFiles, resolverDir);
  if (opts.mainConfig.path === opts.hosts.path || includeDir === resolverDir) {
    refuse("DNS input or output paths overlap");
  }
  if (!hasRuntimeInclude(opts.dnsmasqArgs, includeDir)) {
    refuse("running dnsmasq does not load the managed include directory");
  }
  checkConfigSources(opts);
  const builtInParent = BUILT_IN_DOMAINS.find((root) =>
    domain.endsWith(`.${root}`)
  );
  if (builtInParent && builtInParent !== DEFAULT_OAUTH_ALIAS_ROOT) {
    refuse("custom domains cannot nest beneath this built-in root");
  }
  const parentAddress =
    builtInParent === DEFAULT_OAUTH_ALIAS_ROOT ? checkParentClaim(opts) : null;
  return { domain, builtInParent, parentAddress };
}

function managedFile(
  files: readonly NativeDnsFileSnapshot[],
  path: string
): NativeDnsFileSnapshot | undefined {
  const file = files.find(
    (entry) => entry.path.toLowerCase() === path.toLowerCase()
  );
  if (file && file.path !== path) {
    refuse("a managed output path has a case-variant collision");
  }
  return file;
}

function checkDnsmasqClaims(opts: {
  readonly inputs: NativeDnsPlanOptions;
  readonly domain: string;
  readonly dnsmasqPath: string;
  readonly dnsmasqContent: string;
  readonly builtInParent: "hack.gy" | undefined;
  readonly managedDnsmasq: NativeDnsFileSnapshot | undefined;
}): void {
  const allClaims = [
    ...claimsInConfig(opts.inputs.mainConfig.content ?? "").map((claim) => ({
      ...claim,
      path: opts.inputs.mainConfig.path,
    })),
    ...opts.inputs.includeFiles.flatMap((file) =>
      claimsInConfig(file.content ?? "").map((claim) => ({
        ...claim,
        path: file.path,
      }))
    ),
  ];
  for (const claim of allClaims) {
    if (!overlaps(opts.domain, claim.domain)) {
      continue;
    }
    const isOwnedOutput =
      claim.domain === opts.domain &&
      claim.path === opts.dnsmasqPath &&
      opts.managedDnsmasq?.content === opts.dnsmasqContent &&
      claim.line === opts.dnsmasqContent.trim();
    const isBuiltInParent =
      opts.builtInParent === "hack.gy" &&
      claim.domain === "hack.gy" &&
      claim.path === opts.inputs.mainConfig.path &&
      claim.line.startsWith("address=/.hack.gy/") &&
      V4_TARGETS.has(claim.line.slice("address=/.hack.gy/".length));
    if (!(isOwnedOutput || isBuiltInParent)) {
      refuse("a foreign or overlapping dnsmasq claim exists");
    }
  }
}

function checkResolverClaims(opts: {
  readonly files: readonly NativeDnsFileSnapshot[];
  readonly domain: string;
  readonly resolverPath: string;
  readonly builtInParent: "hack.gy" | undefined;
}): void {
  for (const file of opts.files) {
    const claim = basename(file.path).toLowerCase();
    if (!overlaps(opts.domain, claim)) {
      continue;
    }
    const isOwnedOutput =
      file.path === opts.resolverPath && file.content === RESOLVER_CONTENT;
    const isBuiltInParent =
      opts.builtInParent === "hack.gy" && claim === "hack.gy";
    if (!(isOwnedOutput || isBuiltInParent)) {
      refuse("a foreign or overlapping resolver claim exists");
    }
  }
}

function checkHostsClaims(content: string, domain: string): void {
  for (const rawLine of content.split(LINE_BREAK)) {
    const line = rawLine.split("#", 1)[0]?.trim() ?? "";
    const [, ...hosts] = line.split(WHITESPACE);
    if (
      hosts.some((host) => {
        const value = host.toLowerCase().replace(TRAILING_DOT, "");
        return value === domain || value.endsWith(`.${domain}`);
      })
    ) {
      refuse("a hosts-file claim exists inside the selected suffix");
    }
  }
}

function resolveStatus(opts: {
  readonly managedDnsmasq: NativeDnsFileSnapshot | undefined;
  readonly managedResolver: NativeDnsFileSnapshot | undefined;
  readonly dnsmasqContent: string;
  readonly receipt: NativeDnsReceipt | null;
  readonly activeReceipt: NativeDnsReceipt;
  readonly inactiveReceipt: NativeDnsReceipt;
}): "available" | "active" {
  const hasDnsmasq = opts.managedDnsmasq !== undefined;
  const hasResolver = opts.managedResolver !== undefined;
  if (hasDnsmasq !== hasResolver || (hasDnsmasq && !opts.receipt)) {
    refuse("partial or unowned managed DNS files require explicit recovery");
  }
  if (
    !hasDnsmasq &&
    (!opts.receipt || matchesReceipt(opts.receipt, opts.inactiveReceipt))
  ) {
    return "available";
  }
  if (
    opts.receipt &&
    (!(
      hasDnsmasq &&
      hasResolver &&
      matchesReceipt(opts.receipt, opts.activeReceipt)
    ) ||
      opts.managedDnsmasq.content !== opts.dnsmasqContent ||
      opts.managedResolver.content !== RESOLVER_CONTENT)
  ) {
    refuse(
      "the private DNS receipt or managed files do not match an active claim"
    );
  }
  return "active";
}

/**
 * Pure, conservative plan for one native custom suffix. The caller must supply
 * fresh bounded snapshots, verify path identity again before writes, atomically
 * persist pending/active receipts, and independently prove live DNS after restart.
 */
export function planNativeDomainDns(opts: NativeDnsPlanOptions): NativeDnsPlan {
  const { domain, builtInParent, parentAddress } = validateInputs(opts);
  const dnsmasqPath = join(opts.includeDir, `hack-native-${domain}.conf`);
  const resolverPath = join(opts.resolverDir, domain);
  if (Buffer.byteLength(basename(dnsmasqPath), "utf8") > 255) {
    refuse(
      "the managed dnsmasq filename exceeds the filesystem component limit"
    );
  }
  if (
    [opts.mainConfig.path, opts.hosts.path].includes(dnsmasqPath) ||
    [opts.mainConfig.path, opts.hosts.path, dnsmasqPath].includes(resolverPath)
  ) {
    refuse("DNS input or output paths overlap");
  }
  const dnsmasqContent = `address=/.${domain}/${DEFAULT_HOST_DNS_IP}\n`;
  const resolverContent = RESOLVER_CONTENT;
  const managedDnsmasq = managedFile(opts.includeFiles, dnsmasqPath);
  const managedResolver = managedFile(opts.resolverFiles, resolverPath);
  checkDnsmasqClaims({
    inputs: opts,
    domain,
    dnsmasqPath,
    dnsmasqContent,
    builtInParent,
    managedDnsmasq,
  });
  checkResolverClaims({
    files: opts.resolverFiles,
    domain,
    resolverPath,
    builtInParent,
  });
  checkHostsClaims(opts.hosts.content ?? "", domain);

  const receiptBase = {
    version: 1,
    domain,
    dnsmasqPath,
    resolverPath,
    dnsmasqSha256: hash(dnsmasqContent),
    resolverSha256: hash(resolverContent),
  } as const;
  const pendingReceipt: NativeDnsReceipt = Object.freeze({
    ...receiptBase,
    state: "pending",
  });
  const activeReceipt: NativeDnsReceipt = Object.freeze({
    ...receiptBase,
    state: "active",
  });
  const removingReceipt: NativeDnsReceipt = Object.freeze({
    ...receiptBase,
    state: "removing",
  });
  const inactiveReceipt: NativeDnsReceipt = Object.freeze({
    ...receiptBase,
    state: "inactive",
  });
  const status = resolveStatus({
    managedDnsmasq,
    managedResolver,
    dnsmasqContent,
    receipt: opts.receipt,
    activeReceipt,
    inactiveReceipt,
  });
  const activation =
    status === "active"
      ? []
      : [
          "Persist the pending receipt in private state",
          `Atomically write ${dnsmasqPath}`,
          `Atomically write ${resolverPath} with privileged authorization`,
          "Restart dnsmasq and flush the host DNS cache",
          "Verify live resolution through the selected suffix",
          "Persist the active receipt in private state",
        ];
  return Object.freeze({
    domain,
    dnsmasqPath,
    resolverPath,
    dnsmasqContent,
    resolverContent,
    status,
    pendingReceipt,
    activeReceipt,
    removingReceipt,
    inactiveReceipt,
    parentAddress,
    activation: Object.freeze(activation),
  });
}
