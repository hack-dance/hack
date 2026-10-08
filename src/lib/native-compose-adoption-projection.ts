import type { Stats } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PROJECT_TLD } from "../constants.ts";
import { renderManagedComposeEnvOverride } from "./compose-managed-env.ts";
import { isRecord } from "./guards.ts";
import { legacyComposeAdoptionCandidateSupported } from "./native-compose-adoption-contract.ts";
import { LegacyAdoptionManagedEnvAdmission } from "./native-compose-adoption-env-inputs.ts";
import {
  hasCode,
  holdDirectory,
  recheckDirectories,
} from "./native-compose-private-state.ts";
import { NativeConfigCompilerError } from "./native-config-compiler.ts";
import {
  type NativeConfigImportInputs,
  readNativeConfigImportSourceFile,
} from "./native-config-import-inputs.ts";
import { parseImportDocument } from "./native-config-import-parser.ts";
import {
  freezeImportValue,
  mapLegacyNativeStorageAdoption,
} from "./native-config-import-plan.ts";
import { defaultProjectSlugFromPath } from "./project.ts";
import {
  acquireProjectEnvForLegacyAdoption,
  type NativeProjectEnvExecutionAcquisition,
} from "./project-env-config.ts";
import { buildRuntimeHostMetadataOverride } from "./runtime-host-metadata.ts";

const FILES = [
  "compose.runtime.override.yml",
  "compose.env.override.yml",
] as const;
const CONSTRUCTION_TOKEN = Symbol("legacy-adoption-projection");
const ownedProjections = new WeakSet<object>();
type Source = Extract<NativeConfigImportInputs, { readonly ok: true }>;
type GeneratedFile = {
  readonly path: string;
  readonly text: string;
  readonly info: Stats;
};
type Generated = {
  readonly directory: { readonly dev: number; readonly ino: number } | null;
  readonly files: readonly (GeneratedFile | null)[];
};
function refuse(): never {
  throw new Error(
    "Legacy generated-source projection refused: sources are unsupported, unsafe or changed; values omitted."
  );
}
function check(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw new NativeConfigCompilerError(
      "E_COMPILER_CANCELLED",
      "Legacy generated-source projection was cancelled; values omitted."
    );
  }
}
function redact(error: unknown): never {
  if (
    error instanceof NativeConfigCompilerError &&
    error.code === "E_COMPILER_CANCELLED"
  ) {
    throw new NativeConfigCompilerError(
      "E_COMPILER_CANCELLED",
      "Legacy generated-source projection was cancelled; values omitted."
    );
  }
  refuse();
}
function fileRevision(file: GeneratedFile | null) {
  return file === null
    ? null
    : {
        text: file.text,
        dev: file.info.dev,
        ino: file.info.ino,
        size: file.info.size,
        mode: file.info.mode,
        nlink: file.info.nlink,
        mtimeMs: file.info.mtimeMs,
        ctimeMs: file.info.ctimeMs,
        uid: file.info.uid,
      };
}
function revision(generated: Generated): string {
  return JSON.stringify({
    directory: generated.directory,
    files: generated.files.map(fileRevision),
  });
}
/** Acquire known generated inputs through existing descriptor owners; no writer or key lookup. */
async function acquireGenerated(opts: {
  readonly source: Source;
  readonly signal?: AbortSignal;
}): Promise<Generated> {
  check(opts.signal);
  await opts.source.assertFresh(opts);
  const path = join(opts.source.projectRoot, ".hack/.internal");
  const named = await lstat(path).catch((error: unknown) => {
    if (hasCode(error, "ENOENT")) {
      return null;
    }
    refuse();
  });
  if (named === null) {
    await opts.source.assertFresh(opts);
    return { directory: null, files: FILES.map(() => null) };
  }
  const directory = await holdDirectory(path, false);
  try {
    const files: (GeneratedFile | null)[] = [];
    for (const filename of FILES) {
      check(opts.signal);
      const selected = join(path, filename);
      const info = await lstat(selected).catch((error: unknown) => {
        if (hasCode(error, "ENOENT")) {
          return null;
        }
        refuse();
      });
      if (info === null) {
        files.push(null);
        continue;
      }
      const read = await readNativeConfigImportSourceFile({
        path: selected,
        signal: opts.signal,
      });
      if (
        read.info.uid !== process.getuid?.() ||
        (read.info.mode & 0o022) !== 0
      ) {
        refuse();
      }
      files.push({
        path: selected,
        text: new TextDecoder("utf-8", { fatal: true }).decode(read.bytes),
        info: read.info,
      });
    }
    await recheckDirectories([directory]);
    await opts.source.assertFresh(opts);
    check(opts.signal);
    return {
      directory: { dev: directory.info.dev, ino: directory.info.ino },
      files,
    };
  } finally {
    await directory.file.close();
  }
}

type Context = {
  readonly source: Source;
  readonly admission: LegacyAdoptionManagedEnvAdmission;
  readonly env: NativeProjectEnvExecutionAcquisition;
  readonly candidate: Record<string, unknown>;
  readonly serviceNames: readonly string[];
  readonly generated: Generated;
  readonly runtimeText: string | null;
  readonly signal?: AbortSignal;
};

/** Only deterministic generated runtime strings become authored fallbacks; managed values stay outside the candidate. */
function projectRuntimeFallbacks(
  candidate: Record<string, unknown>,
  runtime: GeneratedFile | null | undefined
): Record<string, unknown> {
  const result = structuredClone(candidate);
  if (!runtime) {
    return result;
  }
  const parsed = parseImportDocument({
    text: runtime.text,
    document: "compose",
  }).value;
  if (!(parsed && isRecord(parsed.services) && isRecord(result.services))) {
    refuse();
  }
  for (const [name, service] of Object.entries(parsed.services)) {
    const target = result.services[name];
    if (
      !(isRecord(service) && isRecord(service.environment) && isRecord(target))
    ) {
      refuse();
    }
    const environment = isRecord(target.environment) ? target.environment : {};
    for (const [key, value] of Object.entries(service.environment)) {
      if (typeof value !== "string" || Object.hasOwn(environment, key)) {
        refuse();
      }
      environment[key] = { default: value };
    }
    target.environment = environment;
  }
  return result;
}

/**
 * Private read-only projection for a branch-free explicit legacy identity.
 * Actual ordered config-file labels and engine-created config hashes must still
 * be verified by the resource owner. This capability performs no writes/effects
 * and grants no execution or durable recovery authority. Generated files remain
 * in place; private values must never enter reports, labels or a new artifact.
 */
export class LegacyComposeAdoptionProjection {
  readonly #context: Context;
  private constructor(context: Context, token: symbol) {
    if (token !== CONSTRUCTION_TOKEN) {
      refuse();
    }
    this.#context = Object.freeze(context);
    ownedProjections.add(this);
    Object.freeze(this);
  }
  static async acquire(opts: {
    readonly source: NativeConfigImportInputs;
    readonly signal?: AbortSignal;
  }): Promise<LegacyComposeAdoptionProjection> {
    try {
      const { source, signal } = opts;
      const admission = await LegacyAdoptionManagedEnvAdmission.acquire({
        source,
        signal,
      });
      if (!source.ok) {
        refuse();
      }
      const mapped = mapLegacyNativeStorageAdoption(source);
      const candidate = mapped.candidate;
      if (!(candidate && legacyComposeAdoptionCandidateSupported(candidate))) {
        refuse();
      }
      const compose = parseImportDocument({
        text: source.composeText,
        document: "compose",
      }).value;
      if (!(compose && isRecord(compose.services))) {
        refuse();
      }
      const env = await acquireProjectEnvForLegacyAdoption({ admission });
      const generated = await acquireGenerated({ source, signal });
      const projection = new LegacyComposeAdoptionProjection(
        {
          source,
          admission,
          env,
          candidate,
          serviceNames: Object.freeze(
            Object.keys(compose.services).sort((a, b) => a.localeCompare(b))
          ),
          generated,
          runtimeText: buildRuntimeHostMetadataOverride({
            composeYamls: [source.composeText],
            branch: null,
            devHost: `${defaultProjectSlugFromPath(source.projectRoot)}.${DEFAULT_PROJECT_TLD}`,
            aliasHost: null,
            composeProject: String(candidate.name),
          }),
          signal,
        },
        CONSTRUCTION_TOKEN
      );
      await projection.assertFresh();
      return projection;
    } catch (error: unknown) {
      redact(error);
    }
  }

  get report() {
    if (!ownedProjections.has(this)) {
      refuse();
    }
    const context = this.#context;
    const result = {
      projection_version: 1,
      status: "acquired",
      admission: "not_performed",
      files: [
        "docker-compose.yml",
        ...FILES.filter(
          (_file, index) => context.generated.files[index] !== null
        ).map((file) => `.internal/${file}`),
      ],
      metadata: context.env.metadata,
    };
    freezeImportValue(result);
    return result;
  }

  async assertFresh(opts?: { readonly signal?: AbortSignal }): Promise<void> {
    try {
      if (!ownedProjections.has(this)) {
        refuse();
      }
      const context = this.#context;
      const signal =
        context.signal && opts?.signal
          ? AbortSignal.any([context.signal, opts.signal])
          : (opts?.signal ?? context.signal);
      check(context.signal);
      await context.env.assertFresh({ ...context.admission.selection, signal });
      const current = await acquireGenerated({
        source: context.source,
        signal,
      });
      if (revision(current) !== revision(context.generated)) {
        refuse();
      }
      await context.source.assertFresh({ signal });
      check(signal);
    } catch (error: unknown) {
      redact(error);
    }
  }

  /** Return private compiler/resource inputs only after exact generated-byte fidelity. JSON omits every property. */
  async resolve(opts?: { readonly signal?: AbortSignal }) {
    try {
      const context = this.#context;
      const signal =
        context.signal && opts?.signal
          ? AbortSignal.any([context.signal, opts.signal])
          : (opts?.signal ?? context.signal);
      await this.assertFresh({ signal });
      const values = await context.env.resolveValues({ signal });
      if (
        Object.values(values.workloadEnv).some((environment) =>
          Object.values(environment).some(
            (value) => value.includes("$") || value.includes("\0")
          )
        )
      ) {
        refuse();
      }
      const text = renderManagedComposeEnvOverride({
        targetServices: context.serviceNames,
        globalEnv: values.globalEnv,
        serviceEnv: values.workloadEnv,
      });
      const [runtime, env] = context.generated.files;
      if (
        (env?.text ?? null) !== text ||
        (runtime && runtime.text !== context.runtimeText)
      ) {
        refuse();
      }
      const candidate = projectRuntimeFallbacks(context.candidate, runtime);
      await this.assertFresh({ signal });
      const result = {
        candidate,
        composeFiles: Object.freeze([
          join(context.source.projectRoot, ".hack/docker-compose.yml"),
          ...context.generated.files.flatMap((file) =>
            file ? [file.path] : []
          ),
        ]),
        globalEnv: values.globalEnv,
        metadata: context.env.metadata,
      };
      for (const [key, value] of Object.entries(result)) {
        freezeImportValue(value);
        Object.defineProperty(result, key, { enumerable: false });
      }
      return Object.freeze(result);
    } catch (error: unknown) {
      redact(error);
    }
  }
}
