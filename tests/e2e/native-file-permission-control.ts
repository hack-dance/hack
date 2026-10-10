import { isRecord } from "../../src/lib/guards.ts";
import {
  type Checkout,
  parseLegacyComposeAdoptionReceipt,
} from "../../src/lib/native-compose-adoption-receipt.ts";
import { keys } from "../../src/lib/native-compose-private-state.ts";
import { adoptionDependencyReadAllowed } from "./scenarios/native-compose-adoption-dependency-inputs.ts";

function fixtureIdentity(value: unknown): boolean {
  return (
    isRecord(value) &&
    Number.isSafeInteger(value.dev) &&
    typeof value.dev === "number" &&
    value.dev >= 0 &&
    Number.isSafeInteger(value.ino) &&
    typeof value.ino === "number" &&
    value.ino > 0
  );
}
function fixtureSource(value: unknown): boolean {
  return (
    isRecord(value) &&
    keys(value, "dev,hash,ino") &&
    fixtureIdentity(value) &&
    typeof value.hash === "string" &&
    /^[a-f0-9]{64}$/.test(value.hash)
  );
}
function fixtureCheckout(value: unknown): value is Checkout {
  const directory = (entry: unknown) =>
    isRecord(entry) && keys(entry, "dev,ino") && fixtureIdentity(entry);
  if (
    !(
      isRecord(value) &&
      keys(value, "git,project,root") &&
      directory(value.root) &&
      directory(value.project)
    )
  ) {
    return false;
  }
  const git = value.git;
  return (
    directory(git) ||
    (isRecord(git) &&
      keys(git, "admin,backlink,common,commonLink,kind,marker,primary") &&
      git.kind === "linked-worktree" &&
      directory(git.admin) &&
      directory(git.common) &&
      directory(git.primary) &&
      fixtureSource(git.marker) &&
      fixtureSource(git.backlink) &&
      fixtureSource(git.commonLink))
  );
}
function cleanupRefused(): never {
  throw new Error(
    "Protected fixture cleanup selection refused; values omitted."
  );
}
function cleanupDownArgs(value: unknown): readonly string[] {
  if (!(isRecord(value) && fixtureCheckout(value.checkout))) {
    return cleanupRefused();
  }
  let receipt: ReturnType<typeof parseLegacyComposeAdoptionReceipt>;
  try {
    receipt = parseLegacyComposeAdoptionReceipt(value, value.checkout);
  } catch {
    return cleanupRefused();
  }
  if (
    !(
      receipt.adoption_receipt_version === 8 &&
      receipt.prepared !== null &&
      receipt.publication?.phase === "active"
    )
  ) {
    return cleanupRefused();
  }
  if (receipt.pendingOperation === null) {
    return Object.freeze(["down", "--json"]);
  }
  const pending = receipt.pendingOperation;
  if (
    !(
      pending.services.length === 3 &&
      [...pending.services].sort().join() === "db,reader,ungranted"
    )
  ) {
    return cleanupRefused();
  }
  return Object.freeze(["down", "--recover", "--json"]);
}

/** Select only the fixture's validated active file8 receipt and whole pending
 * selection. The production CLI still revalidates all receipt/effect authority. */
export async function nativeProtectedFileCleanupDown<T>(opts: {
  readonly receipt: unknown;
  readonly invoke: (args: readonly string[]) => Promise<T>;
}): Promise<T> {
  const invoke = opts.invoke;
  const args = cleanupDownArgs(opts.receipt);
  return await invoke(args);
}

/** Current material admission has a fixed redacted generation-state diagnostic. */
export function nativeProtectedFileStateRefused(value: unknown): boolean {
  if (
    !(isRecord(value) && Object.hasOwn(value, "ok")) ||
    value.ok !== false ||
    !Object.hasOwn(value, "error") ||
    !isRecord(value.error)
  ) {
    return false;
  }
  const error = value.error;
  return (
    Object.hasOwn(error, "code") &&
    error.code === "E_CONFIG_INVALID" &&
    Object.hasOwn(error, "message") &&
    error.message ===
      "Legacy adoption generation state is invalid, unsafe or changed; values omitted."
  );
}

/** Extend the existing closed metadata/config-hash owner only for fixed file proof queries. */
export function nativeProtectedFileReadAllowed(opts: {
  readonly args: readonly string[];
  readonly projectRoot: string;
  readonly project: string;
  readonly containerIds: readonly string[];
  readonly networkId: string;
  readonly volumeName: string;
  readonly generationId: string;
  readonly reader: string;
  readonly targets: readonly string[];
}): boolean {
  if (adoptionDependencyReadAllowed(opts)) {
    return true;
  }
  const target = opts.args.at(-1);
  if (
    typeof target !== "string" ||
    !opts.targets.includes(target) ||
    opts.args[0] !== "exec" ||
    opts.args[1] !== opts.reader ||
    !opts.containerIds.includes(opts.reader)
  ) {
    return false;
  }
  return (
    JSON.stringify(opts.args) ===
      JSON.stringify([
        "exec",
        opts.reader,
        "stat",
        "-c",
        "%d:%i:%u:%g:%s:%f:%a",
        "--",
        target,
      ]) ||
    JSON.stringify(opts.args) ===
      JSON.stringify(["exec", opts.reader, "sha256sum", "--", target])
  );
}
/** A refusal marker proves the original whole-ID start reached its real pending journal; it does no engine effect. */
export function nativeProtectedFileStartAllowed(opts: {
  readonly args: readonly string[];
  readonly ids: readonly string[];
  readonly prepared: unknown;
  readonly receipt: unknown;
}): boolean {
  const row = opts.receipt,
    pending = isRecord(row) ? row.pendingOperation : undefined,
    publication = isRecord(row) ? row.publication : undefined;
  return (
    opts.ids.length === 3 &&
    new Set(opts.ids).size === 3 &&
    opts.ids.every((id) => /^[a-f0-9]{64}$/.test(id)) &&
    opts.args[0] === "container" &&
    opts.args[1] === "start" &&
    opts.args.length === 5 &&
    new Set(opts.args.slice(2)).size === 3 &&
    opts.args.slice(2).every((id) => opts.ids.includes(id)) &&
    isRecord(row) &&
    row.adoption_receipt_version === 8 &&
    JSON.stringify(row.prepared) === JSON.stringify(opts.prepared) &&
    isRecord(publication) &&
    publication.phase === "active" &&
    JSON.stringify(publication.generation) === JSON.stringify(opts.prepared) &&
    isRecord(pending) &&
    pending.operation === "start" &&
    JSON.stringify(pending.generation) === JSON.stringify(opts.prepared) &&
    Array.isArray(pending.services) &&
    pending.services.length === 3 &&
    [...pending.services].sort().join() === "db,reader,ungranted"
  );
}

/** Only Darwin's canonical root-owned OS Git may have shared system hard links. Private copies remain single-link. */
export function nativeProtectedFileToolAllowed(opts: {
  readonly role: "artifact" | "git";
  readonly platform: string;
  readonly selected: string;
  readonly physical: string;
  readonly regular: boolean;
  readonly symlink: boolean;
  readonly uid: number;
  readonly mode: number;
  readonly nlink: number;
}): boolean {
  if (
    !(
      opts.regular &&
      !opts.symlink &&
      (opts.mode & 0o111) !== 0 &&
      Number.isSafeInteger(opts.nlink) &&
      opts.nlink > 0
    )
  ) {
    return false;
  }
  if (opts.nlink === 1) {
    return true;
  }
  return (
    opts.role === "git" &&
    opts.platform === "darwin" &&
    opts.selected === "/usr/bin/git" &&
    opts.physical === "/usr/bin/git" &&
    opts.uid === 0 &&
    (opts.mode & 0o022) === 0
  );
}
