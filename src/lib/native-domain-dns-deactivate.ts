import type {
  NativeDnsActivationInspection,
  NativeDnsOwnedFile,
} from "./native-domain-dns-activate.ts";
import { NativeDnsUncertainEffectError } from "./native-domain-dns-activate.ts";
import type { NativeDnsHostDependencies } from "./native-domain-dns-host.ts";
import type {
  NativeDnsPlan,
  NativeDnsReceipt,
} from "./native-domain-dns-plan.ts";

export type NativeDnsDeactivationPhase =
  | "inspection"
  | "authorization"
  | "drift"
  | "removing-receipt"
  | "resolver-remove"
  | "dnsmasq-remove"
  | "config-test"
  | "restart"
  | "flush"
  | "verification"
  | "inactive-receipt";

/** A removing receipt remains whenever deactivation or rollback cannot be proven. */
export class NativeDnsDeactivationError extends Error {
  readonly phase: NativeDnsDeactivationPhase;
  readonly rollbackUncertain: boolean;
  readonly rollbackFailures: readonly unknown[];
  readonly originalCause: unknown;

  constructor(opts: {
    readonly phase: NativeDnsDeactivationPhase;
    readonly cause: unknown;
    readonly rollbackFailures?: readonly unknown[];
  }) {
    const failures = opts.rollbackFailures ?? [];
    const uncertain =
      failures.length > 0 ||
      opts.cause instanceof NativeDnsUncertainEffectError;
    super(
      `Native DNS deactivation failed during ${opts.phase}${
        uncertain ? "; removing receipt requires explicit recovery" : ""
      }`,
      { cause: opts.cause }
    );
    this.name = "NativeDnsDeactivationError";
    this.phase = opts.phase;
    this.rollbackUncertain = uncertain;
    this.rollbackFailures = failures;
    this.originalCause = opts.cause;
  }
}

export interface NativeDnsDeactivationDependencies
  extends Pick<
    NativeDnsHostDependencies,
    | "inspectPlan"
    | "adoptReceipt"
    | "authorize"
    | "inspectOwnedFile"
    | "writeReceipt"
    | "removeIfOwned"
    | "createExclusive"
    | "testConfig"
    | "restartDnsmasq"
    | "flushDnsCache"
    | "verifyLiveDns"
    | "verifyDeactivatedDns"
  > {}

interface ActiveInspection {
  readonly inspection: NativeDnsActivationInspection;
  readonly receipt: NativeDnsOwnedFile;
  readonly dnsmasq: NativeDnsOwnedFile;
  readonly resolver: NativeDnsOwnedFile;
}

function receiptContent(receipt: NativeDnsReceipt): string {
  return `${JSON.stringify(receipt)}\n`;
}

async function inspectActive(
  deps: NativeDnsDeactivationDependencies,
  receiptPath: string,
  adoptReceipt: boolean
): Promise<ActiveInspection> {
  const inspection = await deps.inspectPlan();
  const plan = inspection.plan;
  if (inspection.fingerprint.length === 0 || plan.status !== "active") {
    throw new Error(
      "Native DNS deactivation requires a fingerprinted active claim"
    );
  }
  const [receipt, dnsmasq, resolver] = await Promise.all([
    adoptReceipt
      ? deps.adoptReceipt(plan.activeReceipt)
      : deps.inspectOwnedFile(receiptPath),
    deps.inspectOwnedFile(plan.dnsmasqPath),
    deps.inspectOwnedFile(plan.resolverPath),
  ]);
  if (
    !(receipt && dnsmasq && resolver) ||
    receipt.content !== receiptContent(plan.activeReceipt) ||
    dnsmasq.content !== plan.dnsmasqContent ||
    resolver.content !== plan.resolverContent
  ) {
    throw new Error(
      "Active DNS receipt or owned files changed before deactivation"
    );
  }
  return { inspection, receipt, dnsmasq, resolver };
}

function sameActive(left: ActiveInspection, right: ActiveInspection): boolean {
  const a = left.inspection.plan;
  const b = right.inspection.plan;
  return (
    left.inspection.fingerprint === right.inspection.fingerprint &&
    a.domain === b.domain &&
    a.dnsmasqPath === b.dnsmasqPath &&
    a.resolverPath === b.resolverPath &&
    a.parentAddress === b.parentAddress &&
    left.receipt.identity === right.receipt.identity &&
    left.dnsmasq.identity === right.dnsmasq.identity &&
    left.resolver.identity === right.resolver.identity
  );
}

async function restoreActive(opts: {
  readonly deps: NativeDnsDeactivationDependencies;
  readonly plan: NativeDnsPlan;
  readonly original: ActiveInspection;
  readonly removed: readonly NativeDnsOwnedFile[];
}): Promise<readonly unknown[]> {
  const { deps, plan } = opts;
  const failures: unknown[] = [];
  const expected = new Map<string, NativeDnsOwnedFile>([
    [opts.original.dnsmasq.path, opts.original.dnsmasq],
    [opts.original.resolver.path, opts.original.resolver],
  ]);
  for (const file of [...opts.removed].reverse()) {
    try {
      const created = await deps.createExclusive(file);
      if (
        created.path !== file.path ||
        created.content !== file.content ||
        created.identity.length === 0
      ) {
        throw new NativeDnsUncertainEffectError(
          `Restored DNS file has no valid ownership handle: ${file.path}`
        );
      }
      expected.set(file.path, created);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    return failures;
  }
  try {
    for (const [path, owned] of expected) {
      const current = await deps.inspectOwnedFile(path);
      if (
        current?.identity !== owned.identity ||
        current.content !== owned.content
      ) {
        throw new Error(
          `DNS file changed during deactivation rollback: ${path}`
        );
      }
    }
    await deps.testConfig();
    await deps.restartDnsmasq();
    await deps.flushDnsCache();
    await deps.verifyLiveDns(plan);
    await deps.writeReceipt(plan.activeReceipt);
  } catch (error) {
    failures.push(error);
  }
  return failures;
}

async function classifyFinalReceiptFailure(opts: {
  readonly deps: NativeDnsDeactivationDependencies;
  readonly receiptPath: string;
  readonly plan: NativeDnsPlan;
  readonly cause: unknown;
}): Promise<unknown> {
  try {
    const receipt = await opts.deps.inspectOwnedFile(opts.receiptPath);
    if (receipt?.content === receiptContent(opts.plan.removingReceipt)) {
      return opts.cause;
    }
    return new NativeDnsUncertainEffectError(
      receipt?.content === receiptContent(opts.plan.inactiveReceipt)
        ? "Inactive DNS receipt is readable but publication durability is unconfirmed"
        : "Final DNS receipt is neither removing nor inactive",
      opts.cause
    );
  } catch (inspectionError) {
    return new NativeDnsUncertainEffectError(
      "Final DNS receipt could not be inspected",
      inspectionError
    );
  }
}

/**
 * Rechecks active receipt and file identities across native authorization. A
 * removing receipt precedes conditional removal; verified fallback precedes the
 * durable inactive commit. Ordinary failures try to restore the active claim.
 */
export async function deactivateNativeDomainDns(opts: {
  readonly dependencies: NativeDnsDeactivationDependencies;
  readonly receiptPath: string;
}): Promise<NativeDnsReceipt> {
  const deps = opts.dependencies;
  let phase: NativeDnsDeactivationPhase = "inspection";
  let removingWritten = false;
  let inactiveAttempted = false;
  const removed: NativeDnsOwnedFile[] = [];
  let plan: NativeDnsPlan | undefined;
  let original: ActiveInspection | undefined;

  try {
    const before = await inspectActive(deps, opts.receiptPath, true);
    plan = before.inspection.plan;

    phase = "authorization";
    if (!(await deps.authorize(plan))) {
      throw new Error("Native DNS deactivation was denied");
    }

    phase = "drift";
    const after = await inspectActive(deps, opts.receiptPath, false);
    if (!sameActive(before, after)) {
      throw new Error(
        "Native DNS inputs or file identities changed during authorization"
      );
    }
    original = after;

    phase = "removing-receipt";
    await deps.writeReceipt(plan.removingReceipt);
    removingWritten = true;

    phase = "resolver-remove";
    if (!(await deps.removeIfOwned(after.resolver))) {
      throw new Error("Owned resolver changed before removal");
    }
    removed.push(after.resolver);

    phase = "dnsmasq-remove";
    if (!(await deps.removeIfOwned(after.dnsmasq))) {
      throw new Error("Owned dnsmasq claim changed before removal");
    }
    removed.push(after.dnsmasq);

    phase = "config-test";
    await deps.testConfig();
    phase = "restart";
    await deps.restartDnsmasq();
    phase = "flush";
    await deps.flushDnsCache();
    phase = "verification";
    await deps.verifyDeactivatedDns(plan);

    phase = "inactive-receipt";
    inactiveAttempted = true;
    await deps.writeReceipt(plan.inactiveReceipt);
    return plan.inactiveReceipt;
  } catch (cause) {
    const finalCause =
      inactiveAttempted && plan
        ? await classifyFinalReceiptFailure({
            deps,
            receiptPath: opts.receiptPath,
            plan,
            cause,
          })
        : cause;
    const rollbackFailures =
      removingWritten &&
      plan &&
      original &&
      !(finalCause instanceof NativeDnsUncertainEffectError)
        ? await restoreActive({ deps, plan, original, removed })
        : [];
    throw new NativeDnsDeactivationError({
      phase,
      cause: finalCause,
      rollbackFailures,
    });
  }
}
