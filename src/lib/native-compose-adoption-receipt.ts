import { isRecord } from "./guards.ts";
import type { LinkedAdoptionGitIdentity } from "./native-compose-adoption-checkout.ts";
import { keys } from "./native-compose-private-state.ts";
import {
  type NativeComposeRouteReference,
  parseNativeComposeRouteReference,
} from "./native-compose-route-claims.ts";

const KIND = "legacy-compose-adopted";
const TOKEN = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
function refuse(): never {
  throw new Error("Legacy adoption receipt is invalid; values omitted.");
}
export type FileIdentity = { readonly dev: number; readonly ino: number };
export type Artifact = FileIdentity & { readonly hash: string };
export type Checkout = {
  readonly root: FileIdentity;
  readonly project: FileIdentity;
  readonly git: FileIdentity | LinkedAdoptionGitIdentity;
};
export type Anchor = { readonly id: string; readonly manifest: Artifact };
export type Receipt = {
  readonly adoption_receipt_version:
    | 1
    | 2
    | 3
    | 4
    | 5
    | 6
    | 7
    | 9
    | 10
    | 11
    | 14;
  readonly kind: typeof KIND;
  readonly checkout: Checkout;
  readonly prepared: Anchor | null;
  readonly publication: Publication | null;
  readonly pendingOperation: PendingOperation | null;
  /** Required only by v14. Unknown child disposition survives stop containment. */
  readonly routingOperation?: RetainedRoutingOperation | null;
  /** Required only by v14; releasing is an interrupted rollback handoff,
   * never active workload or publisher admission. */
  readonly routingHandoff?: "held" | "releasing";
};
export type RetainedRoutingOperation = {
  readonly generation: Anchor;
  readonly token: string;
  readonly reference: NativeComposeRouteReference;
  readonly disposition: "prospective" | "settled";
  readonly code: number | null;
};
export type AdoptionOperation = "start" | "restart" | "stop";
export type PendingOperation = {
  readonly generation: Anchor;
  readonly operation: AdoptionOperation;
  readonly services: readonly string[];
};
export type Publication = {
  readonly generation: Anchor;
  readonly phase: "switching" | "active" | "rolling-back" | "rolled-back";
  readonly native: Artifact | null;
};

function identity(
  value: unknown
): value is FileIdentity & Record<string, unknown> {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.dev) &&
    Number.isSafeInteger(value.ino) &&
    Number(value.dev) >= 0 &&
    Number(value.ino) > 0
  );
}
function artifact(value: unknown): value is Artifact {
  return (
    identity(value) &&
    keys(value, "dev,hash,ino") &&
    typeof value.hash === "string" &&
    HASH.test(value.hash)
  );
}
function anchor(value: unknown): value is Anchor {
  return (
    isRecord(value) &&
    keys(value, "id,manifest") &&
    typeof value.id === "string" &&
    TOKEN.test(value.id) &&
    artifact(value.manifest)
  );
}

/** Strict shared private wire contract for discovery and the mutation owner. */
export function parseLegacyComposeAdoptionReceipt(
  value: unknown,
  checkout: Checkout
): Receipt {
  if (
    !(
      isRecord(value) &&
      keys(
        value,
        value.adoption_receipt_version === 14
          ? "adoption_receipt_version,checkout,kind,pendingOperation,prepared,publication,routingHandoff,routingOperation"
          : "adoption_receipt_version,checkout,kind,pendingOperation,prepared,publication"
      ) &&
      (value.adoption_receipt_version === 14 ||
        value.adoption_receipt_version === 11 ||
        value.adoption_receipt_version === 10 ||
        value.adoption_receipt_version === 9 ||
        value.adoption_receipt_version === 7 ||
        value.adoption_receipt_version === 6 ||
        value.adoption_receipt_version === 5 ||
        value.adoption_receipt_version === 4 ||
        value.adoption_receipt_version === 3 ||
        value.adoption_receipt_version === ("kind" in checkout.git ? 2 : 1)) &&
      value.kind === KIND &&
      JSON.stringify(value.checkout) === JSON.stringify(checkout) &&
      (value.prepared === null || anchor(value.prepared)) &&
      (value.publication === null || publication(value.publication)) &&
      (value.pendingOperation === null ||
        pendingOperation(value.pendingOperation))
    )
  ) {
    refuse();
  }
  let routingOperation: RetainedRoutingOperation | null | undefined;
  if (value.adoption_receipt_version === 14) {
    if (
      value.prepared === null ||
      (value.routingHandoff !== "held" && value.routingHandoff !== "releasing")
    ) {
      refuse();
    }
    if (
      value.routingHandoff === "releasing" &&
      (value.pendingOperation !== null ||
        !value.publication ||
        !["rolling-back", "rolled-back"].includes(value.publication.phase))
    ) {
      refuse();
    }
    const operation = value.routingOperation;
    if (operation === null) {
      routingOperation = null;
    } else {
      if (
        !(
          isRecord(operation) &&
          keys(operation, "code,disposition,generation,reference,token") &&
          anchor(operation.generation) &&
          typeof operation.token === "string" &&
          TOKEN.test(operation.token) &&
          (operation.disposition === "prospective"
            ? operation.code === null
            : operation.disposition === "settled" &&
              Number.isSafeInteger(operation.code) &&
              typeof operation.code === "number" &&
              operation.code >= 0 &&
              operation.code <= 255) &&
          JSON.stringify(operation.generation) ===
            JSON.stringify(value.prepared)
        )
      ) {
        refuse();
      }
      routingOperation = {
        generation: operation.generation,
        token: operation.token,
        reference: parseNativeComposeRouteReference(operation.reference),
        disposition:
          operation.disposition === "prospective" ? "prospective" : "settled",
        code: typeof operation.code === "number" ? operation.code : null,
      };
      if (
        routingOperation.reference.generationIdentity !==
          operation.generation.id ||
        (routingOperation.disposition === "prospective" &&
          value.pendingOperation === null)
      ) {
        refuse();
      }
    }
    if (value.pendingOperation !== null && routingOperation === null) {
      refuse();
    }
  }
  // The distinct job family is issued with a prepared generation, never a bare version upgrade.
  if (value.adoption_receipt_version === 7 && value.prepared === null) {
    refuse();
  }
  if (
    value.publication &&
    JSON.stringify(value.publication.generation) !==
      JSON.stringify(value.prepared)
  ) {
    refuse();
  }
  if (
    value.pendingOperation !== null &&
    !pendingSelectionMatches({
      prepared: value.prepared,
      publication: value.publication,
      pendingOperation: value.pendingOperation,
    })
  ) {
    refuse();
  }
  const legacyVersion = "kind" in checkout.git ? 2 : 1;
  const version = value.adoption_receipt_version;
  return {
    adoption_receipt_version:
      version === 14 ||
      version === 11 ||
      version === 10 ||
      version === 9 ||
      version === 7 ||
      version === 6 ||
      version === 5 ||
      version === 4 ||
      version === 3
        ? version
        : legacyVersion,
    kind: KIND,
    checkout,
    prepared: value.prepared,
    publication: value.publication,
    pendingOperation: value.pendingOperation,
    ...(version === 14
      ? {
          routingOperation: routingOperation ?? null,
          routingHandoff:
            value.routingHandoff === "held"
              ? ("held" as const)
              : ("releasing" as const),
        }
      : {}),
  };
}
function pendingSelectionMatches(
  value: Pick<Receipt, "publication" | "pendingOperation" | "prepared">
) {
  if (!value.pendingOperation) {
    return false;
  }
  if (value.publication?.phase === "active") {
    return (
      JSON.stringify(value.pendingOperation.generation) ===
      JSON.stringify(value.publication.generation)
    );
  }
  return (
    (value.publication === null || value.publication.phase === "rolled-back") &&
    value.pendingOperation.operation === "stop" &&
    JSON.stringify(value.pendingOperation.generation) ===
      JSON.stringify(value.prepared)
  );
}
function pendingOperation(value: unknown): value is PendingOperation {
  return (
    isRecord(value) &&
    keys(value, "generation,operation,services") &&
    anchor(value.generation) &&
    typeof value.operation === "string" &&
    ["start", "restart", "stop"].includes(value.operation) &&
    Array.isArray(value.services) &&
    value.services.length > 0 &&
    value.services.length <= 1024 &&
    value.services.every(
      (service) =>
        typeof service === "string" &&
        service.length > 0 &&
        service.length <= 128
    ) &&
    new Set(value.services).size === value.services.length
  );
}
function publication(value: unknown): value is Publication {
  return (
    isRecord(value) &&
    keys(value, "generation,native,phase") &&
    anchor(value.generation) &&
    typeof value.phase === "string" &&
    ["switching", "active", "rolling-back", "rolled-back"].includes(
      value.phase
    ) &&
    (value.native === null || artifact(value.native)) &&
    (value.phase !== "active" || value.native !== null)
  );
}
