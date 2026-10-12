import { createHash } from "node:crypto";
import { CliUsageError } from "../cli/command.ts";
import {
  DEFAULT_CADDY_IP,
  DEFAULT_HOST_DNS_IP,
  DEFAULT_NEW_PROJECT_TLD,
  DEFAULT_OAUTH_ALIAS_ROOT,
  DEFAULT_PROJECT_TLD,
} from "../constants.ts";
import { isRecord } from "./guards.ts";

/**
 * Native repair of the built-in `*.hack.local` route.
 *
 * Under the native backend the HTTPS relay listens on 127.0.0.1, while an older
 * Docker-era install may still route `.hack.local` to Docker Caddy
 * (172.30.0.2). This module decides whether the single Hack-managed
 * `address=/.hack.local/<target>` dnsmasq line may be rewritten in place to
 * 127.0.0.1, applies that rewrite through injected effects, and restores the
 * exact earlier line from a private receipt.
 *
 * Invariants:
 * - Only the one managed line changes; every other byte of the file is kept.
 *   No second line for the suffix is ever added.
 * - A rewrite needs a verified native relay, a dead old target and a fresh
 *   inspection after authorization. Every unmet precondition is a closed
 *   refusal reason, never a best-effort change.
 * - A pending receipt is published before any host effect. An interrupted run
 *   leaves it for explicit recovery through the rollback command. When the
 *   recorded file has changed since, that command releases the receipt after
 *   confirmation instead of writing, so recovery can never get stuck.
 * - Repair and rollback hold an exclusive lock for their whole mutation, so an
 *   automatic restore never mistakes another run's write for its own.
 * - Strings are lossless decodings of the file bytes (BOM included), so every
 *   hash equals the SHA-256 of the raw file.
 * - Diagnostics never echo free-form file contents. Lines appear only in the
 *   validated managed form, and every interpolated value is control-free.
 */

export const HACK_LOCAL_DOMAIN = DEFAULT_NEW_PROJECT_TLD;
export const HACK_LOCAL_RESOLVER_CONTENT = `nameserver ${DEFAULT_HOST_DNS_IP}\n`;
export const HACK_LOCAL_RELAY_LINE = `address=/.${HACK_LOCAL_DOMAIN}/${DEFAULT_HOST_DNS_IP}`;
export const HACK_LOCAL_REPAIR_COMMAND = "hack doctor --fix";
export const HACK_LOCAL_ROLLBACK_COMMAND = `hack global dns deactivate --domain ${HACK_LOCAL_DOMAIN}`;

const LINE_PREFIX = `address=/.${HACK_LOCAL_DOMAIN}/`;
/** Former Hack-written targets that may be replaced once proven dead. */
const REPLACEABLE_TARGETS: ReadonlySet<string> = new Set([
  DEFAULT_CADDY_IP,
  "::1",
]);
/** Every line a repair can record as the earlier line. */
const RECORDABLE_OLD_LINES: ReadonlySet<string> = new Set(
  [DEFAULT_HOST_DNS_IP, ...REPLACEABLE_TARGETS].map(
    (target) => `${LINE_PREFIX}${target}`
  )
);
const TARGET_FORMAT = /^[0-9a-f:.]+$/i;
const DOMAIN_TOKEN = /[a-z0-9-]+(?:\.[a-z0-9-]+)*/gi;
const SHA256 = /^[0-9a-f]{64}$/;
const RESOLVER_IDENTITY = /^\d+:\d+$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const BUILT_IN_ROOTS: ReadonlySet<string> = new Set([
  DEFAULT_PROJECT_TLD,
  DEFAULT_NEW_PROJECT_TLD,
  DEFAULT_OAUTH_ALIAS_ROOT,
]);

/** Closed set of reasons a repair or rollback does not change the host. */
export type HackLocalRouteRefusal =
  | "invalid-receipt"
  | "pending-receipt"
  | "relay-not-verified"
  | "dnsmasq-config-missing"
  | "no-managed-line"
  | "unmanaged-line"
  | "foreign-target"
  | "foreign-resolver"
  | "old-target-live"
  | "non-interactive"
  | "declined"
  | "busy"
  | "restart-unavailable"
  | "inputs-changed"
  | "no-receipt";

export interface HackLocalRouteReceipt {
  readonly version: 1;
  readonly kind: "hack-local-route-repair";
  /**
   * `released`: the recorded file changed after the repair, and the user
   * chose to keep the current bytes instead of restoring the earlier line.
   */
  readonly state: "pending" | "applied" | "rolled-back" | "released";
  readonly domain: typeof HACK_LOCAL_DOMAIN;
  readonly dnsmasqPath: string;
  readonly resolverPath: string;
  readonly oldLine: string;
  readonly newLine: string;
  /** SHA-256 of the whole dnsmasq file before and after the line rewrite. */
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly resolverAction: "keep" | "create";
  readonly resolverSha256: string;
  /** Identity of a resolver this repair created; null until creation is confirmed. */
  readonly resolverIdentity: string | null;
  readonly relayPort: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HackLocalRoutePaths {
  readonly dnsmasqPath: string;
  readonly resolverPath: string;
  readonly receiptPath: string;
}

/** Every host read and effect is supplied by the caller. */
export interface HackLocalRouteDependencies {
  readonly paths: HackLocalRoutePaths;
  readonly readReceipt: () => Promise<string | null>;
  /** Atomically and durably publish the private receipt. */
  readonly writeReceipt: (receipt: HackLocalRouteReceipt) => Promise<void>;
  readonly readDnsmasq: () => Promise<string | null>;
  readonly readIncludeFiles: () => Promise<
    readonly { readonly path: string; readonly content: string }[]
  >;
  readonly readResolver: () => Promise<string | null>;
  /** Atomic replacement that refuses unless the current bytes equal expected. */
  readonly replaceDnsmasq: (opts: {
    readonly expected: string;
    readonly next: string;
  }) => Promise<void>;
  /** No-clobber privileged create; returns the created file identity. */
  readonly createResolver: (content: string) => Promise<string>;
  /** Privileged removal of an exact identity and content match only. */
  readonly removeResolverIfOwned: (opts: {
    readonly identity: string;
    readonly content: string;
  }) => Promise<boolean>;
  /** The active native relay owner and its listening 127.0.0.1 port, or null. */
  readonly verifyRelay: () => Promise<{ readonly port: number } | null>;
  /** Bounded probe: true when the old target still answers on 443. */
  readonly probeTarget: (target: string) => Promise<boolean>;
  readonly canPrompt: () => boolean;
  /** Human confirmation plus the native administrator prompt. */
  readonly authorize: (message: string) => Promise<boolean>;
  /** Human confirmation only, for a change limited to the private receipt. */
  readonly confirm: (message: string) => Promise<boolean>;
  /**
   * Take the exclusive repair/rollback lock. Returns its release, or null
   * when another live run holds it.
   */
  readonly acquireLock: () => Promise<(() => Promise<void>) | null>;
  /** Validate the dnsmasq service before effects; return its restart. */
  readonly prepareRestart: () => Promise<() => Promise<void>>;
  readonly flushDnsCache: () => Promise<void>;
  readonly verifyLiveDns: () => Promise<void>;
  readonly now: () => Date;
}

export interface HackLocalRoutePlan {
  readonly paths: HackLocalRoutePaths;
  readonly oldLine: string;
  readonly newLine: string;
  readonly oldTarget: string;
  readonly beforeContent: string;
  readonly afterContent: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly resolverAction: "keep" | "create";
  readonly relayPort: number;
  readonly fingerprint: string;
}

export type HackLocalRouteInspection =
  | {
      readonly status: "current";
      readonly paths: HackLocalRoutePaths;
      readonly relayPort: number;
      readonly receipt: HackLocalRouteReceipt | null;
    }
  | {
      readonly status: "repairable";
      readonly plan: HackLocalRoutePlan;
      readonly receipt: HackLocalRouteReceipt | null;
    }
  | {
      readonly status: "refused";
      readonly reason: HackLocalRouteRefusal;
      readonly detail: string;
      readonly paths: HackLocalRoutePaths;
      readonly receipt: HackLocalRouteReceipt | null;
    };

export type HackLocalRouteRepairResult =
  | {
      readonly outcome: "repaired";
      readonly plan: HackLocalRoutePlan;
      readonly receipt: HackLocalRouteReceipt;
    }
  | { readonly outcome: "current"; readonly relayPort: number }
  | {
      readonly outcome: "refused";
      readonly reason: HackLocalRouteRefusal;
      readonly detail: string;
      readonly command?: string;
    };

export type HackLocalRouteRollbackResult =
  | {
      readonly outcome: "rolled-back";
      readonly receipt: HackLocalRouteReceipt;
      /** A resolver this repair created but could not prove it still owns. */
      readonly retainedResolver: string | null;
      /**
       * Null when dnsmasq was restarted. Otherwise why the restored file
       * was not loaded (for example dnsmasq is not running).
       */
      readonly restartSkipped: string | null;
    }
  | {
      /** The file changed after the repair; nothing but the receipt changed. */
      readonly outcome: "released";
      readonly receipt: HackLocalRouteReceipt;
      readonly detail: string;
    }
  | {
      readonly outcome: "refused";
      readonly reason: HackLocalRouteRefusal;
      readonly detail: string;
      readonly command?: string;
    };

/**
 * JSON-safe summary for doctor and preview. It never includes free-form file
 * contents: `oldLine` and `newLine` appear only in the validated managed form,
 * and `detail` names lines by number.
 */
export interface HackLocalRouteReport {
  readonly status: "current" | "repairable" | "refused";
  readonly reason?: HackLocalRouteRefusal;
  readonly detail?: string;
  readonly oldLine?: string;
  readonly newLine?: string;
  readonly resolverAction?: "keep" | "create";
  readonly relayPort?: number;
  readonly dnsmasqPath: string;
  readonly resolverPath: string;
  readonly receiptPath: string;
  readonly receiptState: HackLocalRouteReceipt["state"] | null;
  readonly command?: string;
}

/**
 * SHA-256 of the UTF-8 encoding. File strings come from a fatal decoder that
 * keeps a leading BOM, so this equals the hash of the raw file bytes.
 */
export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Replace control characters so a value cannot drive the terminal. */
export function printable(value: string): string {
  return value.replace(CONTROL_CHARACTERS, "?");
}

interface ConfigLine {
  /** Line text without its terminator (a trailing CR is excluded too). */
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

function configLines(content: string): readonly ConfigLine[] {
  const lines: ConfigLine[] = [];
  let start = 0;
  while (start <= content.length) {
    const newline = content.indexOf("\n", start);
    const lineEnd = newline < 0 ? content.length : newline;
    const end =
      lineEnd > start && content[lineEnd - 1] === "\r" ? lineEnd - 1 : lineEnd;
    lines.push({ text: content.slice(start, end), start, end });
    if (newline < 0) {
      break;
    }
    start = newline + 1;
  }
  return lines;
}

/** True when a non-comment dnsmasq directive names hack.local or a subdomain. */
function claimsHackLocal(text: string): boolean {
  const line = text.trim();
  if (!line || line.startsWith("#")) {
    return false;
  }
  const equal = line.indexOf("=");
  if (equal < 0) {
    return false;
  }
  const value = line.slice(equal + 1).split("#", 1)[0] ?? "";
  return (value.match(DOMAIN_TOKEN) ?? []).some((token) => {
    const domain = token.toLowerCase();
    return (
      domain === HACK_LOCAL_DOMAIN || domain.endsWith(`.${HACK_LOCAL_DOMAIN}`)
    );
  });
}

/** Replace exactly one whole line; null when the line is absent or repeated. */
export function replaceManagedLine(opts: {
  readonly content: string;
  readonly from: string;
  readonly to: string;
}): string | null {
  const matches = configLines(opts.content).filter(
    (line) => line.text === opts.from
  );
  if (matches.length !== 1) {
    return null;
  }
  const [line] = matches as [ConfigLine];
  return `${opts.content.slice(0, line.start)}${opts.to}${opts.content.slice(line.end)}`;
}

type DnsmasqAnalysis =
  | {
      readonly kind: "refused";
      readonly reason: HackLocalRouteRefusal;
      readonly detail: string;
    }
  | { readonly kind: "line"; readonly line: string; readonly target: string };

/** Pure classification of the managed line; exported for focused tests. */
export function analyzeHackLocalDnsmasq(opts: {
  readonly content: string | null;
  readonly includeFiles: readonly {
    readonly path: string;
    readonly content: string;
  }[];
}): DnsmasqAnalysis {
  if (opts.content === null) {
    return {
      kind: "refused",
      reason: "dnsmasq-config-missing",
      detail: "The dnsmasq configuration does not exist.",
    };
  }
  const included = opts.includeFiles.find((file) =>
    configLines(file.content).some((line) => claimsHackLocal(line.text))
  );
  if (included) {
    return {
      kind: "refused",
      reason: "unmanaged-line",
      detail: `${printable(included.path)} also claims .${HACK_LOCAL_DOMAIN}; Hack manages only the main configuration line.`,
    };
  }
  const claims = configLines(opts.content)
    .map((line, index) => ({ ...line, number: index + 1 }))
    .filter((line) => claimsHackLocal(line.text));
  if (claims.length === 0) {
    return {
      kind: "refused",
      reason: "no-managed-line",
      detail: `No ${LINE_PREFIX}<target> line exists; the native repair never adds one.`,
    };
  }
  if (claims.length > 1) {
    return {
      kind: "refused",
      reason: "unmanaged-line",
      detail: `${claims.length} lines claim .${HACK_LOCAL_DOMAIN}; only a single Hack-managed line can be rewritten.`,
    };
  }
  const claim = claims[0] as ConfigLine & { readonly number: number };
  const line = claim.text;
  const target = line.startsWith(LINE_PREFIX)
    ? line.slice(LINE_PREFIX.length)
    : "";
  if (!TARGET_FORMAT.test(target)) {
    return {
      kind: "refused",
      reason: "unmanaged-line",
      detail: `Line ${claim.number} claims .${HACK_LOCAL_DOMAIN} but is not in the Hack-managed ${LINE_PREFIX}<address> form.`,
    };
  }
  if (target !== DEFAULT_HOST_DNS_IP && !REPLACEABLE_TARGETS.has(target)) {
    return {
      kind: "refused",
      reason: "foreign-target",
      detail: `Line ${claim.number} routes .${HACK_LOCAL_DOMAIN} to an address Hack never wrote; refusing to replace it.`,
    };
  }
  return { kind: "line", line, target };
}

function analyzeResolver(
  content: string | null
): "keep" | "create" | "foreign" {
  if (content === null) {
    return "create";
  }
  return content.trim() === HACK_LOCAL_RESOLVER_CONTENT.trim()
    ? "keep"
    : "foreign";
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length < 4096;
}

/** A single-line absolute path; receipts never carry control characters. */
function receiptPathValue(value: unknown): value is string {
  return (
    nonEmptyString(value) && value.startsWith("/") && printable(value) === value
  );
}

/** Strict receipt parsing; any unknown shape refuses rather than guessing ownership. */
export function parseHackLocalRouteReceipt(raw: string): HackLocalRouteReceipt {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("hack.local repair receipt is not valid JSON");
  }
  const ok =
    isRecord(value) &&
    value.version === 1 &&
    value.kind === "hack-local-route-repair" &&
    (value.state === "pending" ||
      value.state === "applied" ||
      value.state === "rolled-back" ||
      value.state === "released") &&
    value.domain === HACK_LOCAL_DOMAIN &&
    receiptPathValue(value.dnsmasqPath) &&
    receiptPathValue(value.resolverPath) &&
    typeof value.oldLine === "string" &&
    RECORDABLE_OLD_LINES.has(value.oldLine) &&
    value.newLine === HACK_LOCAL_RELAY_LINE &&
    typeof value.beforeSha256 === "string" &&
    SHA256.test(value.beforeSha256) &&
    typeof value.afterSha256 === "string" &&
    SHA256.test(value.afterSha256) &&
    (value.resolverAction === "keep" || value.resolverAction === "create") &&
    typeof value.resolverSha256 === "string" &&
    SHA256.test(value.resolverSha256) &&
    (value.resolverIdentity === null ||
      (typeof value.resolverIdentity === "string" &&
        RESOLVER_IDENTITY.test(value.resolverIdentity))) &&
    typeof value.relayPort === "number" &&
    Number.isInteger(value.relayPort) &&
    value.relayPort > 0 &&
    value.relayPort < 65_536 &&
    nonEmptyString(value.createdAt) &&
    nonEmptyString(value.updatedAt);
  if (!ok) {
    throw new Error("hack.local repair receipt has an unexpected shape");
  }
  return value as unknown as HackLocalRouteReceipt;
}

type StoredReceipt =
  | {
      readonly raw: string | null;
      readonly receipt: HackLocalRouteReceipt | null;
    }
  | { readonly invalid: string };

async function readReceipt(
  deps: HackLocalRouteDependencies
): Promise<StoredReceipt> {
  const raw = await deps.readReceipt();
  if (raw === null) {
    return { raw, receipt: null };
  }
  try {
    return { raw, receipt: parseHackLocalRouteReceipt(raw) };
  } catch (error) {
    return { invalid: error instanceof Error ? error.message : String(error) };
  }
}

function refused(opts: {
  readonly reason: HackLocalRouteRefusal;
  readonly detail: string;
  readonly paths: HackLocalRoutePaths;
  readonly receipt: HackLocalRouteReceipt | null;
}): HackLocalRouteInspection {
  return { status: "refused", ...opts };
}

/**
 * Read-only inspection. Preconditions are checked in a fixed order so that a
 * missing relay never reads host DNS files and a live old target is never
 * replaced: receipt, relay, managed line, resolver, then the old-target probe.
 */
export async function inspectHackLocalRoute(
  deps: HackLocalRouteDependencies
): Promise<HackLocalRouteInspection> {
  const { paths } = deps;
  const stored = await readReceipt(deps);
  if ("invalid" in stored) {
    return refused({
      reason: "invalid-receipt",
      detail: printable(
        `${stored.invalid}; refusing to infer ownership of ${paths.receiptPath}.`
      ),
      paths,
      receipt: null,
    });
  }
  const { receipt } = stored;
  if (receipt?.state === "pending") {
    return refused({
      reason: "pending-receipt",
      detail: `An interrupted hack.local repair left a pending receipt. Run ${HACK_LOCAL_ROLLBACK_COMMAND} to restore the recorded earlier line, or, if dnsmasq.conf changed since, to release the receipt without writing.`,
      paths,
      receipt,
    });
  }
  const relay = await deps.verifyRelay();
  if (!relay) {
    return refused({
      reason: "relay-not-verified",
      detail:
        "No verified native HTTPS relay is listening on 127.0.0.1; start a native project before repairing *.hack.local.",
      paths,
      receipt,
    });
  }
  const [content, includeFiles, resolver] = await Promise.all([
    deps.readDnsmasq(),
    deps.readIncludeFiles(),
    deps.readResolver(),
  ]);
  const analysis = analyzeHackLocalDnsmasq({ content, includeFiles });
  if (analysis.kind === "refused") {
    return refused({ ...analysis, paths, receipt });
  }
  const resolverAction = analyzeResolver(resolver);
  if (resolverAction === "foreign") {
    return refused({
      reason: "foreign-resolver",
      detail: printable(
        `${paths.resolverPath} exists with content Hack did not write; refusing to change it.`
      ),
      paths,
      receipt,
    });
  }
  const beforeContent = content as string;
  if (analysis.target === DEFAULT_HOST_DNS_IP && resolverAction === "keep") {
    return {
      status: "current",
      paths,
      relayPort: relay.port,
      receipt,
    };
  }
  if (
    analysis.target !== DEFAULT_HOST_DNS_IP &&
    (await deps.probeTarget(analysis.target))
  ) {
    return refused({
      reason: "old-target-live",
      detail: `${analysis.target}:443 still answers (Docker Caddy may be running); refusing to break the live route.`,
      paths,
      receipt,
    });
  }
  const afterContent =
    analysis.target === DEFAULT_HOST_DNS_IP
      ? beforeContent
      : replaceManagedLine({
          content: beforeContent,
          from: analysis.line,
          to: HACK_LOCAL_RELAY_LINE,
        });
  if (afterContent === null) {
    return refused({
      reason: "unmanaged-line",
      detail: "The managed line could not be located exactly once.",
      paths,
      receipt,
    });
  }
  const fingerprint = sha256(
    JSON.stringify({
      beforeContent,
      includeFiles,
      resolver,
      receipt: stored.raw,
      relayPort: relay.port,
    })
  );
  return {
    status: "repairable",
    receipt,
    plan: {
      paths,
      oldLine: analysis.line,
      newLine: HACK_LOCAL_RELAY_LINE,
      oldTarget: analysis.target,
      beforeContent,
      afterContent,
      beforeSha256: sha256(beforeContent),
      afterSha256: sha256(afterContent),
      resolverAction,
      relayPort: relay.port,
      fingerprint,
    },
  };
}

/** Summarize an inspection for doctor and preview output. */
export function reportHackLocalRoute(
  inspection: HackLocalRouteInspection
): HackLocalRouteReport {
  const paths =
    inspection.status === "repairable"
      ? inspection.plan.paths
      : inspection.paths;
  const base = {
    dnsmasqPath: paths.dnsmasqPath,
    resolverPath: paths.resolverPath,
    receiptPath: paths.receiptPath,
    receiptState: inspection.receipt?.state ?? null,
  };
  if (inspection.status === "current") {
    return {
      ...base,
      status: "current",
      relayPort: inspection.relayPort,
      ...(inspection.receipt?.state === "applied"
        ? { command: HACK_LOCAL_ROLLBACK_COMMAND }
        : {}),
    };
  }
  if (inspection.status === "repairable") {
    return {
      ...base,
      status: "repairable",
      oldLine: inspection.plan.oldLine,
      newLine: inspection.plan.newLine,
      resolverAction: inspection.plan.resolverAction,
      relayPort: inspection.plan.relayPort,
      command: HACK_LOCAL_REPAIR_COMMAND,
    };
  }
  return {
    ...base,
    status: "refused",
    reason: inspection.reason,
    detail: inspection.detail,
    ...(inspection.reason === "pending-receipt"
      ? { command: HACK_LOCAL_ROLLBACK_COMMAND }
      : {}),
  };
}

/** One-line human message for a report; control characters are replaced. */
export function describeHackLocalRoute(report: HackLocalRouteReport): string {
  if (report.status === "current") {
    return printable(
      `*.${HACK_LOCAL_DOMAIN} routes to the native relay on 127.0.0.1:${report.relayPort}.${
        report.receiptState === "applied"
          ? ` Undo the native repair with: ${HACK_LOCAL_ROLLBACK_COMMAND}`
          : ""
      }`
    );
  }
  if (report.status === "repairable") {
    const resolver =
      report.resolverAction === "create"
        ? `create ${report.resolverPath} with "nameserver 127.0.0.1"`
        : "";
    const rewrite =
      report.oldLine === report.newLine
        ? ""
        : `rewrite "${report.oldLine}" to "${report.newLine}" in ${report.dnsmasqPath}`;
    const change = [rewrite, resolver].filter(Boolean).join(" and ");
    return printable(
      `Proposed: ${change}. Apply with: ${HACK_LOCAL_REPAIR_COMMAND}`
    );
  }
  return printable(`Not repairable (${report.reason}): ${report.detail}`);
}

function samePlan(
  left: HackLocalRoutePlan,
  right: HackLocalRoutePlan
): boolean {
  return (
    left.fingerprint === right.fingerprint &&
    left.beforeSha256 === right.beforeSha256 &&
    left.afterSha256 === right.afterSha256 &&
    left.oldLine === right.oldLine &&
    left.resolverAction === right.resolverAction &&
    left.relayPort === right.relayPort &&
    left.paths.dnsmasqPath === right.paths.dnsmasqPath &&
    left.paths.resolverPath === right.paths.resolverPath &&
    left.paths.receiptPath === right.paths.receiptPath
  );
}

function errorMessage(error: unknown): string {
  return printable(
    error instanceof Error ? error.message : String(error)
  ).slice(0, 512);
}

/** How the recorded earlier bytes relate to the current file. */
export type HackLocalRestoreStep =
  /** The file holds the repaired bytes; `next` reproduces the earlier hash. */
  | { readonly kind: "write"; readonly next: string }
  /** The file already holds the earlier bytes. */
  | { readonly kind: "unchanged" }
  /** The file matches neither recorded hash, or is missing. */
  | { readonly kind: "drift" }
  /** The receipt's lines do not reproduce its own recorded hashes. */
  | { readonly kind: "mismatch" };

/** Pure restore decision shared by the precheck and the effect. */
export function planHackLocalRestore(opts: {
  readonly current: string | null;
  readonly receipt: HackLocalRouteReceipt;
}): HackLocalRestoreStep {
  const { current, receipt } = opts;
  if (current === null) {
    return { kind: "drift" };
  }
  const currentSha = sha256(current);
  if (currentSha === receipt.beforeSha256) {
    return { kind: "unchanged" };
  }
  if (currentSha !== receipt.afterSha256) {
    return { kind: "drift" };
  }
  const next = replaceManagedLine({
    content: current,
    from: receipt.newLine,
    to: receipt.oldLine,
  });
  if (next === null || sha256(next) !== receipt.beforeSha256) {
    return { kind: "mismatch" };
  }
  return { kind: "write", next };
}

interface RestoreOutcome {
  readonly retainedResolver: string | null;
  /** True when restore wrote dnsmasq.conf or removed the resolver. */
  readonly changed: boolean;
  readonly restarted: boolean;
}

/**
 * Restore the recorded earlier state. Shared by explicit rollback and by
 * automatic cleanup when a repair fails. dnsmasq restarts only when this
 * restore changed something or `forceRestart` says the running service may
 * hold the repaired configuration; `restart` null skips it.
 */
async function restoreFromReceipt(opts: {
  readonly deps: HackLocalRouteDependencies;
  readonly receipt: HackLocalRouteReceipt;
  readonly restart: (() => Promise<void>) | null;
  readonly forceRestart: boolean;
}): Promise<RestoreOutcome> {
  const { deps, receipt } = opts;
  const current = await deps.readDnsmasq();
  const step = planHackLocalRestore({ current, receipt });
  let changed = false;
  if (step.kind === "write") {
    await deps.replaceDnsmasq({ expected: current as string, next: step.next });
    const verified = await deps.readDnsmasq();
    if (verified === null || sha256(verified) !== receipt.beforeSha256) {
      throw new Error("Restored dnsmasq configuration hash does not match");
    }
    changed = true;
  } else if (step.kind !== "unchanged") {
    throw new Error(
      step.kind === "drift"
        ? "dnsmasq configuration changed since the repair"
        : "Restored dnsmasq bytes would not match the receipt"
    );
  }
  let retainedResolver: string | null = null;
  if (receipt.resolverAction === "create") {
    const resolver = await deps.readResolver();
    if (resolver !== null) {
      const removed =
        receipt.resolverIdentity !== null &&
        (await deps.removeResolverIfOwned({
          identity: receipt.resolverIdentity,
          content: HACK_LOCAL_RESOLVER_CONTENT,
        }));
      if (removed) {
        changed = true;
      } else {
        retainedResolver = receipt.resolverPath;
      }
    }
  }
  let restarted = false;
  if ((changed || opts.forceRestart) && opts.restart) {
    await opts.restart();
    await deps.flushDnsCache();
    restarted = true;
  }
  return { retainedResolver, changed, restarted };
}

function stamp(
  receipt: HackLocalRouteReceipt,
  patch: Partial<Pick<HackLocalRouteReceipt, "state" | "resolverIdentity">>,
  now: Date
): HackLocalRouteReceipt {
  return Object.freeze({ ...receipt, ...patch, updatedAt: now.toISOString() });
}

function busy(): {
  readonly outcome: "refused";
  readonly reason: "busy";
  readonly detail: string;
} {
  return {
    outcome: "refused",
    reason: "busy",
    detail:
      "Another hack.local repair or rollback is running; nothing changed. Retry when it finishes.",
  };
}

/**
 * Authorized, reversible repair. Rechecks the plan after the administrator
 * prompt, publishes a pending receipt before effects, and on failure restores
 * the recorded earlier line. If that cleanup cannot be proven the pending
 * receipt stays for the explicit rollback command.
 */
export async function repairHackLocalRoute(
  deps: HackLocalRouteDependencies
): Promise<HackLocalRouteRepairResult> {
  const before = await inspectHackLocalRoute(deps);
  if (before.status === "current") {
    return { outcome: "current", relayPort: before.relayPort };
  }
  if (before.status === "refused") {
    return {
      outcome: "refused",
      reason: before.reason,
      detail: before.detail,
      ...(before.reason === "pending-receipt"
        ? { command: HACK_LOCAL_ROLLBACK_COMMAND }
        : {}),
    };
  }
  const { plan } = before;
  if (!deps.canPrompt()) {
    return {
      outcome: "refused",
      reason: "non-interactive",
      detail: `The repair needs interactive confirmation and a macOS administrator prompt. Run it in a terminal: ${HACK_LOCAL_REPAIR_COMMAND}`,
      command: HACK_LOCAL_REPAIR_COMMAND,
    };
  }
  const release = await deps.acquireLock();
  if (!release) {
    return busy();
  }
  try {
    return await repairUnderLock(deps, plan);
  } finally {
    await release();
  }
}

async function repairUnderLock(
  deps: HackLocalRouteDependencies,
  plan: HackLocalRoutePlan
): Promise<HackLocalRouteRepairResult> {
  const changes = [
    plan.oldLine === plan.newLine
      ? ""
      : `rewrite only "${plan.oldLine}" to "${plan.newLine}" in ${plan.paths.dnsmasqPath}`,
    plan.resolverAction === "create"
      ? `create ${plan.paths.resolverPath} with "nameserver 127.0.0.1"`
      : "",
  ].filter(Boolean);
  const probe =
    plan.oldTarget === DEFAULT_HOST_DNS_IP
      ? ""
      : `${plan.oldTarget}:443 did not answer; `;
  const approved = await deps.authorize(
    printable(
      `Native hack.local repair: ${changes.join(" and ")}? ${probe}the native relay listens on 127.0.0.1:${plan.relayPort}. This restarts dnsmasq. Undo: ${HACK_LOCAL_ROLLBACK_COMMAND}`
    )
  );
  if (!approved) {
    return {
      outcome: "refused",
      reason: "declined",
      detail: "The hack.local repair was not authorized; nothing changed.",
    };
  }
  let restart: () => Promise<void>;
  try {
    restart = await deps.prepareRestart();
  } catch (error) {
    return {
      outcome: "refused",
      reason: "restart-unavailable",
      detail: `The dnsmasq service cannot be restarted safely (${errorMessage(error)}); nothing changed.`,
    };
  }
  const after = await inspectHackLocalRoute(deps);
  if (after.status !== "repairable" || !samePlan(plan, after.plan)) {
    return {
      outcome: "refused",
      reason: "inputs-changed",
      detail:
        "DNS files, the relay or the old target changed during authorization; nothing changed.",
    };
  }

  const createdAt = deps.now().toISOString();
  let receipt: HackLocalRouteReceipt = Object.freeze({
    version: 1,
    kind: "hack-local-route-repair",
    state: "pending",
    domain: HACK_LOCAL_DOMAIN,
    dnsmasqPath: plan.paths.dnsmasqPath,
    resolverPath: plan.paths.resolverPath,
    oldLine: plan.oldLine,
    newLine: plan.newLine,
    beforeSha256: plan.beforeSha256,
    afterSha256: plan.afterSha256,
    resolverAction: plan.resolverAction,
    resolverSha256: sha256(HACK_LOCAL_RESOLVER_CONTENT),
    resolverIdentity: null,
    relayPort: plan.relayPort,
    createdAt,
    updatedAt: createdAt,
  });
  await deps.writeReceipt(receipt);

  let phase = "dnsmasq rewrite";
  let restartAttempted = false;
  try {
    if (plan.afterContent !== plan.beforeContent) {
      await deps.replaceDnsmasq({
        expected: plan.beforeContent,
        next: plan.afterContent,
      });
    }
    if (plan.resolverAction === "create") {
      phase = "resolver create";
      const identity = await deps.createResolver(HACK_LOCAL_RESOLVER_CONTENT);
      receipt = stamp(receipt, { resolverIdentity: identity }, deps.now());
      await deps.writeReceipt(receipt);
    }
    phase = "dnsmasq restart";
    restartAttempted = true;
    await restart();
    phase = "DNS cache flush";
    await deps.flushDnsCache();
    phase = "live DNS verification";
    await deps.verifyLiveDns();
    phase = "receipt";
    receipt = stamp(receipt, { state: "applied" }, deps.now());
    await deps.writeReceipt(receipt);
    return { outcome: "repaired", plan, receipt };
  } catch (cause) {
    let restored: RestoreOutcome;
    try {
      restored = await restoreFromReceipt({
        deps,
        receipt,
        restart,
        forceRestart: restartAttempted,
      });
      await deps.writeReceipt(
        stamp(receipt, { state: "rolled-back" }, deps.now())
      );
    } catch (cleanup) {
      throw new Error(
        `hack.local repair failed during ${phase}: ${errorMessage(cause)}; automatic restore failed (${errorMessage(cleanup)}). Recover with: ${HACK_LOCAL_ROLLBACK_COMMAND}`,
        { cause }
      );
    }
    const state =
      restored.changed || restored.restarted
        ? "the earlier dnsmasq line was restored"
        : "nothing was changed";
    throw new Error(
      printable(
        `hack.local repair failed during ${phase}: ${errorMessage(cause)}; ${state}${
          restored.retainedResolver
            ? `; ${restored.retainedResolver} was retained because its ownership is unproven`
            : ""
        }.`
      ),
      { cause }
    );
  }
}

/**
 * Restore the exact earlier line recorded by an applied or interrupted repair
 * and verify the whole-file hash. When the file changed since the repair (or
 * the receipt names another file), restoring would overwrite someone else's
 * bytes, so the command instead offers to release the receipt: after a plain
 * confirmation it marks the receipt `released` and changes nothing else.
 */
export async function rollbackHackLocalRoute(
  deps: HackLocalRouteDependencies
): Promise<HackLocalRouteRollbackResult> {
  const stored = await readReceipt(deps);
  if ("invalid" in stored) {
    return {
      outcome: "refused",
      reason: "invalid-receipt",
      detail: printable(
        `${stored.invalid}; refusing to infer ownership of ${deps.paths.receiptPath}.`
      ),
    };
  }
  const { receipt, raw } = stored;
  if (
    !receipt ||
    receipt.state === "rolled-back" ||
    receipt.state === "released"
  ) {
    return {
      outcome: "refused",
      reason: "no-receipt",
      detail: printable(
        `No applied or interrupted hack.local repair is recorded at ${deps.paths.receiptPath}; nothing to roll back.`
      ),
    };
  }
  const release = await deps.acquireLock();
  if (!release) {
    return busy();
  }
  try {
    return await rollbackUnderLock({ deps, receipt, raw });
  } finally {
    await release();
  }
}

async function rollbackUnderLock(opts: {
  readonly deps: HackLocalRouteDependencies;
  readonly receipt: HackLocalRouteReceipt;
  readonly raw: string | null;
}): Promise<HackLocalRouteRollbackResult> {
  const { deps, receipt } = opts;
  const current = await deps.readDnsmasq();
  const samePaths =
    receipt.dnsmasqPath === deps.paths.dnsmasqPath &&
    receipt.resolverPath === deps.paths.resolverPath;
  const step: HackLocalRestoreStep = samePaths
    ? planHackLocalRestore({ current, receipt })
    : { kind: "drift" };
  if (step.kind === "mismatch") {
    return {
      outcome: "refused",
      reason: "invalid-receipt",
      detail:
        "The receipt's recorded line does not reproduce its recorded file hash; refusing to write it.",
    };
  }
  if (!deps.canPrompt()) {
    return {
      outcome: "refused",
      reason: "non-interactive",
      detail: `Rollback needs interactive confirmation. Run it in a terminal: ${HACK_LOCAL_ROLLBACK_COMMAND}`,
      command: HACK_LOCAL_ROLLBACK_COMMAND,
    };
  }
  if (step.kind === "drift") {
    return await releaseReceipt({ ...opts, samePaths });
  }
  const approved = await deps.authorize(
    printable(
      `Restore "${receipt.oldLine}" in ${receipt.dnsmasqPath}${
        receipt.resolverAction === "create"
          ? ` and remove the ${receipt.resolverPath} this repair created`
          : ""
      }? This restarts dnsmasq.`
    )
  );
  if (!approved) {
    return {
      outcome: "refused",
      reason: "declined",
      detail: "The hack.local rollback was not authorized; nothing changed.",
    };
  }
  // Restoring the file needs no service; a missing or ambiguous dnsmasq only
  // means the restored line loads on its next start.
  let restart: (() => Promise<void>) | null = null;
  let restartSkipped: string | null = null;
  try {
    restart = await deps.prepareRestart();
  } catch (error) {
    restartSkipped = errorMessage(error);
  }
  const again = await deps.readReceipt();
  const recheck = await deps.readDnsmasq();
  if (again !== opts.raw || recheck !== current) {
    return {
      outcome: "refused",
      reason: "inputs-changed",
      detail:
        "The receipt or dnsmasq configuration changed during authorization; nothing changed.",
    };
  }
  const restored = await restoreFromReceipt({
    deps,
    receipt,
    restart,
    forceRestart: true,
  });
  const rolledBack = stamp(receipt, { state: "rolled-back" }, deps.now());
  await deps.writeReceipt(rolledBack);
  return {
    outcome: "rolled-back",
    receipt: rolledBack,
    retainedResolver: restored.retainedResolver,
    restartSkipped,
  };
}

async function releaseReceipt(opts: {
  readonly deps: HackLocalRouteDependencies;
  readonly receipt: HackLocalRouteReceipt;
  readonly raw: string | null;
  readonly samePaths: boolean;
}): Promise<HackLocalRouteRollbackResult> {
  const { deps, receipt } = opts;
  const why = opts.samePaths
    ? `${receipt.dnsmasqPath} changed after the hack.local repair`
    : `The receipt names ${receipt.dnsmasqPath}, not the current ${deps.paths.dnsmasqPath}`;
  const kept =
    receipt.resolverAction === "create" ? ` and ${receipt.resolverPath}` : "";
  const approved = await deps.confirm(
    printable(
      `${why}, so restoring "${receipt.oldLine}" would overwrite other changes. Release the ${receipt.state} receipt and leave the dnsmasq configuration${kept} exactly as they are?`
    )
  );
  if (!approved) {
    return {
      outcome: "refused",
      reason: "declined",
      detail: "The hack.local receipt was not released; nothing changed.",
    };
  }
  if ((await deps.readReceipt()) !== opts.raw) {
    return {
      outcome: "refused",
      reason: "inputs-changed",
      detail: "The receipt changed during confirmation; nothing changed.",
    };
  }
  const released = stamp(receipt, { state: "released" }, deps.now());
  await deps.writeReceipt(released);
  return {
    outcome: "released",
    receipt: released,
    detail: printable(
      `${why}. Hack released the receipt and left the dnsmasq configuration${kept} unchanged. Restore "${receipt.oldLine}" yourself if you still want the earlier route.`
    ),
  };
}

/** One-line human message for a rollback result; control-free. */
export function describeHackLocalRollback(
  result: HackLocalRouteRollbackResult
): string {
  if (result.outcome === "refused") {
    return printable(
      `hack.local rollback refused (${result.reason}): ${result.detail}`
    );
  }
  if (result.outcome === "released") {
    return printable(
      `Released the hack.local repair receipt. ${result.detail}`
    );
  }
  return printable(
    `Restored "${result.receipt.oldLine}"; the dnsmasq file hash matches the receipt.${
      result.retainedResolver
        ? ` ${result.retainedResolver} was retained because its ownership is unproven.`
        : ""
    }${
      result.restartSkipped
        ? ` dnsmasq was not restarted (${result.restartSkipped}); the restored line loads when dnsmasq next starts.`
        : ""
    }`
  );
}

export type NativeDnsCommandDomain =
  | { readonly kind: "custom"; readonly domain: string }
  | { readonly kind: "hack-local" };

/**
 * Select the suffix for `hack global dns preview|activate|deactivate`.
 * Without --domain only a configured custom default_domain is used; a
 * built-in default is a closed usage error that names the right command.
 */
export function selectNativeDnsCommandDomain(opts: {
  readonly verb: "preview" | "activate" | "deactivate";
  /** Normalized --domain value, if given. */
  readonly explicit: string | undefined;
  /** Normalized global default_domain (hack.local when unset). */
  readonly configuredDefault: string;
}): NativeDnsCommandDomain {
  const domain = opts.explicit ?? opts.configuredDefault;
  if (opts.explicit === undefined && BUILT_IN_ROOTS.has(domain)) {
    throw new CliUsageError(
      [
        `hack global dns ${opts.verb} needs --domain: the default domain ${domain} is a built-in root this command never claims.`,
        "For a dedicated custom suffix: hack global dns preview --domain v5.hack.gy",
        `To point *.${HACK_LOCAL_DOMAIN} at the native relay: ${HACK_LOCAL_REPAIR_COMMAND} (inspect first with hack global dns preview --domain ${HACK_LOCAL_DOMAIN})`,
        `To undo that repair: ${HACK_LOCAL_ROLLBACK_COMMAND}`,
      ].join("\n")
    );
  }
  if (domain === HACK_LOCAL_DOMAIN) {
    if (opts.verb === "activate") {
      throw new CliUsageError(
        `*.${HACK_LOCAL_DOMAIN} is a built-in root, not a scoped claim. Repair its native route with: ${HACK_LOCAL_REPAIR_COMMAND}`
      );
    }
    return { kind: "hack-local" };
  }
  return { kind: "custom", domain };
}
