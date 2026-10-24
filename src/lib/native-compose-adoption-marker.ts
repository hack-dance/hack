import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HackCliError } from "./cli-result.ts";
import { isRecord } from "./guards.ts";
import { acquireLegacyComposeAdoptionCheckout } from "./native-compose-adoption-checkout.ts";
import { parseLegacyComposeAdoptionReceipt } from "./native-compose-adoption-receipt.ts";
import {
  type HeldDirectory,
  hasCode,
  holdDirectory,
  readPrivate,
  recheckDirectories,
  sameFile,
} from "./native-compose-private-state.ts";
import { parseImportDocument } from "./native-config-import-parser.ts";

export type LegacyComposeAdoptionSelection =
  | "prepared"
  | "active"
  | "pending"
  | "rolled-back";
/**
 * Fixed, value-free messages of {@link LegacyComposeAdoptionSelectionError}.
 * `permission` is a `.hack` (or a directory inside it) the user cannot search,
 * for example mode 0644; it is reported as `E_PERMISSION`.
 */
export const LEGACY_ADOPTION_SELECTION_MESSAGES = {
  adoption:
    "Legacy adoption selection is unsafe or interrupted. Use explicit adoption recovery; values omitted.",
  "input-access":
    "Cannot inspect Hack project inputs. Check filesystem permissions and paths before retrying. Values omitted.",
  permission:
    "Cannot inspect Hack project inputs: permission denied on .hack or a directory inside it. Make .hack readable and searchable by your user (for example chmod u+rwx .hack), then retry. Values omitted.",
} as const;
/** Private owner markers fence upgraded discovery without parsing authored inputs or contacting an engine. */
export class LegacyComposeAdoptionSelectionError extends HackCliError {
  /** Which refusal this is, so readers can classify it without its message. */
  readonly kind: keyof typeof LEGACY_ADOPTION_SELECTION_MESSAGES;

  constructor(
    kind: keyof typeof LEGACY_ADOPTION_SELECTION_MESSAGES = "adoption"
  ) {
    super({
      code: kind === "permission" ? "E_PERMISSION" : "E_CONFIG_INVALID",
      message: LEGACY_ADOPTION_SELECTION_MESSAGES[kind],
    });
    this.name = "LegacyComposeAdoptionSelectionError";
    this.kind = kind;
  }
}
function refuse(): never {
  throw new LegacyComposeAdoptionSelectionError();
}
/**
 * What a `pending` selection waits on, which decides the only command that
 * moves it on:
 * - `switch`: a journaled publication switch or rollback. `hack config adopt
 *   --recover` completes it and `--recover --rollback` restores the originals.
 * - `preparation-stop`: an interrupted `hack config adopt --stop` before
 *   publication. Only `hack config adopt --recover --stop` retries it.
 * - `retained-operation`: an interrupted retained-container command of an
 *   active adoption. Only `hack down --recover` settles it.
 * A receipt never holds a pending operation and a pending switch together.
 */
export type LegacyComposeAdoptionPending =
  | "switch"
  | "preparation-stop"
  | "retained-operation";

/** A selection status with what a pending one waits on. */
export type LegacyComposeAdoptionSelectionDetail = {
  readonly status: LegacyComposeAdoptionSelection;
  /** Null unless `status` is `pending`. */
  readonly pending: LegacyComposeAdoptionPending | null;
};

function classify(
  value: unknown,
  checkout: Parameters<typeof parseLegacyComposeAdoptionReceipt>[1]
): LegacyComposeAdoptionSelectionDetail {
  const state = parseLegacyComposeAdoptionReceipt(value, checkout);
  if (state.pendingOperation !== null) {
    // The receipt parser admits a pending operation only over an active
    // publication (a retained command) or before one (a preparation stop).
    return {
      status: "pending",
      pending:
        state.publication?.phase === "active"
          ? "retained-operation"
          : "preparation-stop",
    };
  }
  if (state.publication === null) {
    return { status: "prepared", pending: null };
  }
  switch (state.publication.phase) {
    case "switching":
    case "rolling-back":
      return { status: "pending", pending: "switch" };
    case "active":
      return { status: "active", pending: null };
    case "rolled-back":
      return { status: "rolled-back", pending: null };
    default:
      refuse();
  }
}

type StateRootFailure = "input-access" | "permission";

/**
 * Why the adoption state root could not be inspected, when the cause is the
 * user's filesystem rather than the adoption: a non-directory ancestor is an
 * input access failure (never absence or permission to search an ancestor
 * project), and a directory on the way that cannot be searched (for example a
 * `.hack` at mode 0644) is a permission problem. Null keeps the adoption
 * refusal.
 */
function classifyStateRootFailure(error: unknown): StateRootFailure | null {
  if (hasCode(error, "ENOTDIR")) {
    return "input-access";
  }
  if (hasCode(error, "EACCES") || hasCode(error, "EPERM")) {
    return "permission";
  }
  return null;
}

/** JSON-safe status only. Full receipt, candidate and engine admission remain owned by the adopted generation store. */
export async function inspectLegacyComposeAdoptionSelection(opts: {
  readonly projectRoot: string;
}): Promise<LegacyComposeAdoptionSelection | null> {
  return (
    (await inspectLegacyComposeAdoptionSelectionDetail(opts))?.status ?? null
  );
}

/**
 * {@link inspectLegacyComposeAdoptionSelection} plus what a pending selection
 * waits on, for callers that name a recovery command. Same reads, refusals
 * and value-free result.
 */
export async function inspectLegacyComposeAdoptionSelectionDetail(opts: {
  readonly projectRoot: string;
}): Promise<LegacyComposeAdoptionSelectionDetail | null> {
  const directories: HeldDirectory[] = [];
  let stateRootFailure: StateRootFailure | null = null;
  try {
    if (
      !isRecord(opts) ||
      typeof opts.projectRoot !== "string" ||
      !opts.projectRoot.length ||
      opts.projectRoot.includes("\0")
    ) {
      refuse();
    }
    const root = resolve(opts.projectRoot),
      stateRoot = join(root, ".hack/.internal/legacy-compose-adoption-v1"),
      receiptPath = join(stateRoot, "receipt.json");
    try {
      await lstat(stateRoot);
    } catch (error: unknown) {
      if (hasCode(error, "ENOENT")) {
        return null;
      }
      stateRootFailure = classifyStateRootFailure(error);
      throw error;
    }
    for (const path of [
      root,
      join(root, ".hack"),
      join(root, ".hack/.internal"),
      stateRoot,
    ]) {
      directories.push(await holdDirectory(path, path === stateRoot));
    }
    const gitCheckout = await acquireLegacyComposeAdoptionCheckout({
      projectRoot: root,
    });
    directories.push(...gitCheckout.directories);
    const [rootDirectory, projectDirectory] = directories;
    if (!(rootDirectory && projectDirectory)) {
      refuse();
    }
    const saved = await readPrivate(receiptPath, 64 * 1024),
      parsed = parseImportDocument({ text: saved.text, document: "config" });
    const detail = classify(parsed.value, {
      root: { dev: rootDirectory.info.dev, ino: rootDirectory.info.ino },
      project: {
        dev: projectDirectory.info.dev,
        ino: projectDirectory.info.ino,
      },
      git: gitCheckout.identity,
    });
    await recheckDirectories(directories);
    await gitCheckout.assertFresh();
    const current = await readPrivate(receiptPath, 64 * 1024);
    if (!sameFile(saved.info, current.info) || saved.text !== current.text) {
      refuse();
    }
    return detail;
  } catch {
    if (stateRootFailure !== null) {
      throw new LegacyComposeAdoptionSelectionError(stateRootFailure);
    }
    refuse();
  } finally {
    await Promise.all(directories.map((held) => held.file.close()));
  }
}

export async function assertLegacyComposeAdoptionSelectionStable(opts: {
  readonly projectRoot: string;
}) {
  const status = await inspectLegacyComposeAdoptionSelection(opts);
  if (status === "pending") {
    refuse();
  }
  return status;
}
