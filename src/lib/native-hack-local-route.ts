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
 *   leaves it for explicit recovery through the rollback command.
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
const TARGET_FORMAT = /^[0-9a-f:.]+$/i;
const DOMAIN_TOKEN = /[a-z0-9-]+(?:\.[a-z0-9-]+)*/gi;
const SHA256 = /^[0-9a-f]{64}$/;
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
  | "inputs-changed"
  | "no-receipt"
  | "rollback-drift";

export interface HackLocalRouteReceipt {
  readonly version: 1;
  readonly kind: "hack-local-route-repair";
  readonly state: "pending" | "applied" | "rolled-back";
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
    }
  | {
      readonly outcome: "refused";
      readonly reason: HackLocalRouteRefusal;
      readonly detail: string;
      readonly command?: string;
    };

/** JSON-safe summary for doctor and preview; never includes file contents. */
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

export function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
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
      detail: `${included.path} also claims .${HACK_LOCAL_DOMAIN}; Hack manages only the main configuration line.`,
    };
  }
  const claims = configLines(opts.content).filter((line) =>
    claimsHackLocal(line.text)
  );
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
  const line = (claims[0] as ConfigLine).text;
  const target = line.startsWith(LINE_PREFIX)
    ? line.slice(LINE_PREFIX.length)
    : "";
  if (!TARGET_FORMAT.test(target)) {
    return {
      kind: "refused",
      reason: "unmanaged-line",
      detail: `"${line.slice(0, 200)}" is not in the Hack-managed ${LINE_PREFIX}<address> form.`,
    };
  }
  if (target !== DEFAULT_HOST_DNS_IP && !REPLACEABLE_TARGETS.has(target)) {
    return {
      kind: "refused",
      reason: "foreign-target",
      detail: `.${HACK_LOCAL_DOMAIN} routes to ${target}, which Hack never wrote; refusing to replace it.`,
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
      value.state === "rolled-back") &&
    value.domain === HACK_LOCAL_DOMAIN &&
    nonEmptyString(value.dnsmasqPath) &&
    nonEmptyString(value.resolverPath) &&
    nonEmptyString(value.oldLine) &&
    value.oldLine.startsWith(LINE_PREFIX) &&
    value.newLine === HACK_LOCAL_RELAY_LINE &&
    typeof value.beforeSha256 === "string" &&
    SHA256.test(value.beforeSha256) &&
    typeof value.afterSha256 === "string" &&
    SHA256.test(value.afterSha256) &&
    (value.resolverAction === "keep" || value.resolverAction === "create") &&
    typeof value.resolverSha256 === "string" &&
    SHA256.test(value.resolverSha256) &&
    (value.resolverIdentity === null ||
      nonEmptyString(value.resolverIdentity)) &&
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
      detail: `${stored.invalid}; refusing to infer ownership of ${paths.receiptPath}.`,
      paths,
      receipt: null,
    });
  }
  const { receipt } = stored;
  if (receipt?.state === "pending") {
    return refused({
      reason: "pending-receipt",
      detail: `An interrupted hack.local repair left a pending receipt. Restore the recorded earlier line with: ${HACK_LOCAL_ROLLBACK_COMMAND}`,
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
      detail: `${paths.resolverPath} exists with content Hack did not write; refusing to change it.`,
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

/** One-line human message for a report. */
export function describeHackLocalRoute(report: HackLocalRouteReport): string {
  if (report.status === "current") {
    return `*.${HACK_LOCAL_DOMAIN} routes to the native relay on 127.0.0.1:${report.relayPort}.${
      report.receiptState === "applied"
        ? ` Undo the native repair with: ${HACK_LOCAL_ROLLBACK_COMMAND}`
        : ""
    }`;
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
    return `Proposed: ${change}. Apply with: ${HACK_LOCAL_REPAIR_COMMAND}`;
  }
  return `Not repairable (${report.reason}): ${report.detail}`;
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
  return (error instanceof Error ? error.message : String(error))
    .replaceAll("\n", " ")
    .slice(0, 512);
}

/**
 * Restore the recorded earlier state. Shared by explicit rollback and by
 * automatic cleanup when a repair fails after its first effect.
 */
async function restoreFromReceipt(opts: {
  readonly deps: HackLocalRouteDependencies;
  readonly receipt: HackLocalRouteReceipt;
  readonly restart: () => Promise<void>;
}): Promise<{ readonly retainedResolver: string | null }> {
  const { deps, receipt } = opts;
  const current = await deps.readDnsmasq();
  if (current === null) {
    throw new Error("dnsmasq configuration disappeared during rollback");
  }
  const currentSha = sha256(current);
  if (
    currentSha === receipt.afterSha256 &&
    currentSha !== receipt.beforeSha256
  ) {
    const restored = replaceManagedLine({
      content: current,
      from: receipt.newLine,
      to: receipt.oldLine,
    });
    if (restored === null || sha256(restored) !== receipt.beforeSha256) {
      throw new Error("Restored dnsmasq bytes would not match the receipt");
    }
    await deps.replaceDnsmasq({ expected: current, next: restored });
  } else if (currentSha !== receipt.beforeSha256) {
    throw new Error("dnsmasq configuration changed since the repair");
  }
  const verified = await deps.readDnsmasq();
  if (verified === null || sha256(verified) !== receipt.beforeSha256) {
    throw new Error("Restored dnsmasq configuration hash does not match");
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
      if (!removed) {
        retainedResolver = receipt.resolverPath;
      }
    }
  }
  await opts.restart();
  await deps.flushDnsCache();
  return { retainedResolver };
}

function stamp(
  receipt: HackLocalRouteReceipt,
  patch: Partial<Pick<HackLocalRouteReceipt, "state" | "resolverIdentity">>,
  now: Date
): HackLocalRouteReceipt {
  return Object.freeze({ ...receipt, ...patch, updatedAt: now.toISOString() });
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
    `Native hack.local repair: ${changes.join(" and ")}? ${probe}the native relay listens on 127.0.0.1:${plan.relayPort}. This restarts dnsmasq. Undo: ${HACK_LOCAL_ROLLBACK_COMMAND}`
  );
  if (!approved) {
    return {
      outcome: "refused",
      reason: "declined",
      detail: "The hack.local repair was not authorized; nothing changed.",
    };
  }
  const restart = await deps.prepareRestart();
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
    let retained: string | null = null;
    try {
      ({ retainedResolver: retained } = await restoreFromReceipt({
        deps,
        receipt,
        restart,
      }));
      await deps.writeReceipt(
        stamp(receipt, { state: "rolled-back" }, deps.now())
      );
    } catch (cleanup) {
      throw new Error(
        `hack.local repair failed during ${phase}: ${errorMessage(cause)}; automatic restore failed (${errorMessage(cleanup)}). Recover with: ${HACK_LOCAL_ROLLBACK_COMMAND}`,
        { cause }
      );
    }
    throw new Error(
      `hack.local repair failed during ${phase}: ${errorMessage(cause)}; the earlier dnsmasq line was restored${
        retained
          ? `; ${retained} was retained because its ownership is unproven`
          : ""
      }.`,
      { cause }
    );
  }
}

/**
 * Restore the exact earlier line recorded by an applied or interrupted repair
 * and verify the whole-file hash. A file changed since the repair refuses.
 */
export async function rollbackHackLocalRoute(
  deps: HackLocalRouteDependencies
): Promise<HackLocalRouteRollbackResult> {
  const stored = await readReceipt(deps);
  if ("invalid" in stored) {
    return {
      outcome: "refused",
      reason: "invalid-receipt",
      detail: `${stored.invalid}; refusing to infer ownership of ${deps.paths.receiptPath}.`,
    };
  }
  const { receipt } = stored;
  if (!receipt || receipt.state === "rolled-back") {
    return {
      outcome: "refused",
      reason: "no-receipt",
      detail: `No applied or interrupted hack.local repair is recorded at ${deps.paths.receiptPath}; nothing to roll back.`,
    };
  }
  if (
    receipt.dnsmasqPath !== deps.paths.dnsmasqPath ||
    receipt.resolverPath !== deps.paths.resolverPath
  ) {
    return {
      outcome: "refused",
      reason: "rollback-drift",
      detail: `The receipt names ${receipt.dnsmasqPath}, not the current ${deps.paths.dnsmasqPath}.`,
    };
  }
  const current = await deps.readDnsmasq();
  const currentSha = current === null ? null : sha256(current);
  if (
    currentSha === null ||
    (currentSha !== receipt.afterSha256 && currentSha !== receipt.beforeSha256)
  ) {
    return {
      outcome: "refused",
      reason: "rollback-drift",
      detail: `${receipt.dnsmasqPath} changed since the repair (hash differs from the receipt); restore "${receipt.oldLine}" manually.`,
    };
  }
  if (!deps.canPrompt()) {
    return {
      outcome: "refused",
      reason: "non-interactive",
      detail: `Rollback needs interactive confirmation and a macOS administrator prompt. Run it in a terminal: ${HACK_LOCAL_ROLLBACK_COMMAND}`,
      command: HACK_LOCAL_ROLLBACK_COMMAND,
    };
  }
  const approved = await deps.authorize(
    `Restore "${receipt.oldLine}" in ${receipt.dnsmasqPath}${
      receipt.resolverAction === "create"
        ? ` and remove the ${receipt.resolverPath} this repair created`
        : ""
    }? This restarts dnsmasq.`
  );
  if (!approved) {
    return {
      outcome: "refused",
      reason: "declined",
      detail: "The hack.local rollback was not authorized; nothing changed.",
    };
  }
  const restart = await deps.prepareRestart();
  const again = await deps.readReceipt();
  const recheck = await deps.readDnsmasq();
  if (again !== stored.raw || recheck !== current) {
    return {
      outcome: "refused",
      reason: "inputs-changed",
      detail:
        "The receipt or dnsmasq configuration changed during authorization; nothing changed.",
    };
  }
  const { retainedResolver } = await restoreFromReceipt({
    deps,
    receipt,
    restart,
  });
  const rolledBack = stamp(receipt, { state: "rolled-back" }, deps.now());
  await deps.writeReceipt(rolledBack);
  return { outcome: "rolled-back", receipt: rolledBack, retainedResolver };
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
