import { isRecord } from "./guards.ts";
import type { LinkedAdoptionGitIdentity } from "./native-compose-adoption-checkout.ts";
import { keys } from "./native-compose-private-state.ts";

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
  readonly adoption_receipt_version: 1 | 2 | 3 | 4 | 5 | 8;
  readonly kind: typeof KIND;
  readonly checkout: Checkout;
  readonly prepared: Anchor | null;
  readonly publication: Publication | null;
  readonly pendingOperation: PendingOperation | null;
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
        "adoption_receipt_version,checkout,kind,pendingOperation,prepared,publication"
      ) &&
      (value.adoption_receipt_version === 8 ||
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
      version === 8 || version === 5 || version === 4 || version === 3
        ? version
        : legacyVersion,
    kind: KIND,
    checkout,
    prepared: value.prepared,
    publication: value.publication,
    pendingOperation: value.pendingOperation,
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
