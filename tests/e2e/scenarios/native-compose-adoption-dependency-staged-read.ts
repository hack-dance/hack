import { lstat, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isRecord } from "../../../src/lib/guards.ts";
import {
  type HeldDirectory,
  hasCode,
  holdDirectory,
  keys,
  readPrivate,
  recheckDirectories,
  sameFile,
} from "../../../src/lib/native-compose-private-state.ts";
import { NATIVE_CONFIG_INPUT_LIMIT } from "../../../src/lib/native-config-compiler.ts";
import { readNativeConfigImportSourceFile } from "../../../src/lib/native-config-import-inputs.ts";
import { adoptionDependencyReadAllowed } from "./native-compose-adoption-dependency-inputs.ts";

type Identity = { readonly dev: number; readonly ino: number };
/** Private synthetic fixture input. Never include this captured source in a report or diagnostic. */
export type AdoptionDependencyFirstPrepare = {
  readonly projectRoot: string;
  readonly root: Identity;
  readonly project: Identity;
  readonly source: {
    readonly text: string;
    readonly dev: number;
    readonly ino: number;
    readonly size: number;
    readonly mode: number;
    readonly uid: number;
    readonly nlink: number;
    readonly mtimeMs: number;
    readonly ctimeMs: number;
  };
};
const TOKEN = /^[a-f0-9]{32}$/;
const STATE_PARTS = [".hack", ".internal", "legacy-compose-adoption-v1"];

async function absent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return false;
  } catch (error: unknown) {
    return hasCode(error, "ENOENT");
  }
}
async function close(directories: readonly HeldDirectory[]) {
  for (const held of directories.toReversed()) {
    await held.file.close();
  }
}

/** Capture before first preparation; an existing store (including an orphan stage) is never first-prepare authority. */
export async function captureAdoptionDependencyFirstPrepare(opts: {
  readonly projectRoot: string;
}): Promise<AdoptionDependencyFirstPrepare> {
  const held: HeldDirectory[] = [];
  try {
    const projectRoot = resolve(opts.projectRoot);
    held.push(await holdDirectory(projectRoot, false));
    held.push(await holdDirectory(join(projectRoot, ".hack"), false));
    const root = held[0]?.info,
      project = held[1]?.info;
    if (
      !(root && project && (await absent(join(projectRoot, ...STATE_PARTS))))
    ) {
      throw new Error("First preparation requires an absent store.");
    }
    const source = await readNativeConfigImportSourceFile({
      path: join(projectRoot, ".hack/docker-compose.yml"),
    });
    if (
      source.info.uid !== process.getuid?.() ||
      (source.info.mode & 0o022) !== 0
    ) {
      throw new Error("First preparation requires owned safe source input.");
    }
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(source.bytes);
    await recheckDirectories(held);
    if (!(await absent(join(projectRoot, ...STATE_PARTS)))) {
      throw new Error("First preparation store changed during capture.");
    }
    return Object.freeze({
      projectRoot,
      root: Object.freeze({ dev: root.dev, ino: root.ino }),
      project: Object.freeze({ dev: project.dev, ino: project.ino }),
      source: Object.freeze({
        text,
        dev: source.info.dev,
        ino: source.info.ino,
        size: source.info.size,
        mode: source.info.mode,
        uid: source.info.uid,
        nlink: source.info.nlink,
        mtimeMs: source.info.mtimeMs,
        ctimeMs: source.info.ctimeMs,
      }),
    });
  } catch {
    throw new Error(
      "Adoption dependency fixture first-prepare capture refused; values omitted."
    );
  } finally {
    await close(held);
  }
}

function emptyReceipt(
  value: unknown,
  first: AdoptionDependencyFirstPrepare
): boolean {
  return (
    isRecord(value) &&
    keys(
      value,
      "adoption_receipt_version,checkout,kind,pendingOperation,prepared,publication"
    ) &&
    (value.adoption_receipt_version === 1 ||
      value.adoption_receipt_version === 2) &&
    value.kind === "legacy-compose-adopted" &&
    value.prepared === null &&
    value.publication === null &&
    value.pendingOperation === null &&
    isRecord(value.checkout) &&
    isRecord(value.checkout.root) &&
    value.checkout.root.dev === first.root.dev &&
    value.checkout.root.ino === first.root.ino &&
    isRecord(value.checkout.project) &&
    value.checkout.project.dev === first.project.dev &&
    value.checkout.project.ino === first.project.ino
  );
}

/**
 * Admit only the first staged saved-copy hash query before prepared publication.
 * The exact newly created private hierarchy and single generation are checked through
 * the existing no-follow FS owner. Source bytes/identity and the still-empty receipt
 * are rechecked before returning. This grants no mutation or alternate input authority
 * and does not freeze an external editor after the read checks.
 */
export async function adoptionDependencyStagedReadAllowed(opts: {
  readonly args: readonly string[];
  readonly project: string;
  readonly first: AdoptionDependencyFirstPrepare;
}): Promise<boolean> {
  const held: HeldDirectory[] = [];
  try {
    const { first, args } = opts;
    const generationId = args[10]?.split("/").at(-2);
    if (!(generationId && TOKEN.test(generationId)) || args[0] !== "compose") {
      return false;
    }
    if (
      !adoptionDependencyReadAllowed({
        args,
        projectRoot: first.projectRoot,
        project: opts.project,
        containerIds: [],
        networkId: "",
        volumeName: "",
        generationId,
      }) ||
      args[10] === join(first.projectRoot, ".hack/docker-compose.yml")
    ) {
      return false;
    }
    for (const [path, privateDirectory] of [
      [first.projectRoot, false],
      [join(first.projectRoot, ".hack"), false],
      [join(first.projectRoot, ".hack/.internal"), false],
      [join(first.projectRoot, ...STATE_PARTS), true],
      [join(first.projectRoot, ...STATE_PARTS, "generations"), true],
      [dirname(args[10] ?? ""), true],
    ] as const) {
      held.push(await holdDirectory(path, privateDirectory));
    }
    if (
      !(
        held[0] &&
        held[1] &&
        sameFile(held[0].info, first.root) &&
        sameFile(held[1].info, first.project)
      )
    ) {
      return false;
    }
    const generations = join(first.projectRoot, ...STATE_PARTS, "generations");
    if (
      JSON.stringify(await readdir(generations)) !==
      JSON.stringify([generationId])
    ) {
      return false;
    }
    const receiptPath = join(first.projectRoot, ...STATE_PARTS, "receipt.json");
    const receipt = await readPrivate(receiptPath, 64 * 1024);
    if (!emptyReceipt(JSON.parse(receipt.text), first)) {
      return false;
    }
    const staged = await readPrivate(args[10] ?? "", NATIVE_CONFIG_INPUT_LIMIT);
    const source = await readNativeConfigImportSourceFile({
      path: join(first.projectRoot, ".hack/docker-compose.yml"),
    });
    const expected = first.source;
    if (
      staged.text !== expected.text ||
      !sameFile(source.info, expected) ||
      source.info.size !== expected.size ||
      source.info.mode !== expected.mode ||
      source.info.uid !== expected.uid ||
      source.info.nlink !== expected.nlink ||
      source.info.mtimeMs !== expected.mtimeMs ||
      source.info.ctimeMs !== expected.ctimeMs ||
      !source.bytes.equals(Buffer.from(expected.text))
    ) {
      return false;
    }
    await recheckDirectories(held);
    const current = await readPrivate(receiptPath, 64 * 1024);
    const currentStage = await readPrivate(
      args[10] ?? "",
      NATIVE_CONFIG_INPUT_LIMIT
    );
    return (
      current.text === receipt.text &&
      sameFile(current.info, receipt.info) &&
      current.info.mtimeMs === receipt.info.mtimeMs &&
      current.info.ctimeMs === receipt.info.ctimeMs &&
      currentStage.text === staged.text &&
      sameFile(currentStage.info, staged.info) &&
      currentStage.info.mtimeMs === staged.info.mtimeMs &&
      currentStage.info.ctimeMs === staged.info.ctimeMs &&
      JSON.stringify(await readdir(generations)) ===
        JSON.stringify([generationId])
    );
  } catch {
    return false;
  } finally {
    await close(held);
  }
}
