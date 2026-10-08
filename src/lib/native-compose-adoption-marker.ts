import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HackCliError } from "./cli-result.ts";
import { isRecord } from "./guards.ts";
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
  constructor() {
    super({
      code: "E_CONFIG_INVALID",
      message:
        "Legacy adoption selection is unsafe or interrupted. Use explicit adoption recovery; values omitted.",
    });
    this.name = "LegacyComposeAdoptionSelectionError";
  }
}
function refuse(): never {
  throw new LegacyComposeAdoptionSelectionError();
}
function classify(
  value: unknown,
  directories: readonly HeldDirectory[]
): LegacyComposeAdoptionSelection {
  const [root, project, git] = directories;
  if (!(root && project && git)) {
    refuse();
  }
  const state = parseLegacyComposeAdoptionReceipt(value, {
    root: { dev: root.info.dev, ino: root.info.ino },
    project: { dev: project.info.dev, ino: project.info.ino },
    git: { dev: git.info.dev, ino: git.info.ino },
  });
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
      throw error;
    }
    for (const path of [
      root,
      join(root, ".hack"),
      join(root, ".git"),
      join(root, ".hack/.internal"),
      stateRoot,
    ]) {
      directories.push(await holdDirectory(path, path === stateRoot));
    }
    const saved = await readPrivate(receiptPath, 64 * 1024),
      parsed = parseImportDocument({ text: saved.text, document: "config" });
    const status = classify(parsed.value, directories);
    await recheckDirectories(directories);
    const current = await readPrivate(receiptPath, 64 * 1024);
    if (!sameFile(saved.info, current.info) || saved.text !== current.text) {
      refuse();
    }
    return status;
  } catch {
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
