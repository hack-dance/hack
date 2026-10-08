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
/** Private owner markers fence upgraded discovery without parsing authored inputs or contacting an engine. */
export class LegacyComposeAdoptionSelectionError extends HackCliError {
  constructor(kind: "adoption" | "input-access" = "adoption") {
    super({
      code: "E_CONFIG_INVALID",
      message:
        kind === "input-access"
          ? "Cannot inspect Hack project inputs. Check filesystem permissions and paths before retrying. Values omitted."
          : "Legacy adoption selection is unsafe or interrupted. Use explicit adoption recovery; values omitted.",
    });
    this.name = "LegacyComposeAdoptionSelectionError";
  }
}
function refuse(): never {
  throw new LegacyComposeAdoptionSelectionError();
}
function classify(
  value: unknown,
  checkout: Parameters<typeof parseLegacyComposeAdoptionReceipt>[1]
): LegacyComposeAdoptionSelection {
  const state = parseLegacyComposeAdoptionReceipt(value, checkout);
  if (state.pendingOperation !== null) {
    return "pending";
  }
  if (state.publication === null) {
    return "prepared";
  }
  switch (state.publication.phase) {
    case "switching":
    case "rolling-back":
      return "pending";
    case "active":
      return "active";
    case "rolled-back":
      return "rolled-back";
    default:
      refuse();
  }
}

/** JSON-safe status only. Full receipt, candidate and engine admission remain owned by the adopted generation store. */
export async function inspectLegacyComposeAdoptionSelection(opts: {
  readonly projectRoot: string;
}): Promise<LegacyComposeAdoptionSelection | null> {
  const directories: HeldDirectory[] = [];
  let inputAccessFailure = false;
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
      // A non-directory ancestor is an input access failure, never absence or
      // permission to search an ancestor project. Preserve the selector refusal.
      if (hasCode(error, "ENOTDIR")) {
        inputAccessFailure = true;
      }
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
    const status = classify(parsed.value, {
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
    return status;
  } catch {
    if (inputAccessFailure) {
      throw new LegacyComposeAdoptionSelectionError("input-access");
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
