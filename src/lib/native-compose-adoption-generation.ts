import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isRecord } from "./guards.ts";
import {
  acquireLegacyComposeAdoptionBinding,
  inspectLegacyComposeAdoptionResources,
  type LegacyComposeVerifiedBinding,
} from "./native-compose-adoption-binding.ts";
import { planLegacyComposeAdoption } from "./native-compose-adoption-plan.ts";
import {
  createNativeComposePrivateMutationLock,
  type HeldDirectory,
  hasCode,
  holdDirectory,
  keys,
  NativeComposeGenerationError,
  privateDirectory,
  privateIgnore,
  readPrivate,
  recheckDirectories,
  sameFile,
  synchronizeDirectories,
  token,
  writeExclusive,
} from "./native-compose-private-state.ts";
import {
  compileNativeConfig,
  NATIVE_CONFIG_INPUT_LIMIT,
} from "./native-config-compiler.ts";
import { parseImportDocument } from "./native-config-import-parser.ts";
import {
  freezeImportValue,
  mapLegacyNativeStorageAdoption,
} from "./native-config-import-plan.ts";

const TOKEN = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const STATE_LIMIT = 64 * 1024;
const KIND = "legacy-compose-adopted";
const ROUTING = [
  "PATH",
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "DOCKER_API_VERSION",
] as const;
type FileIdentity = { readonly dev: number; readonly ino: number };
type Artifact = FileIdentity & { readonly hash: string };
type Checkout = {
  readonly root: FileIdentity;
  readonly project: FileIdentity;
  readonly git: FileIdentity;
};
type Anchor = { readonly id: string; readonly manifest: Artifact };
type Receipt = {
  readonly adoption_receipt_version: 1;
  readonly kind: typeof KIND;
  readonly checkout: Checkout;
  readonly prepared: Anchor | null;
};
type SavedManifest = {
  readonly adoption_generation_version: 1;
  readonly kind: typeof KIND;
  readonly projectRoot: string;
  readonly id: string;
  readonly binding: unknown;
  readonly files: {
    readonly config: Artifact;
    readonly compose: Artifact;
    readonly candidate: Artifact;
  };
};
type Manifest = Omit<SavedManifest, "binding"> & {
  readonly binding: LegacyComposeVerifiedBinding;
};
type PrivateInputs = {
  readonly configText: string;
  readonly composeText: string;
  readonly candidateText: string;
  readonly binding: LegacyComposeVerifiedBinding;
};

type Code =
  | "E_LEGACY_ADOPTION_STATE"
  | "E_LEGACY_ADOPTION_BUSY"
  | "E_LEGACY_ADOPTION_CHANGED"
  | "E_LEGACY_ADOPTION_UNSUPPORTED"
  | "E_LEGACY_ADOPTION_CANCELLED";
/** Fixed diagnostics never retain source values, resource facts, compiler output or abort reasons. */
export class LegacyComposeAdoptedGenerationError extends Error {
  readonly code: Code;
  constructor(code: Code) {
    super(
      {
        E_LEGACY_ADOPTION_STATE:
          "Legacy adoption generation state is invalid, unsafe or changed; values omitted.",
        E_LEGACY_ADOPTION_BUSY:
          "Legacy adoption generation is busy or requires explicit interrupted-lock recovery; values omitted.",
        E_LEGACY_ADOPTION_CHANGED:
          "Legacy adoption source or original resource binding changed; values omitted.",
        E_LEGACY_ADOPTION_UNSUPPORTED:
          "Legacy adoption conversion is unsupported or compiler admission refused; values omitted.",
        E_LEGACY_ADOPTION_CANCELLED:
          "Legacy adoption generation was cancelled; values omitted.",
      }[code]
    );
    this.name = "LegacyComposeAdoptedGenerationError";
    this.code = code;
  }
}
function refuse(code: Code = "E_LEGACY_ADOPTION_STATE"): never {
  throw new LegacyComposeAdoptedGenerationError(code);
}
function cancelled(signal?: AbortSignal) {
  if (signal?.aborted) {
    refuse("E_LEGACY_ADOPTION_CANCELLED");
  }
}
function translate(error: unknown, signal?: AbortSignal): never {
  cancelled(signal);
  if (error instanceof LegacyComposeAdoptedGenerationError) {
    throw error;
  }
  if (
    error instanceof NativeComposeGenerationError &&
    error.code === "E_NATIVE_COMPOSE_BUSY"
  ) {
    refuse("E_LEGACY_ADOPTION_BUSY");
  }
  refuse();
}
function hash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}
function route() {
  return JSON.stringify(ROUTING.map((key) => process.env[key]));
}
function fileIdentity(info: Stats): FileIdentity {
  return { dev: info.dev, ino: info.ino };
}
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
function receipt(value: unknown, checkout: Checkout): Receipt {
  if (
    !(
      isRecord(value) &&
      keys(value, "adoption_receipt_version,checkout,kind,prepared") &&
      value.adoption_receipt_version === 1 &&
      value.kind === KIND &&
      JSON.stringify(value.checkout) === JSON.stringify(checkout) &&
      (value.prepared === null || anchor(value.prepared))
    )
  ) {
    refuse();
  }
  return {
    adoption_receipt_version: 1,
    kind: KIND,
    checkout,
    prepared: value.prepared,
  };
}
function manifest(value: unknown, root: string, id: string): SavedManifest {
  if (
    !(
      isRecord(value) &&
      keys(
        value,
        "adoption_generation_version,binding,files,id,kind,projectRoot"
      ) &&
      value.adoption_generation_version === 1 &&
      value.kind === KIND &&
      value.id === id &&
      value.projectRoot === root &&
      isRecord(value.binding) &&
      isRecord(value.files) &&
      keys(value.files, "candidate,compose,config") &&
      artifact(value.files.config) &&
      artifact(value.files.compose) &&
      artifact(value.files.candidate)
    )
  ) {
    refuse();
  }
  return {
    adoption_generation_version: 1,
    kind: KIND,
    projectRoot: root,
    id,
    binding: value.binding,
    files: {
      config: value.files.config,
      compose: value.files.compose,
      candidate: value.files.candidate,
    },
  };
}
function privateResult<T extends Record<string, unknown>>(
  value: T
): Readonly<T> {
  for (const entry of Object.values(value)) {
    freezeImportValue(entry);
  }
  for (const key of Object.keys(value)) {
    Object.defineProperty(value, key, { enumerable: false });
  }
  return Object.freeze(value);
}
async function json(path: string) {
  const read = await readPrivate(path, STATE_LIMIT);
  const parsed = parseImportDocument({ text: read.text, document: "config" });
  if (!parsed.value) {
    refuse();
  }
  return { ...read, value: parsed.value };
}
async function readArtifact(
  path: string,
  expected: Artifact,
  limit = NATIVE_CONFIG_INPUT_LIMIT
) {
  const read = await readPrivate(path, limit);
  if (!sameFile(read.info, expected) || hash(read.text) !== expected.hash) {
    refuse();
  }
  return read.text;
}
async function writeArtifact(path: string, text: string): Promise<Artifact> {
  if (!text.length || Buffer.byteLength(text) > NATIVE_CONFIG_INPUT_LIMIT) {
    refuse();
  }
  const info = await writeExclusive(path, text);
  return { ...fileIdentity(info), hash: hash(text) };
}

/** A distinct private generation claim; it never makes original legacy resources native nonce-owned. */
export type LegacyComposeAdoptedGeneration = {
  readonly report: {
    readonly adoption_generation_version: 1;
    readonly owner: "legacy-compose";
    readonly status: "prepared";
    readonly containers: number;
    readonly volumes: number;
  };
};
export type LegacyComposeAdoptedGenerationStore = {
  /** Self-acquires source and the existing binding; callers cannot supply resource names or identity claims. */
  readonly prepare: (opts?: {
    readonly binary?: string;
  }) => Promise<LegacyComposeAdoptedGeneration>;
  readonly loadPrepared: () => Promise<LegacyComposeAdoptedGeneration | null>;
  /** Private exact original source/candidate/binding; neither lease nor preparation performs engine effects. */
  readonly withLease: <T>(opts: {
    readonly generation: LegacyComposeAdoptedGeneration;
    readonly run: (input: Readonly<PrivateInputs>) => Promise<T>;
  }) => Promise<T>;
  readonly recoverInterruptedLock: () => Promise<void>;
  readonly close: () => Promise<void>;
};

type Context = {
  readonly root: string;
  readonly checkout: Checkout;
  readonly directories: HeldDirectory[];
  readonly stateRoot: string;
  readonly generationsRoot: string;
  readonly receiptPath: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly check: () => Promise<void>;
};
async function readInputs(
  ctx: Context,
  selected: Anchor
): Promise<{
  readonly manifest: Manifest;
  readonly inputs: Readonly<PrivateInputs>;
}> {
  await ctx.check();
  const generationRoot = join(ctx.generationsRoot, selected.id);
  const held = await holdDirectory(generationRoot, true);
  try {
    const saved = await json(join(generationRoot, "manifest.json"));
    if (
      !sameFile(saved.info, selected.manifest) ||
      hash(saved.text) !== selected.manifest.hash
    ) {
      refuse();
    }
    const meta = manifest(saved.value, ctx.root, selected.id);
    const configText = await readArtifact(
      join(generationRoot, "legacy-config.json"),
      meta.files.config
    );
    const composeText = await readArtifact(
      join(generationRoot, "legacy-compose.yml"),
      meta.files.compose
    );
    const candidateText = await readArtifact(
      join(generationRoot, "candidate.json"),
      meta.files.candidate
    );
    const mapped = mapLegacyNativeStorageAdoption({ configText, composeText });
    const planned = planLegacyComposeAdoption({ configText, composeText });
    if (
      !(
        mapped.candidate &&
        planned.intent &&
        candidateText === JSON.stringify(mapped.candidate)
      )
    ) {
      refuse();
    }
    const observed = await inspectLegacyComposeAdoptionResources({
      root: ctx.root,
      intent: planned.intent,
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
    });
    if (JSON.stringify(meta.binding) !== JSON.stringify(observed)) {
      refuse("E_LEGACY_ADOPTION_CHANGED");
    }
    await recheckDirectories([held]);
    await ctx.check();
    freezeImportValue(observed);
    return {
      manifest: { ...meta, binding: observed },
      inputs: privateResult({
        configText,
        composeText,
        candidateText,
        binding: observed,
      }),
    };
  } finally {
    await held.file.close();
  }
}
async function save(ctx: Context, value: Receipt) {
  await ctx.check();
  const previous = await json(ctx.receiptPath);
  receipt(previous.value, ctx.checkout);
  const temporary = join(ctx.stateRoot, `${token()}.receipt`);
  await writeExclusive(temporary, JSON.stringify(value));
  const staged = await readPrivate(temporary, STATE_LIMIT);
  await ctx.check();
  const latest = await json(ctx.receiptPath);
  if (!sameFile(previous.info, latest.info) || previous.text !== latest.text) {
    refuse();
  }
  await rename(temporary, ctx.receiptPath);
  await ctx.directories.at(-2)?.file.sync();
  const published = await json(ctx.receiptPath);
  if (
    !sameFile(staged.info, published.info) ||
    staged.text !== published.text
  ) {
    refuse();
  }
  await ctx.check();
}
function claim(
  selected: Anchor,
  known: WeakMap<LegacyComposeAdoptedGeneration, Anchor>,
  binding: LegacyComposeVerifiedBinding
): LegacyComposeAdoptedGeneration {
  const result: LegacyComposeAdoptedGeneration = {
    report: {
      adoption_generation_version: 1,
      owner: "legacy-compose",
      status: "prepared",
      containers: binding.containers.length,
      volumes: binding.volumes.length,
    },
  };
  freezeImportValue(result);
  known.set(result, selected);
  return result;
}
async function prepare(
  ctx: Context,
  binary: string | undefined
): Promise<Anchor> {
  const binding = await acquireLegacyComposeAdoptionBinding({
    projectRoot: ctx.root,
    signal: ctx.signal,
    timeoutMs: ctx.timeoutMs,
  });
  const acquired = await binding.resolvePreparationInputs({
    projectRoot: ctx.root,
    signal: ctx.signal,
  });
  const mapped = mapLegacyNativeStorageAdoption(acquired);
  if (!mapped.candidate) {
    refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
  }
  const candidateText = JSON.stringify(mapped.candidate);
  const compiled = await compileNativeConfig({
    input: new TextEncoder().encode(candidateText),
    binary,
    signal: ctx.signal,
  });
  if (!compiled.ok) {
    refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
  }
  await binding.assertFresh({ projectRoot: ctx.root, signal: ctx.signal });
  await ctx.check();
  const id = token();
  const generationRoot = join(ctx.generationsRoot, id);
  await mkdir(generationRoot, { mode: 0o700 });
  const held = await holdDirectory(generationRoot, true);
  try {
    const files = {
      config: await writeArtifact(
        join(generationRoot, "legacy-config.json"),
        acquired.configText
      ),
      compose: await writeArtifact(
        join(generationRoot, "legacy-compose.yml"),
        acquired.composeText
      ),
      candidate: await writeArtifact(
        join(generationRoot, "candidate.json"),
        candidateText
      ),
    };
    const meta: Manifest = {
      adoption_generation_version: 1,
      kind: KIND,
      projectRoot: ctx.root,
      id,
      binding: acquired.binding,
      files,
    };
    const text = JSON.stringify(meta);
    if (Buffer.byteLength(text) > STATE_LIMIT) {
      refuse();
    }
    const written = await writeExclusive(
      join(generationRoot, "manifest.json"),
      text
    );
    await held.file.sync();
    await ctx.directories.at(-1)?.file.sync();
    await recheckDirectories([held]);
    await binding.assertFresh({ projectRoot: ctx.root, signal: ctx.signal });
    await ctx.check();
    return { id, manifest: { ...fileIdentity(written), hash: hash(text) } };
  } finally {
    await held.file.close();
  }
}

/**
 * Durable preparation for an explicit future format transition. Uses the same
 * bounded private file/lock authority as native generations, with a distinct
 * receipt/type/path and the original legacy resource owner. Saved reads need no
 * current authored files, env values or keys. This owner never publishes active
 * authored files, relabels resources, creates replacement data or runs an engine.
 * Cooperative leases and rechecks cannot freeze Docker or external editors.
 */
export async function openLegacyComposeAdoptedGenerationStore(input: {
  readonly projectRoot: string;
  readonly mode?: "prepare" | "saved";
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}): Promise<LegacyComposeAdoptedGenerationStore> {
  const directories: HeldDirectory[] = [];
  let signal: AbortSignal | undefined;
  try {
    if (
      !isRecord(input) ||
      typeof input.projectRoot !== "string" ||
      !input.projectRoot.length ||
      input.projectRoot.includes("\0") ||
      (input.signal !== undefined && !(input.signal instanceof AbortSignal)) ||
      (input.mode !== undefined && !["prepare", "saved"].includes(input.mode))
    ) {
      refuse();
    }
    const root = resolve(input.projectRoot),
      mode = input.mode ?? "prepare";
    signal = input.signal;
    const timeoutMs = input.timeoutMs,
      capturedRoute = route();
    cancelled(signal);
    for (const path of [root, join(root, ".hack"), join(root, ".git")]) {
      directories.push(await holdDirectory(path, false));
    }
    const rootInfo = directories[0]?.info,
      projectInfo = directories[1]?.info,
      gitInfo = directories[2]?.info;
    if (!(rootInfo && projectInfo && gitInfo)) {
      refuse();
    }
    const checkout: Checkout = {
      root: fileIdentity(rootInfo),
      project: fileIdentity(projectInfo),
      git: fileIdentity(gitInfo),
    };
    const internal = join(root, ".hack/.internal");
    if (mode !== "saved") {
      try {
        await mkdir(internal, { mode: 0o700 });
      } catch (error: unknown) {
        if (!hasCode(error, "EEXIST")) {
          throw error;
        }
      }
    }
    directories.push(await holdDirectory(internal, false));
    const owned = async (path: string) =>
      mode === "saved"
        ? await holdDirectory(path, true)
        : await privateDirectory(path);
    const stateRoot = join(internal, "legacy-compose-adoption-v1");
    directories.push(await owned(stateRoot));
    const ignorePath = join(stateRoot, ".gitignore"),
      ignore = await privateIgnore(ignorePath, mode !== "saved");
    const generationsRoot = join(stateRoot, "generations");
    directories.push(await owned(generationsRoot));
    const receiptPath = join(stateRoot, "receipt.json");
    let closed = false;
    const check = async () => {
      cancelled(signal);
      if (closed || route() !== capturedRoute) {
        refuse("E_LEGACY_ADOPTION_CHANGED");
      }
      await recheckDirectories(directories);
      const currentIgnore = await readPrivate(ignorePath, 2);
      if (
        !sameFile(ignore.info, currentIgnore.info) ||
        ignore.text !== currentIgnore.text
      ) {
        refuse();
      }
    };
    const ctx: Context = {
      root,
      checkout,
      directories,
      stateRoot,
      generationsRoot,
      receiptPath,
      signal,
      timeoutMs,
      check,
    };
    const lock = createNativeComposePrivateMutationLock({
      lockPath: join(stateRoot, "mutation.lock"),
      recoveryPath: join(stateRoot, "recovery.lock"),
      parent: directories.at(-2),
      check,
    });
    const initialize = async () => {
      try {
        receipt((await json(receiptPath)).value, checkout);
      } catch (error: unknown) {
        if (mode === "saved" || !hasCode(error, "ENOENT")) {
          throw error;
        }
        await writeExclusive(
          receiptPath,
          JSON.stringify({
            adoption_receipt_version: 1,
            kind: KIND,
            checkout,
            prepared: null,
          })
        );
        await synchronizeDirectories(directories);
      }
    };
    if (mode === "saved") {
      await initialize();
    } else {
      await lock.withLock(initialize);
    }
    const known = new WeakMap<LegacyComposeAdoptedGeneration, Anchor>();
    const selected = async () => {
      await check();
      return receipt((await json(receiptPath)).value, checkout).prepared;
    };
    const result: LegacyComposeAdoptedGenerationStore = {
      async prepare(opts = {}) {
        try {
          const binary = opts.binary;
          if (mode === "saved") {
            refuse();
          }
          return await lock.withLock(async () => {
            const generated = await prepare(ctx, binary);
            const loaded = await readInputs(ctx, generated);
            await save(ctx, {
              adoption_receipt_version: 1,
              kind: KIND,
              checkout,
              prepared: generated,
            });
            return claim(generated, known, loaded.manifest.binding);
          });
        } catch (error: unknown) {
          translate(error, signal);
        }
      },
      async loadPrepared() {
        try {
          const current = await selected();
          if (!current) {
            return null;
          }
          const loaded = await readInputs(ctx, current);
          return claim(current, known, loaded.manifest.binding);
        } catch (error: unknown) {
          translate(error, signal);
        }
      },
      async withLease(opts) {
        try {
          const captured = { ...opts };
          return await lock.withLock(async () => {
            const current = await selected(),
              selectedAnchor = known.get(captured.generation);
            if (
              !(current && selectedAnchor) ||
              JSON.stringify(current) !== JSON.stringify(selectedAnchor)
            ) {
              refuse();
            }
            const loaded = await readInputs(ctx, current);
            const value = await captured.run(loaded.inputs);
            await readInputs(ctx, current);
            if (JSON.stringify(await selected()) !== JSON.stringify(current)) {
              refuse();
            }
            return value;
          });
        } catch (error: unknown) {
          translate(error, signal);
        }
      },
      async recoverInterruptedLock() {
        try {
          await lock.recoverInterruptedLock();
        } catch (error: unknown) {
          translate(error, signal);
        }
      },
      async close() {
        closed = true;
        await Promise.all(
          directories.map((directory) => directory.file.close())
        );
      },
    };
    for (const key of Object.keys(result)) {
      Object.defineProperty(result, key, { enumerable: false });
    }
    return Object.freeze(result);
  } catch (error: unknown) {
    await Promise.all(directories.map((directory) => directory.file.close()));
    translate(error, signal);
  }
}
