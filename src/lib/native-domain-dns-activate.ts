import type {
  NativeDnsPlan,
  NativeDnsReceipt,
} from "./native-domain-dns-plan.ts";

/** A fresh plan and a digest of every bounded input used to produce it. */
export interface NativeDnsActivationInspection {
  readonly plan: NativeDnsPlan;
  readonly fingerprint: string;
}

/**
 * Returned only after an exclusive create. The adapter must bind identity to the
 * created file and check both identity and content before conditional removal.
 */
export interface NativeDnsOwnedFile {
  readonly path: string;
  readonly content: string;
  readonly identity: string;
}

/** All host effects and authorization are supplied by the caller. */
export interface NativeDnsActivationDependencies {
  readonly inspectPlan: () => Promise<NativeDnsActivationInspection>;
  readonly authorize: (plan: NativeDnsPlan) => Promise<boolean>;
  /** Atomically and durably publish a private receipt. */
  readonly writeReceipt: (receipt: NativeDnsReceipt) => Promise<void>;
  /** Conditionally clear exactly this pending receipt. */
  readonly clearPendingReceipt: (receipt: NativeDnsReceipt) => Promise<boolean>;
  /** No clobber; throw NativeDnsUncertainEffectError if creation may have succeeded without a handle. */
  readonly createExclusive: (file: {
    readonly path: string;
    readonly content: string;
  }) => Promise<NativeDnsOwnedFile>;
  /** Return false if identity or content no longer matches. */
  readonly removeIfOwned: (file: NativeDnsOwnedFile) => Promise<boolean>;
  readonly testConfig: () => Promise<void>;
  readonly restartDnsmasq: () => Promise<void>;
  readonly flushDnsCache: () => Promise<void>;
  readonly verifyLiveDns: (plan: NativeDnsPlan) => Promise<void>;
}

export type NativeDnsActivationPhase =
  | "inspection"
  | "authorization"
  | "drift"
  | "pending-receipt"
  | "dnsmasq-create"
  | "resolver-create"
  | "config-test"
  | "restart"
  | "flush"
  | "verification"
  | "active-receipt";

/** An effect may have happened, but its ownership or completion is unconfirmed. */
export class NativeDnsUncertainEffectError extends Error {
  readonly originalCause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "NativeDnsUncertainEffectError";
    this.originalCause = cause;
  }
}

/** An uncertain rollback leaves the pending receipt for explicit recovery. */
export class NativeDnsActivationError extends Error {
  readonly phase: NativeDnsActivationPhase;
  readonly rollbackUncertain: boolean;
  readonly rollbackFailures: readonly unknown[];
  readonly originalCause: unknown;

  constructor(opts: {
    readonly phase: NativeDnsActivationPhase;
    readonly cause: unknown;
    readonly rollbackFailures?: readonly unknown[];
  }) {
    const failures = opts.rollbackFailures ?? [];
    const uncertain =
      failures.length > 0 ||
      opts.cause instanceof NativeDnsUncertainEffectError;
    super(
      `Native DNS activation failed during ${opts.phase}${
        uncertain ? "; rollback requires explicit recovery" : ""
      }`
    );
    this.name = "NativeDnsActivationError";
    this.phase = opts.phase;
    this.rollbackUncertain = uncertain;
    this.rollbackFailures = failures;
    this.originalCause = opts.cause;
  }
}

function sameReceipt(left: NativeDnsReceipt, right: NativeDnsReceipt): boolean {
  return (
    left.version === right.version &&
    left.state === right.state &&
    left.domain === right.domain &&
    left.dnsmasqPath === right.dnsmasqPath &&
    left.resolverPath === right.resolverPath &&
    left.dnsmasqSha256 === right.dnsmasqSha256 &&
    left.resolverSha256 === right.resolverSha256
  );
}

function sameInspection(
  left: NativeDnsActivationInspection,
  right: NativeDnsActivationInspection
): boolean {
  const a = left.plan;
  const b = right.plan;
  return (
    left.fingerprint.length > 0 &&
    left.fingerprint === right.fingerprint &&
    a.status === "available" &&
    b.status === "available" &&
    a.domain === b.domain &&
    a.dnsmasqPath === b.dnsmasqPath &&
    a.resolverPath === b.resolverPath &&
    a.dnsmasqContent === b.dnsmasqContent &&
    a.resolverContent === b.resolverContent &&
    sameReceipt(a.pendingReceipt, b.pendingReceipt) &&
    sameReceipt(a.activeReceipt, b.activeReceipt)
  );
}

function assertOwnedFile(
  actual: NativeDnsOwnedFile,
  expected: { readonly path: string; readonly content: string }
): void {
  if (
    actual.path !== expected.path ||
    actual.content !== expected.content ||
    actual.identity.length === 0
  ) {
    throw new Error("Exclusive create returned an invalid ownership handle");
  }
}

async function rollbackActivation(opts: {
  readonly dependencies: NativeDnsActivationDependencies;
  readonly plan: NativeDnsPlan;
  readonly ownedFiles: readonly NativeDnsOwnedFile[];
  readonly serviceTouched: boolean;
  readonly activeReceiptAttempted: boolean;
  readonly preservePending: boolean;
}): Promise<readonly unknown[]> {
  const { dependencies: deps, plan } = opts;
  const failures: unknown[] = [];
  if (opts.activeReceiptAttempted) {
    try {
      await deps.writeReceipt(plan.pendingReceipt);
    } catch (error) {
      failures.push(error);
    }
  }

  // Keep verified files if an ambiguous active write cannot be made pending again.
  if (failures.length > 0) {
    return failures;
  }
  for (const file of [...opts.ownedFiles].reverse()) {
    try {
      if (!(await deps.removeIfOwned(file))) {
        failures.push(
          new Error(`Owned DNS file changed before rollback: ${file.path}`)
        );
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (opts.serviceTouched) {
    try {
      await deps.restartDnsmasq();
      await deps.flushDnsCache();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 0 && !opts.preservePending) {
    try {
      if (!(await deps.clearPendingReceipt(plan.pendingReceipt))) {
        failures.push(new Error("Pending receipt changed before cleanup"));
      }
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

/**
 * Rechecks a read-only plan across authorization, then commits a pending receipt
 * before file effects. A failed effect removes only confirmed owned files in
 * reverse order. Any uncertain cleanup retains the pending receipt.
 */
export async function activateNativeDomainDns(opts: {
  readonly dependencies: NativeDnsActivationDependencies;
}): Promise<NativeDnsReceipt> {
  const deps = opts.dependencies;
  let phase: NativeDnsActivationPhase = "inspection";
  let pendingWritten = false;
  let serviceTouched = false;
  let activeReceiptAttempted = false;
  const ownedFiles: NativeDnsOwnedFile[] = [];
  let plan: NativeDnsPlan | undefined;

  try {
    const before = await deps.inspectPlan();
    plan = before.plan;
    if (plan.status !== "available" || before.fingerprint.length === 0) {
      throw new Error(
        "Native DNS activation requires an available, fingerprinted plan"
      );
    }

    phase = "authorization";
    if (!(await deps.authorize(plan))) {
      throw new Error("Native DNS activation was denied");
    }

    phase = "drift";
    const after = await deps.inspectPlan();
    if (!sameInspection(before, after)) {
      throw new Error("Native DNS inputs or plan changed during authorization");
    }

    phase = "pending-receipt";
    await deps.writeReceipt(plan.pendingReceipt);
    pendingWritten = true;

    phase = "dnsmasq-create";
    const dnsmasq = {
      path: plan.dnsmasqPath,
      content: plan.dnsmasqContent,
    };
    const ownedDnsmasq = await deps.createExclusive(dnsmasq);
    ownedFiles.push(ownedDnsmasq);
    assertOwnedFile(ownedDnsmasq, dnsmasq);

    phase = "resolver-create";
    const resolver = {
      path: plan.resolverPath,
      content: plan.resolverContent,
    };
    const ownedResolver = await deps.createExclusive(resolver);
    ownedFiles.push(ownedResolver);
    assertOwnedFile(ownedResolver, resolver);

    phase = "config-test";
    await deps.testConfig();
    phase = "restart";
    serviceTouched = true;
    await deps.restartDnsmasq();
    phase = "flush";
    await deps.flushDnsCache();
    phase = "verification";
    await deps.verifyLiveDns(plan);

    phase = "active-receipt";
    activeReceiptAttempted = true;
    await deps.writeReceipt(plan.activeReceipt);
    return plan.activeReceipt;
  } catch (cause) {
    const rollbackFailures =
      pendingWritten && plan
        ? await rollbackActivation({
            dependencies: deps,
            plan,
            ownedFiles,
            serviceTouched,
            activeReceiptAttempted,
            preservePending: cause instanceof NativeDnsUncertainEffectError,
          })
        : [];
    throw new NativeDnsActivationError({ phase, cause, rollbackFailures });
  }
}
