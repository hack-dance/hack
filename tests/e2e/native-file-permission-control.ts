import { isRecord } from "../../src/lib/guards.ts";
import { adoptionDependencyReadAllowed } from "./scenarios/native-compose-adoption-dependency-inputs.ts";

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
