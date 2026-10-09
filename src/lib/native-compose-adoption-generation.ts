import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { link, lstat, mkdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { resolveGlobalHackDir } from "./config-paths.ts";
import { isRecord } from "./guards.ts";
import {
  acquireLegacyComposeAdoptionPreparationBinding,
  inspectLegacyComposeAdoptionResources,
  inspectLegacyComposeSourceBindResources,
  type LegacyComposeVerifiedBinding,
} from "./native-compose-adoption-binding.ts";
import {
  acquireLegacyComposeBranch,
  type LegacyComposeBranchProof,
  legacyComposeBranchProof,
} from "./native-compose-adoption-branch.ts";
import { assertSavedLegacyComposeBuildSource } from "./native-compose-adoption-build.ts";
import { inspectLegacyComposeRetainedBuildImages } from "./native-compose-adoption-build-images.ts";
import { acquireLegacyComposeAdoptionCheckout } from "./native-compose-adoption-checkout.ts";
import { admitLegacyComposeCandidate } from "./native-compose-adoption-compiler.ts";
import {
  legacyComposeAdoptionCandidateSupported,
  legacyComposeAdoptionLayoutSupported,
} from "./native-compose-adoption-contract.ts";
import {
  attachLegacyComposeOrderedRefusal,
  legacyComposeOrderedRefusal,
} from "./native-compose-adoption-diagnostics.ts";
import {
  consumeLegacyComposeJobCompletion,
  type LegacyComposeRetainedOutcome,
} from "./native-compose-adoption-execution.ts";
import {
  legacyComposeFreshJobResult,
  legacyComposeJobStates,
} from "./native-compose-adoption-jobs.ts";
import {
  planLegacyComposeAdoption,
  planLegacyComposeRetainedBasicBuildAdoption,
  planLegacyComposeRetainedRoutingAdoption,
  planLegacyComposeSourceBindAdoption,
} from "./native-compose-adoption-plan.ts";
import { readSavedLegacyComposeAdoptionProjection } from "./native-compose-adoption-projection.ts";
import {
  type LegacyComposePublicationRefusal,
  legacyComposePublicationRefusal,
  retainLegacyComposePublicationRefusal,
} from "./native-compose-adoption-publication-diagnostics.ts";
import {
  type LegacyComposeRetainedPlan,
  legacyComposeRetainedOrdered,
  legacyComposeRetainedPlan,
  legacyComposeRetainedReady,
} from "./native-compose-adoption-readiness.ts";
import {
  type AdoptionOperation,
  type Anchor,
  type Artifact,
  type Checkout,
  type FileIdentity,
  type Publication,
  type Receipt,
  parseLegacyComposeAdoptionReceipt as receipt,
} from "./native-compose-adoption-receipt.ts";
import { assertLegacyComposeRetainedRoutingState } from "./native-compose-adoption-routing.ts";
import { consumeLegacyComposeRoutingCompletion } from "./native-compose-adoption-routing-execution.ts";
import {
  inspectLegacyComposeContainerStates,
  inspectLegacyComposeJobStates,
  inspectLegacyComposeReadiness,
  inspectLegacyComposeRuntimeConfig,
} from "./native-compose-adoption-runtime.ts";
import { holdSavedLegacyComposeSourceBind } from "./native-compose-adoption-source-bind.ts";
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
  type NativeComposeRouteAttempt,
  type NativeComposeRouteClaims,
  type NativeComposeRouteReference,
  openNativeComposeRouteClaims,
  parseNativeComposeRouteReference,
} from "./native-compose-route-claims.ts";
import {
  NATIVE_CONFIG_INPUT_LIMIT,
  NativeConfigCompilerError,
} from "./native-config-compiler.ts";
import {
  type NativeConfigImportSourceIdentity,
  readNativeConfigImportSourceFile,
  readNativeConfigImportSourceLinkPair,
} from "./native-config-import-inputs.ts";
import { parseImportDocument } from "./native-config-import-parser.ts";
import {
  freezeImportValue,
  mapLegacyNativeBranchStorageAdoption,
  mapLegacyNativeRetainedBasicBuild,
  mapLegacyNativeRetainedRouting,
  mapLegacyNativeRetainedSourceBind,
  mapLegacyNativeStorageAdoption,
} from "./native-config-import-plan.ts";
import {
  type LegacyComposeRoutingIntent,
  mapLegacyComposeRouting,
} from "./native-config-import-routing.ts";
import type { NativeRoutingResolution } from "./native-routing-plan-protocol.ts";
import type { NativeProjectEnvMetadata } from "./project-env-config.ts";

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
  "CI",
  "HACK_EXECUTION_MODE",
] as const;
type SavedManifest = {
  readonly adoption_generation_version:
    | 1
    | 3
    | 4
    | 5
    | 6
    | 7
    | 9
    | 10
    | 11
    | 12
    | 13
    | 14;
  readonly kind: typeof KIND;
  readonly projectRoot: string;
  readonly id: string;
  readonly binding: unknown;
  readonly runtimeConfig: unknown;
  readonly projectionProof?: unknown;
  readonly routingClaims?: NativeComposeRouteReference;
  readonly routingRoot?: string;
  readonly buildProof?: { readonly source: unknown; readonly images: unknown };
  readonly sourceBindProof?: unknown;
  readonly branchProof?: LegacyComposeBranchProof;
  readonly sourceFiles: {
    readonly config: NativeConfigImportSourceIdentity;
    readonly compose: NativeConfigImportSourceIdentity;
  };
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
  readonly projectionMetadata?: NativeProjectEnvMetadata;
  /** Private version9 policy; never serialized into a compiler report or receipt label. */
  readonly retainedBuild?: true;
  readonly retainedRouting?: true;
  readonly routingResolution?: NativeRoutingResolution;
  readonly retainedSourceBind?: true;
};
type MutationInputs = PrivateInputs & {
  /** Issued while the journal and mutation lock are held; valid only during this callback. */
  readonly assertFresh: () => Promise<void>;
  /** Synchronous revocation fence for the final spawn boundary. */
  readonly assertActive: () => void;
  readonly retainedPlan: LegacyComposeRetainedPlan;
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
  try {
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
    const translated = new LegacyComposeAdoptedGenerationError(
      "E_LEGACY_ADOPTION_STATE"
    );
    const diagnostic = legacyComposeOrderedRefusal(error);
    if (diagnostic) {
      attachLegacyComposeOrderedRefusal(translated, diagnostic);
    }
    throw translated;
  } catch (translated: unknown) {
    const diagnostic = legacyComposePublicationRefusal(error);
    if (diagnostic) {
      retainLegacyComposePublicationRefusal(translated, diagnostic);
    }
    throw translated;
  }
}

/** Read only known owners' closed codes, never arbitrary error properties or text. */
function recordPublicationRefusal(
  error: unknown,
  stage: LegacyComposePublicationRefusal["stage"]
): void {
  try {
    let reason: LegacyComposePublicationRefusal["reason"] = "unclassified";
    const code: unknown =
      typeof error === "object" && error !== null
        ? Object.getOwnPropertyDescriptor(error, "code")?.value
        : undefined;
    if (error instanceof LegacyComposeAdoptedGenerationError) {
      switch (code) {
        case "E_LEGACY_ADOPTION_STATE":
          reason = "legacy-state";
          break;
        case "E_LEGACY_ADOPTION_BUSY":
          reason = "legacy-busy";
          break;
        case "E_LEGACY_ADOPTION_CHANGED":
          reason = "legacy-changed";
          break;
        case "E_LEGACY_ADOPTION_UNSUPPORTED":
          reason = "legacy-unsupported";
          break;
        case "E_LEGACY_ADOPTION_CANCELLED":
          reason = "legacy-cancelled";
          break;
        default:
          break;
      }
    } else if (error instanceof NativeComposeGenerationError) {
      switch (code) {
        case "E_NATIVE_COMPOSE_STATE":
          reason = "private-state";
          break;
        case "E_NATIVE_COMPOSE_BUSY":
          reason = "private-busy";
          break;
        case "E_NATIVE_COMPOSE_UNCERTAIN":
          reason = "private-uncertain";
          break;
        case "E_NATIVE_COMPOSE_STALE":
          reason = "private-stale";
          break;
        default:
          break;
      }
    } else if (error instanceof NativeConfigCompilerError) {
      reason = "compiler-transport";
    }
    retainLegacyComposePublicationRefusal(error, { stage, reason });
  } catch {
    // Classification is optional and must not replace the original rejection.
  }
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
function sourceFileIdentity(
  value: unknown
): value is NativeConfigImportSourceIdentity {
  return (
    identity(value) &&
    keys(value, "ctimeMs,dev,ino,mode,mtimeMs,nlink,size,uid") &&
    typeof value.mode === "number" &&
    Number.isSafeInteger(value.mode) &&
    value.nlink === 1 &&
    typeof value.size === "number" &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    value.size <= NATIVE_CONFIG_INPUT_LIMIT &&
    typeof value.mtimeMs === "number" &&
    Number.isFinite(value.mtimeMs) &&
    typeof value.ctimeMs === "number" &&
    Number.isFinite(value.ctimeMs) &&
    value.uid === process.getuid?.()
  );
}
function manifestFieldKeys(value: Record<string, unknown>) {
  if (value.adoption_generation_version === 14) {
    return "adoption_generation_version,binding,files,id,kind,projectRoot,projectionProof,routingClaims,routingRoot,runtimeConfig,sourceFiles";
  }
  if (value.adoption_generation_version === 13) {
    return "adoption_generation_version,binding,branchProof,files,id,kind,projectRoot,runtimeConfig,sourceFiles";
  }
  if (value.adoption_generation_version === 12) {
    return "adoption_generation_version,binding,files,id,kind,projectRoot,runtimeConfig,sourceBindProof,sourceFiles";
  }
  if (value.adoption_generation_version === 9) {
    return "adoption_generation_version,binding,buildProof,files,id,kind,projectRoot,runtimeConfig,sourceFiles";
  }
  const projected =
    (value.adoption_generation_version === 5 &&
      Object.hasOwn(value, "projectionProof")) ||
    value.adoption_generation_version === 3 ||
    value.adoption_generation_version === 4;
  return projected
    ? "adoption_generation_version,binding,files,id,kind,projectRoot,projectionProof,runtimeConfig,sourceFiles"
    : "adoption_generation_version,binding,files,id,kind,projectRoot,runtimeConfig,sourceFiles";
}
function manifest(value: unknown, root: string, id: string): SavedManifest {
  if (
    !(
      isRecord(value) &&
      keys(value, manifestFieldKeys(value)) &&
      (value.adoption_generation_version === 1 ||
        (value.adoption_generation_version === 14 &&
          isRecord(value.projectionProof) &&
          value.projectionProof.projection_version === 3 &&
          isRecord(value.routingClaims) &&
          typeof value.routingRoot === "string" &&
          resolve(value.routingRoot) === value.routingRoot) ||
        (value.adoption_generation_version === 13 &&
          legacyComposeBranchProof(value.branchProof)) ||
        (value.adoption_generation_version === 12 &&
          isRecord(value.sourceBindProof)) ||
        value.adoption_generation_version === 7 ||
        value.adoption_generation_version === 6 ||
        (value.adoption_generation_version === 9 &&
          isRecord(value.buildProof) &&
          keys(value.buildProof, "images,source") &&
          isRecord(value.buildProof.source) &&
          Array.isArray(value.buildProof.images)) ||
        value.adoption_generation_version === 11 ||
        value.adoption_generation_version === 10 ||
        (value.adoption_generation_version === 5 &&
          (!Object.hasOwn(value, "projectionProof") ||
            (isRecord(value.projectionProof) &&
              (value.projectionProof.projection_version === 1 ||
                value.projectionProof.projection_version === 2)))) ||
        ((value.adoption_generation_version === 3 ||
          value.adoption_generation_version === 4) &&
          isRecord(value.projectionProof) &&
          value.projectionProof.projection_version ===
            (value.adoption_generation_version === 4 ? 2 : 1))) &&
      value.kind === KIND &&
      value.id === id &&
      value.projectRoot === root &&
      isRecord(value.binding) &&
      isRecord(value.sourceFiles) &&
      sourceFileIdentity(value.sourceFiles.config) &&
      sourceFileIdentity(value.sourceFiles.compose) &&
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
    adoption_generation_version: value.adoption_generation_version,
    kind: KIND,
    projectRoot: root,
    id,
    binding: value.binding,
    ...(value.adoption_generation_version === 13 &&
    legacyComposeBranchProof(value.branchProof)
      ? { branchProof: value.branchProof }
      : {}),
    runtimeConfig: value.runtimeConfig,
    ...(value.adoption_generation_version === 14
      ? {
          routingClaims: parseNativeComposeRouteReference(value.routingClaims),
          routingRoot: String(value.routingRoot),
        }
      : {}),
    ...(value.adoption_generation_version === 12
      ? { sourceBindProof: value.sourceBindProof }
      : {}),
    ...(value.adoption_generation_version === 9 && isRecord(value.buildProof)
      ? {
          buildProof: {
            source: value.buildProof.source,
            images: value.buildProof.images,
          },
        }
      : {}),
    ...((value.adoption_generation_version === 5 &&
      Object.hasOwn(value, "projectionProof")) ||
    value.adoption_generation_version === 3 ||
    value.adoption_generation_version === 4 ||
    value.adoption_generation_version === 14
      ? { projectionProof: value.projectionProof }
      : {}),
    sourceFiles: {
      config: value.sourceFiles.config,
      compose: value.sourceFiles.compose,
    },
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
    readonly adoption_generation_version: Manifest["adoption_generation_version"];
    readonly owner: "legacy-compose";
    readonly status: "prepared" | "active";
    readonly containers: number;
    readonly volumes: number;
  };
};
export type LegacyComposeAdoptedGenerationStore = {
  /** Self-acquires source and the existing binding; callers cannot supply resource names or identity claims. */
  readonly prepare: (opts?: {
    readonly binary?: string;
  }) => Promise<LegacyComposeAdoptedGeneration>;
  readonly loadPrepared: (opts?: {
    readonly recoverOperation?: boolean;
  }) => Promise<LegacyComposeAdoptedGeneration | null>;
  readonly loadActive: (opts?: {
    readonly recoverOperation?: boolean;
  }) => Promise<LegacyComposeAdoptedGeneration | null>;
  /** Explicit owned stopped transition; journal commits before moving any selected authored input. */
  readonly publish: (opts: {
    readonly generation: LegacyComposeAdoptedGeneration;
    readonly binary?: string;
  }) => Promise<void>;
  readonly rollback: () => Promise<void>;
  /** Explicit repair after lock recovery; incomplete source/resource ownership refuses rather than overwriting edits. */
  readonly repairPublication: (opts: {
    readonly action: "complete" | "rollback";
    readonly binary?: string;
  }) => Promise<void>;
  /** Private exact original source/candidate/binding; neither lease nor preparation performs engine effects. */
  readonly withLease: <T>(opts: {
    readonly generation: LegacyComposeAdoptedGeneration;
    readonly run: (input: Readonly<PrivateInputs>) => Promise<T>;
  }) => Promise<T>;
  /** Journal retained-container effects before spawning. Failed or uncertain completion fences ordinary replay. */
  readonly withMutation: (opts: {
    readonly generation: LegacyComposeAdoptedGeneration;
    readonly operation: AdoptionOperation;
    readonly services: readonly string[];
    readonly binary?: string;
    readonly recover?: boolean;
    readonly deadline?: number;
    readonly run: (
      input: Readonly<MutationInputs>
    ) => Promise<LegacyComposeRetainedOutcome>;
  }) => Promise<number>;
  /** Explicit stop of all verified originals before publication; partial completion requires explicit recovery. */
  readonly withPreparationStop: (opts: {
    readonly generation: LegacyComposeAdoptedGeneration;
    readonly binary?: string;
    readonly recover?: boolean;
    readonly deadline?: number;
    readonly run: (
      input: Readonly<MutationInputs>
    ) => Promise<LegacyComposeRetainedOutcome>;
  }) => Promise<number>;
  readonly recoverInterruptedLock: () => Promise<void>;
  readonly close: () => Promise<void>;
};

type Context = {
  readonly root: string;
  readonly routingRoot: string;
  readonly checkout: Checkout;
  readonly directories: HeldDirectory[];
  readonly stateRoot: string;
  readonly generationsRoot: string;
  readonly receiptPath: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly requestedBranch?: string;
  readonly check: () => Promise<void>;
  /** Shared by bounded/transaction contexts; only authenticated saved v12 reads install a lease. */
  readonly sourceBind: {
    current?: {
      readonly generation: Anchor;
      readonly lease: Awaited<
        ReturnType<typeof holdSavedLegacyComposeSourceBind>
      >;
    };
  };
  readonly receiptSnapshots: WeakMap<
    Receipt,
    { readonly info: Stats; readonly text: string }
  >;
};
type RetainedRouteObservation = {
  readonly binding: LegacyComposeVerifiedBinding;
  readonly runtimeConfig: unknown;
  readonly assertActive: () => void;
  readonly assertManifest: (meta: SavedManifest) => void;
};
// Only the private read-only routing proof issues this context. Revoked entries
// remain in the WeakMap so a late continuation refuses instead of reacquiring.
const retainedRouteObservations = new WeakMap<
  Context,
  RetainedRouteObservation
>();
async function assertRetainedBuildSource(opts: {
  readonly ctx: Context;
  readonly meta: SavedManifest;
  readonly configText: string;
  readonly composeText: string;
}) {
  if (opts.meta.adoption_generation_version !== 9) {
    return;
  }
  if (!opts.meta.buildProof) {
    refuse();
  }
  await assertSavedLegacyComposeBuildSource({
    projectRoot: opts.ctx.root,
    configText: opts.configText,
    composeText: opts.composeText,
    proof: opts.meta.buildProof.source,
    signal: opts.ctx.signal,
    checkOwner: opts.ctx.check,
  });
}
function requireRetainedGenerationVersion(
  meta: SavedManifest,
  retainedPlan: LegacyComposeRetainedPlan,
  candidate: unknown
): void {
  if (
    (retainedPlan.requiresV7 === true) !==
      (meta.adoption_generation_version === 7) ||
    (!retainedPlan.requiresV7 &&
      retainedPlan.requiresV5 !==
        (meta.adoption_generation_version === 5 ||
          meta.adoption_generation_version === 10)) ||
    (meta.adoption_generation_version === 13 &&
      (retainedPlan.requiresV5 || retainedPlan.requiresV7)) ||
    (retainedPlan.requiresV7 &&
      (!isRecord(meta.binding) ||
        meta.binding.binding_version !== 1 ||
        meta.projectionProof !== undefined ||
        !legacyComposeAdoptionCandidateSupported(candidate)))
  ) {
    refuse();
  }
}
async function requireSelectedTopologyOwner(opts: {
  readonly ctx: Context;
  readonly selected: Anchor;
  readonly meta: SavedManifest;
  readonly custom: boolean;
  readonly plural: boolean;
  readonly requiresV5: boolean;
  readonly branch: boolean;
  readonly preparing: boolean;
}) {
  const { ctx, selected, meta, custom, plural, requiresV5, preparing, branch } =
    opts;
  if (!isRecord(meta.binding)) {
    refuse();
  }
  const bridgeOnly = custom && !requiresV5;
  const healthOnly = !(custom || plural) && requiresV5;
  const bridgeAndHealth = custom && requiresV5;
  if (
    (meta.adoption_generation_version === 6) !== bridgeOnly ||
    (meta.adoption_generation_version === 11) !== plural ||
    (meta.adoption_generation_version === 5) !== healthOnly ||
    (meta.adoption_generation_version === 10) !== bridgeAndHealth ||
    (meta.adoption_generation_version === 13) !== branch ||
    (branch &&
      (custom ||
        plural ||
        requiresV5 ||
        meta.binding.binding_version !== 13)) ||
    (!branch && meta.binding.binding_version === 13) ||
    (plural && requiresV5) ||
    (custom && plural) ||
    (custom &&
      (meta.binding.binding_version !== 3 ||
        meta.projectionProof !== undefined)) ||
    (plural &&
      (meta.binding.binding_version !== 5 ||
        meta.projectionProof !== undefined)) ||
    (!custom &&
      (meta.binding.binding_version === 3 ||
        meta.binding.binding_version === 4)) ||
    (meta.adoption_generation_version === 9 &&
      (meta.binding.binding_version !== 1 ||
        meta.projectionProof !== undefined ||
        requiresV5)) ||
    (!plural &&
      (meta.binding.binding_version === 5 ||
        meta.binding.binding_version === 6)) ||
    (meta.adoption_generation_version === 14) !==
      (meta.binding.binding_version === 14) ||
    (meta.adoption_generation_version === 14 &&
      (custom ||
        plural ||
        requiresV5 ||
        !meta.routingClaims ||
        meta.routingClaims.generationIdentity !== selected.id)) ||
    (meta.adoption_generation_version === 12) !==
      (meta.binding.binding_version === 12) ||
    (meta.adoption_generation_version === 12 &&
      (meta.projectionProof !== undefined || custom || plural || requiresV5))
  ) {
    refuse();
  }
  if (preparing) {
    return;
  }
  const state = await publicationState(ctx);
  if (
    (state.adoption_receipt_version === 6) !== bridgeOnly ||
    (state.adoption_receipt_version === 11) !== plural ||
    (state.adoption_receipt_version === 5) !== healthOnly ||
    (state.adoption_receipt_version === 10) !== bridgeAndHealth ||
    (state.adoption_receipt_version === 13) !== branch ||
    (state.adoption_receipt_version === 9) !==
      (meta.adoption_generation_version === 9) ||
    (state.adoption_receipt_version === 14) !==
      (meta.adoption_generation_version === 14) ||
    (state.adoption_receipt_version === 12) !==
      (meta.adoption_generation_version === 12) ||
    JSON.stringify(state.prepared) !== JSON.stringify(selected)
  ) {
    refuse();
  }
}
function retainedRoutingIntent(input: {
  readonly configText: string;
  readonly composeText: string;
}): LegacyComposeRoutingIntent {
  const mapped = mapLegacyComposeRouting({
    config: parseImportDocument({ text: input.configText, document: "config" })
      .value,
    compose: parseImportDocument({
      text: input.composeText,
      document: "compose",
    }).value,
  });
  return mapped?.intent ?? refuse();
}
function openRetainedRoutingClaims(
  ctx: Context,
  generation: string,
  binding: LegacyComposeVerifiedBinding
): Promise<NativeComposeRouteClaims> {
  if (binding.binding_version !== 14) {
    refuse();
  }
  return openNativeComposeRouteClaims({
    root: ctx.routingRoot,
    binding: {
      engineId: binding.engineId,
      proxyId: binding.routing.ingress.proxyId,
      networkId: binding.routing.ingress.networkId,
    },
    owner: { composeProject: binding.composeProject, ownerToken: generation },
  });
}
function requireRetainedClaimContext(opts: {
  readonly inputs: PrivateInputs;
  readonly generation: string;
  readonly claim: Parameters<
    Parameters<NativeComposeRouteClaims["release"]>[0]["assertAbsent"]
  >[0];
  readonly handoff?: true;
}): void {
  const binding = opts.inputs.binding;
  const names = retainedRoutingIntent(opts.inputs)
    .routes.flatMap((route) =>
      route.origins.map((origin) => new URL(origin).hostname)
    )
    .sort();
  if (
    binding.binding_version !== 14 ||
    (opts.handoff
      ? opts.claim.hostnames.some((hostname) => !names.includes(hostname))
      : JSON.stringify([...opts.claim.hostnames].sort()) !==
        JSON.stringify(names)) ||
    opts.claim.binding.engineId !== binding.engineId ||
    opts.claim.binding.proxyId !== binding.routing.ingress.proxyId ||
    opts.claim.binding.networkId !== binding.routing.ingress.networkId ||
    opts.claim.owner.composeProject !== binding.composeProject ||
    opts.claim.owner.ownerToken !== opts.generation
  ) {
    refuse();
  }
}
async function assertRetainedRouteState(
  ctx: Context,
  loaded: Awaited<ReturnType<typeof readInputs>>,
  phase: "active" | "stopped",
  deadline: number,
  assertOwner: (
    current: Context
  ) => Promise<Awaited<ReturnType<typeof readInputs>>>,
  entryObserved = false
): Promise<void> {
  const binding = loaded.inputs.binding;
  if (binding.binding_version !== 14 || retainedRouteObservations.has(ctx)) {
    refuse();
  }
  // Publication has just completed this full resource proof, followed only by
  // candidate admission and stopped-state reads. Recheck source/receipt authority
  // under the scoped observation; the exit still performs a full fresh binding.
  const first = entryObserved ? loaded : await assertOwner(ctx);
  if (
    first.manifest.id !== loaded.manifest.id ||
    JSON.stringify(first.inputs.binding) !== JSON.stringify(binding)
  ) {
    refuse();
  }
  const observedManifest = JSON.stringify(first.manifest);
  const current: Context = { ...ctx };
  let active = true;
  const assertActive = () => {
    cancelled(current.signal);
    if (!(active && Number.isFinite(deadline)) || Date.now() >= deadline) {
      refuse();
    }
  };
  retainedRouteObservations.set(current, {
    binding: first.inputs.binding,
    runtimeConfig: first.manifest.runtimeConfig,
    assertActive,
    assertManifest: (meta) => {
      assertActive();
      if (JSON.stringify(meta) !== observedManifest) {
        refuse();
      }
    },
  });
  try {
    if (entryObserved) {
      await assertOwner(current);
      assertActive();
    }
    await assertLegacyComposeRetainedRoutingState({
      binding,
      routing: retainedRoutingIntent(loaded.inputs),
      proof: binding.routing,
      phase,
      signal: current.signal,
      timeoutMs: current.timeoutMs,
      deadline,
      assertOwner: async () => {
        assertActive();
        await assertOwner(current);
        assertActive();
      },
    });
  } finally {
    active = false;
  }
  // The original context performs a complete fresh binding/runtime proof again,
  // including foreign resources, final volumes and inventories, before success.
  await assertOwner(ctx);
}
function selectedMapper(routing: boolean, basic: boolean) {
  if (routing) {
    return mapLegacyNativeRetainedRouting;
  }
  if (basic) {
    return mapLegacyNativeRetainedBasicBuild;
  }
  return mapLegacyNativeStorageAdoption;
}
function selectedPlanner(routing: boolean, basic: boolean) {
  if (routing) {
    return planLegacyComposeRetainedRoutingAdoption;
  }
  if (basic) {
    return planLegacyComposeRetainedBasicBuildAdoption;
  }
  return planLegacyComposeAdoption;
}
async function readInputs(
  ctx: Context,
  selected: Anchor,
  preparing = false
): Promise<{
  readonly manifest: Manifest;
  readonly inputs: Readonly<PrivateInputs>;
}> {
  const observation = retainedRouteObservations.get(ctx);
  observation?.assertActive();
  await ctx.check();
  const generationRoot = join(ctx.generationsRoot, selected.id);
  const held = await holdDirectory(generationRoot, true);
  let sourceBindLease:
    | Awaited<ReturnType<typeof holdSavedLegacyComposeSourceBind>>
    | undefined;
  try {
    const saved = await json(join(generationRoot, "manifest.json"));
    if (
      !sameFile(saved.info, selected.manifest) ||
      hash(saved.text) !== selected.manifest.hash
    ) {
      refuse();
    }
    const meta = manifest(saved.value, ctx.root, selected.id);
    observation?.assertManifest(meta);
    if (
      ctx.requestedBranch !== undefined &&
      meta.adoption_generation_version !== 13
    ) {
      refuse();
    }
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
    const basic = meta.adoption_generation_version === 9;
    const routing = meta.adoption_generation_version === 14;
    if (routing && meta.routingRoot !== ctx.routingRoot) {
      refuse();
    }
    const sourceBind = meta.adoption_generation_version === 12;
    const selectedBranch =
      meta.adoption_generation_version === 13
        ? await acquireLegacyComposeBranch({
            root: ctx.root,
            configText,
            composeText,
            requestedBranch: ctx.requestedBranch,
            saved: meta.branchProof,
            signal: ctx.signal,
          })
        : null;
    if ((meta.adoption_generation_version === 13) !== Boolean(selectedBranch)) {
      refuse();
    }
    let mapper = selectedMapper(routing, basic);
    let planner = selectedPlanner(routing, basic);
    if (sourceBind) {
      mapper = mapLegacyNativeRetainedSourceBind;
      planner = planLegacyComposeSourceBindAdoption;
    } else if (basic) {
      mapper = mapLegacyNativeRetainedBasicBuild;
      planner = planLegacyComposeRetainedBasicBuildAdoption;
    } else if (selectedBranch) {
      mapper = mapLegacyNativeBranchStorageAdoption;
    }
    const mapped = mapper({ configText, composeText });
    const planned = planner({
      configText,
      composeText,
      selectedComposeProject: selectedBranch?.proof.composeProject,
    });
    const assertBuildSource = () =>
      assertRetainedBuildSource({ ctx, meta, configText, composeText });
    await assertBuildSource();
    if (sourceBind) {
      sourceBindLease = await holdSavedLegacyComposeSourceBind({
        projectRoot: ctx.root,
        configText,
        composeText,
        proof: meta.sourceBindProof,
        signal: ctx.signal,
      });
    }
    const retainedPlan = legacyComposeRetainedPlan(JSON.parse(candidateText));
    await requireSelectedTopologyOwner({
      ctx,
      selected,
      meta,
      custom: planned.intent?.ownedNetwork !== undefined,
      plural: planned.intent?.ownedNetworks !== undefined,
      requiresV5: retainedPlan.requiresV5 && !retainedPlan.requiresV7,
      branch: Boolean(selectedBranch),
      preparing,
    });
    const projectionOpts = {
      projectRoot: ctx.root,
      configText,
      composeText,
      proof: meta.projectionProof,
      signal: ctx.signal,
      checkOwner: ctx.check,
    };
    const projection =
      (meta.adoption_generation_version === 5 &&
        meta.projectionProof !== undefined) ||
      meta.adoption_generation_version === 14 ||
      meta.adoption_generation_version === 3 ||
      meta.adoption_generation_version === 4
        ? await readSavedLegacyComposeAdoptionProjection(projectionOpts)
        : undefined;
    if (
      !(
        mapped.candidate &&
        planned.intent &&
        candidateText ===
          JSON.stringify(projection?.candidate ?? mapped.candidate)
      )
    ) {
      refuse();
    }
    requireRetainedGenerationVersion(
      meta,
      retainedPlan,
      JSON.parse(candidateText)
    );
    if (!preparing) {
      const currentReceipt = await publicationState(ctx);
      if (
        (meta.adoption_generation_version === 5) !==
          (currentReceipt.adoption_receipt_version === 5) ||
        (meta.adoption_generation_version === 7) !==
          (currentReceipt.adoption_receipt_version === 7)
      ) {
        refuse();
      }
    }
    const inspection = {
      root: ctx.root,
      intent: planned.intent,
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
      composeFiles: projection?.composeFiles,
      ...(selectedBranch
        ? {
            composeFiles: selectedBranch.composeFiles,
            selectedBranch: selectedBranch.proof.branch,
          }
        : {}),
    };
    let observed: LegacyComposeVerifiedBinding;
    if (observation) {
      observed = observation.binding;
    } else if (sourceBind && "sourceBinds" in planned.intent) {
      observed = await inspectLegacyComposeSourceBindResources({
        ...inspection,
        intent: planned.intent,
      });
    } else {
      observed = await inspectLegacyComposeAdoptionResources(inspection);
    }
    if (JSON.stringify(meta.binding) !== JSON.stringify(observed)) {
      refuse("E_LEGACY_ADOPTION_CHANGED");
    }
    if (routing) {
      if (!meta.routingClaims || observed.binding_version !== 14) {
        refuse();
      }
      const claims = await openRetainedRoutingClaims(
        ctx,
        selected.id,
        observed
      );
      try {
        const attempt = await claims.reopen(meta.routingClaims);
        if (
          attempt.reference.generationIdentity !== selected.id ||
          JSON.stringify(attempt.hostnames) !==
            JSON.stringify(
              retainedRoutingIntent({ configText, composeText })
                .routes.flatMap((route) =>
                  route.origins.map((origin) => new URL(origin).hostname)
                )
                .sort()
            )
        ) {
          refuse();
        }
        const current = preparing ? undefined : await publicationState(ctx);
        if (current?.routingHandoff !== "releasing") {
          await claims.assertHeld(meta.routingClaims);
        }
      } finally {
        await claims.close();
      }
    }
    const runtimeConfig = observation
      ? observation.runtimeConfig
      : await inspectLegacyComposeRuntimeConfig({
          binding: observed,
          composeFile: join(generationRoot, "legacy-compose.yml"),
          signal: ctx.signal,
          timeoutMs: ctx.timeoutMs,
        });
    if (JSON.stringify(meta.runtimeConfig) !== JSON.stringify(runtimeConfig)) {
      refuse("E_LEGACY_ADOPTION_CHANGED");
    }
    if (
      basic &&
      JSON.stringify(
        await inspectLegacyComposeRetainedBuildImages({
          binding: observed,
          composeFile: join(generationRoot, "legacy-compose.yml"),
          signal: ctx.signal,
          timeoutMs: ctx.timeoutMs,
        })
      ) !== JSON.stringify(meta.buildProof?.images)
    ) {
      refuse("E_LEGACY_ADOPTION_CHANGED");
    }
    await readArtifact(
      join(generationRoot, "manifest.json"),
      selected.manifest,
      STATE_LIMIT
    );
    await readArtifact(
      join(generationRoot, "legacy-config.json"),
      meta.files.config
    );
    await readArtifact(
      join(generationRoot, "legacy-compose.yml"),
      meta.files.compose
    );
    await readArtifact(
      join(generationRoot, "candidate.json"),
      meta.files.candidate
    );
    await recheckDirectories([held]);
    if (projection) {
      await readSavedLegacyComposeAdoptionProjection(projectionOpts);
    }
    if (selectedBranch) {
      await acquireLegacyComposeBranch({
        root: ctx.root,
        configText,
        composeText,
        requestedBranch: ctx.requestedBranch,
        saved: selectedBranch.proof,
        signal: ctx.signal,
      });
    }
    await assertBuildSource();
    await ctx.check();
    await sourceBindLease?.assertFresh();
    if (sourceBindLease) {
      const previous = ctx.sourceBind.current;
      ctx.sourceBind.current = { generation: selected, lease: sourceBindLease };
      sourceBindLease = undefined;
      await previous?.lease.close();
      // Mounted identities remain part of the outer owner, including later
      // receipt, compiler and source awaits before a callback or publication.
      await ctx.check();
    }
    observation?.assertManifest(meta);
    freezeImportValue(observed);
    return {
      manifest: { ...meta, binding: observed },
      inputs: privateResult({
        configText,
        composeText,
        candidateText,
        binding: observed,
        ...(projection ? { projectionMetadata: projection.metadata } : {}),
        ...(basic ? { retainedBuild: true as const } : {}),
        ...(routing ? { retainedRouting: true as const } : {}),
        ...(projection?.routingResolution
          ? { routingResolution: projection.routingResolution }
          : {}),
        ...(sourceBind ? { retainedSourceBind: true as const } : {}),
      }),
    };
  } finally {
    await sourceBindLease?.close();
    await held.file.close();
  }
}
async function save(
  ctx: Context,
  value: Receipt,
  expected: Receipt,
  opts?: { readonly beforeCommit: () => Promise<void> }
): Promise<Receipt> {
  await ctx.check();
  const previous = await json(ctx.receiptPath);
  receipt(previous.value, ctx.checkout);
  const snapshot = ctx.receiptSnapshots.get(expected);
  if (
    !(snapshot && sameFile(previous.info, snapshot.info)) ||
    previous.text !== snapshot.text
  ) {
    refuse();
  }
  const temporary = join(ctx.stateRoot, `${token()}.receipt`);
  await writeExclusive(temporary, JSON.stringify(value));
  const staged = await readPrivate(temporary, STATE_LIMIT);
  await ctx.check();
  const latest = await json(ctx.receiptPath);
  if (!sameFile(previous.info, latest.info) || previous.text !== latest.text) {
    refuse();
  }
  if (opts) {
    await opts.beforeCommit();
  }
  if (value.adoption_receipt_version === 14 || ctx.sourceBind.current) {
    // Both owners await fresh source proofs; preserve receipt incarnation and
    // revalidate mounted directories after that last admission boundary.
    await requireReceiptSnapshot(ctx, expected);
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
  const result = receipt(published.value, ctx.checkout);
  ctx.receiptSnapshots.set(result, published);
  return result;
}
function claim(
  selected: Anchor,
  known: WeakMap<LegacyComposeAdoptedGeneration, Anchor>,
  binding: LegacyComposeVerifiedBinding,
  status: "prepared" | "active" = "prepared",
  version: Manifest["adoption_generation_version"] = 1
): LegacyComposeAdoptedGeneration {
  const result: LegacyComposeAdoptedGeneration = {
    report: {
      adoption_generation_version: version,
      owner: "legacy-compose",
      status,
      containers: binding.containers.length,
      volumes: binding.volumes.length,
    },
  };
  freezeImportValue(result);
  known.set(result, selected);
  return result;
}
function manifestVersion(
  binding: LegacyComposeVerifiedBinding,
  requiresV5: boolean,
  projection?: {
    readonly projectionProof: { readonly projection_version: number };
  }
): Manifest["adoption_generation_version"] {
  if (binding.binding_version === 14) {
    if (requiresV5 || projection?.projectionProof.projection_version !== 3) {
      refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
    }
    return 14;
  }
  if (binding.binding_version === 12) {
    refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
  }
  if (binding.binding_version === 13) {
    if (requiresV5 || projection) {
      refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
    }
    return 13;
  }
  if (binding.binding_version === 5) {
    if (requiresV5 || projection) {
      refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
    }
    return 11;
  }
  if (binding.binding_version === 6) {
    refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
  }
  if (binding.binding_version === 3) {
    return requiresV5 ? 10 : 6;
  }
  if (requiresV5) {
    if (binding.binding_version === 4) {
      refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
    }
    return 5;
  }
  if (binding.binding_version === 4) {
    refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
  }
  if (!projection) {
    return 1;
  }
  return projection.projectionProof.projection_version === 2 ? 4 : 3;
}
function preparedManifestVersion(opts: {
  readonly build: boolean;
  readonly sourceBind: boolean;
  readonly retainedPlan: LegacyComposeRetainedPlan;
  readonly binding: LegacyComposeVerifiedBinding;
  readonly projection?: {
    readonly projectionProof: { readonly projection_version: number };
  };
}): Manifest["adoption_generation_version"] {
  if (opts.sourceBind) {
    return 12;
  }
  if (opts.build) {
    return 9;
  }
  if (opts.retainedPlan.requiresV7) {
    return 7;
  }
  return manifestVersion(
    opts.binding,
    opts.retainedPlan.requiresV5,
    opts.projection
  );
}
async function prepare(
  ctx: Context,
  binary: string | undefined
): Promise<Anchor> {
  const binding = await acquireLegacyComposeAdoptionPreparationBinding({
    projectRoot: ctx.root,
    requestedBranch: ctx.requestedBranch,
    signal: ctx.signal,
    timeoutMs: ctx.timeoutMs,
    binary,
  });
  const acquired = await binding.resolvePreparationInputs({
    projectRoot: ctx.root,
    signal: ctx.signal,
  });
  // Versions 6, 10 and 11 require static authored bridges. Projected source
  // combinations need a separate selected owner, never a binding alias.
  if (
    acquired.binding.binding_version === 4 ||
    acquired.binding.binding_version === 6 ||
    (acquired.binding.binding_version === 13 &&
      (!acquired.branch ||
        acquired.build ||
        acquired.sourceBindProof ||
        acquired.projection)) ||
    ((acquired.binding.binding_version === 3 ||
      acquired.binding.binding_version === 5) &&
      acquired.projection)
  ) {
    refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
  }
  let mapper = selectedMapper(
    acquired.binding.binding_version === 14,
    Boolean(acquired.build)
  );
  if (acquired.sourceBindProof) {
    mapper = mapLegacyNativeRetainedSourceBind;
  } else if (acquired.build) {
    mapper = mapLegacyNativeRetainedBasicBuild;
  } else if (acquired.branch) {
    mapper = mapLegacyNativeBranchStorageAdoption;
  }
  const mapped = mapper(acquired);
  if (!mapped.candidate) {
    refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
  }
  const candidateText = JSON.stringify(
    acquired.projection?.candidate ?? mapped.candidate
  );
  const retainedPlan = legacyComposeRetainedPlan(JSON.parse(candidateText));
  if (
    (acquired.sourceBindProof &&
      (acquired.binding.binding_version !== 12 ||
        acquired.projection !== undefined ||
        acquired.build ||
        acquired.branch ||
        retainedPlan.requiresV5 ||
        retainedPlan.requiresV7)) ||
    (acquired.build &&
      (acquired.binding.binding_version !== 1 ||
        acquired.projection !== undefined ||
        retainedPlan.requiresV5 ||
        retainedPlan.requiresV7)) ||
    (retainedPlan.requiresV7 &&
      (acquired.projection ||
        acquired.binding.binding_version !== 1 ||
        !legacyComposeAdoptionCandidateSupported(JSON.parse(candidateText))))
  ) {
    refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
  }
  if (acquired.binding.binding_version === 5 && retainedPlan.requiresV5) {
    refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
  }
  if (acquired.branch && (retainedPlan.requiresV5 || retainedPlan.requiresV7)) {
    refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
  }
  const admitted = await admitLegacyComposeCandidate({
    candidateText,
    metadata: acquired.projection?.metadata,
    binary,
    signal: ctx.signal,
  });
  if (!admitted) {
    refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
  }
  await binding.assertFresh({ projectRoot: ctx.root, signal: ctx.signal });
  await ctx.check();
  const id = token();
  const generationRoot = join(ctx.generationsRoot, id);
  await mkdir(generationRoot, { mode: 0o700 });
  const held = await holdDirectory(generationRoot, true);
  let routeClaims: NativeComposeRouteClaims | undefined;
  let routeAttempt: NativeComposeRouteAttempt | undefined;
  let prepared = false;
  try {
    if (acquired.binding.binding_version === 14) {
      routeClaims = await openRetainedRoutingClaims(ctx, id, acquired.binding);
      routeAttempt = await routeClaims.acquire({
        generationIdentity: id,
        hostnames: retainedRoutingIntent(acquired).routes.flatMap((route) =>
          route.origins.map((origin) => new URL(origin).hostname)
        ),
      });
    }
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
    const originals = await privateDirectory(join(generationRoot, "originals"));
    await originals.file.sync();
    await originals.file.close();
    const meta: Manifest = {
      adoption_generation_version: preparedManifestVersion({
        build: Boolean(acquired.build),
        sourceBind: Boolean(acquired.sourceBindProof),
        retainedPlan,
        binding: acquired.binding,
        projection: acquired.projection,
      }),
      kind: KIND,
      projectRoot: ctx.root,
      id,
      binding: acquired.binding,
      ...(routeAttempt
        ? {
            routingClaims: routeAttempt.reference,
            routingRoot: ctx.routingRoot,
          }
        : {}),
      ...(acquired.branch ? { branchProof: acquired.branch } : {}),
      ...(acquired.build ? { buildProof: acquired.build } : {}),
      ...(acquired.sourceBindProof
        ? { sourceBindProof: acquired.sourceBindProof }
        : {}),
      ...(acquired.projection
        ? { projectionProof: acquired.projection.projectionProof }
        : {}),
      runtimeConfig: await inspectLegacyComposeRuntimeConfig({
        binding: acquired.binding,
        composeFile: join(generationRoot, "legacy-compose.yml"),
        signal: ctx.signal,
        timeoutMs: ctx.timeoutMs,
      }),
      sourceFiles: acquired.sourceFiles,
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
    if (routeAttempt) {
      await routeClaims?.assertHeld(routeAttempt.reference);
      await binding.assertFresh({ projectRoot: ctx.root, signal: ctx.signal });
      await ctx.check();
    }
    prepared = true;
    return { id, manifest: { ...fileIdentity(written), hash: hash(text) } };
  } finally {
    try {
      try {
        if (!prepared && routeAttempt) {
          await routeClaims?.rollback(routeAttempt);
        }
      } finally {
        await routeClaims?.close();
      }
    } finally {
      await held.file.close();
    }
  }
}

async function publicationState(ctx: Context) {
  await ctx.check();
  const read = await json(ctx.receiptPath);
  const state = receipt(read.value, ctx.checkout);
  ctx.receiptSnapshots.set(state, read);
  return state;
}
function pending(state: Receipt) {
  return (
    state.publication?.phase === "switching" ||
    state.publication?.phase === "rolling-back"
  );
}
function requireStablePublication(state: Receipt) {
  if (pending(state)) {
    refuse("E_LEGACY_ADOPTION_BUSY");
  }
}
function requireNoPendingOperation(state: Receipt) {
  if (state.pendingOperation !== null) {
    refuse("E_LEGACY_ADOPTION_BUSY");
  }
}
function validateMutationSelection(
  state: Receipt,
  captured: {
    readonly operation: AdoptionOperation;
    readonly services: readonly string[];
    readonly recover?: boolean;
  },
  services: readonly string[]
) {
  if (
    !(
      ["start", "restart", "stop"].includes(captured.operation) &&
      captured.services.length
    ) ||
    new Set(captured.services).size !== captured.services.length ||
    captured.services.some((service) => !services.includes(service))
  ) {
    refuse();
  }
  if (captured.recover) {
    if (
      !state.pendingOperation ||
      captured.operation !== "stop" ||
      JSON.stringify([...captured.services].sort()) !==
        JSON.stringify([...services].sort())
    ) {
      refuse();
    }
  } else {
    requireNoPendingOperation(state);
  }
}
async function requireReceiptSnapshot(ctx: Context, state: Receipt) {
  const expected = ctx.receiptSnapshots.get(state),
    current = await json(ctx.receiptPath);
  if (
    !(expected && sameFile(expected.info, current.info)) ||
    expected.text !== current.text
  ) {
    refuse();
  }
  await ctx.check();
}
async function absent(path: string) {
  try {
    await lstat(path);
    return false;
  } catch (error: unknown) {
    if (hasCode(error, "ENOENT")) {
      return true;
    }
    throw error;
  }
}
async function requireFirstSliceLayout(ctx: Context, input: PrivateInputs) {
  if (input.projectionMetadata) {
    // readInputs has already verified the complete saved source/managed/generated proof.
    return;
  }
  if (
    !(await legacyComposeAdoptionLayoutSupported({
      projectRoot: ctx.root,
      candidate: JSON.parse(input.candidateText),
      signal: ctx.signal,
    }))
  ) {
    refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
  }
}
async function requireStopped(
  ctx: Context,
  binding: LegacyComposeVerifiedBinding
) {
  const states = await inspectLegacyComposeContainerStates({
    binding,
    signal: ctx.signal,
    timeoutMs: ctx.timeoutMs,
  });
  if (
    states.some(
      (state) =>
        state.running ||
        state.paused ||
        !["created", "exited"].includes(state.status)
    )
  ) {
    refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
  }
}
async function admitCandidate(
  ctx: Context,
  input: PrivateInputs,
  binary?: string
) {
  const candidate: unknown = JSON.parse(input.candidateText);
  if (!legacyComposeAdoptionCandidateSupported(candidate)) {
    refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
  }
  const admitted = await admitLegacyComposeCandidate({
    candidateText: input.candidateText,
    metadata: input.projectionMetadata,
    binary,
    signal: ctx.signal,
  });
  if (!admitted) {
    refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
  }
}
function originalLocations(
  ctx: Context,
  selected: Pick<Anchor, "id">,
  meta: SavedManifest,
  input: PrivateInputs
) {
  const holding = join(ctx.generationsRoot, selected.id, "originals");
  return [
    {
      active: join(ctx.root, ".hack/hack.config.json"),
      held: join(holding, "legacy-config.original"),
      info: meta.sourceFiles.config,
      text: input.configText,
    },
    {
      active: join(ctx.root, ".hack/docker-compose.yml"),
      held: join(holding, "legacy-compose.original"),
      info: meta.sourceFiles.compose,
      text: input.composeText,
    },
  ];
}
type OriginalLocation = ReturnType<typeof originalLocations>[number];
function sourceMatches(
  read: { readonly info: Stats; readonly bytes: Uint8Array },
  location: OriginalLocation,
  strict: boolean
) {
  const info = read.info,
    expected = location.info;
  return (
    sameFile(info, expected) &&
    info.mode === expected.mode &&
    info.uid === expected.uid &&
    info.size === expected.size &&
    info.mtimeMs === expected.mtimeMs &&
    (!strict || info.ctimeMs === expected.ctimeMs) &&
    new TextDecoder("utf-8", { fatal: true }).decode(read.bytes) ===
      location.text
  );
}
async function requireOriginal(
  ctx: Context,
  path: string,
  location: OriginalLocation,
  strict = false
) {
  const read = await readNativeConfigImportSourceFile({
    path,
    signal: ctx.signal,
  });
  if (!sourceMatches(read, location, strict)) {
    refuse("E_LEGACY_ADOPTION_CHANGED");
  }
}
async function holdOriginal(ctx: Context, location: OriginalLocation) {
  const activeAbsent = await absent(location.active),
    heldAbsent = await absent(location.held);
  if (activeAbsent && !heldAbsent) {
    await requireOriginal(ctx, location.held, location);
    return;
  }
  if (activeAbsent || !heldAbsent) {
    refuse("E_LEGACY_ADOPTION_CHANGED");
  }
  await requireOriginal(ctx, location.active, location, true);
  await ctx.check();
  await rename(location.active, location.held);
  await requireOriginal(ctx, location.held, location);
}
async function restoreOriginal(
  ctx: Context,
  location: OriginalLocation,
  holding: HeldDirectory
) {
  const activeAbsent = await absent(location.active),
    heldAbsent = await absent(location.held);
  if (!activeAbsent && heldAbsent) {
    await requireOriginal(ctx, location.active, location);
    return;
  }
  if (heldAbsent) {
    refuse("E_LEGACY_ADOPTION_CHANGED");
  }
  if (activeAbsent) {
    await requireOriginal(ctx, location.held, location);
    await ctx.check();
    await link(location.held, location.active);
    const pair = await readNativeConfigImportSourceLinkPair({
      left: location.active,
      right: location.held,
      signal: ctx.signal,
    });
    if (!sourceMatches(pair, location, false)) {
      refuse("E_LEGACY_ADOPTION_CHANGED");
    }
  } else {
    const pair = await readNativeConfigImportSourceLinkPair({
      left: location.active,
      right: location.held,
      signal: ctx.signal,
    });
    if (!sourceMatches(pair, location, false)) {
      refuse("E_LEGACY_ADOPTION_CHANGED");
    }
  }
  await ctx.directories[1]?.file.sync();
  await ctx.check();
  await unlink(location.held);
  await holding.file.sync();
  await requireOriginal(ctx, location.active, location);
}
async function requireActiveCandidate(
  ctx: Context,
  publication: Publication,
  input: PrivateInputs
) {
  if (
    !publication.native ||
    publication.native.hash !== hash(input.candidateText)
  ) {
    refuse();
  }
  await readArtifact(
    join(ctx.root, ".hack/hack.project.json"),
    publication.native
  );
  for (const relative of [
    ".hack/hack.config.json",
    ".hack/docker-compose.yml",
  ]) {
    if (!(await absent(join(ctx.root, relative)))) {
      refuse("E_LEGACY_ADOPTION_CHANGED");
    }
  }
}
async function installCandidate(
  ctx: Context,
  selected: Anchor,
  input: PrivateInputs,
  expected: Artifact | null
): Promise<Artifact> {
  const staged = join(
    ctx.generationsRoot,
    selected.id,
    "originals/native.publish"
  );
  const active = join(ctx.root, ".hack/hack.project.json");
  if (await absent(staged)) {
    if (!(await absent(active))) {
      if (!expected || expected.hash !== hash(input.candidateText)) {
        refuse("E_LEGACY_ADOPTION_CHANGED");
      }
      await readArtifact(active, expected);
      return expected;
    }
    await writeExclusive(staged, input.candidateText);
  }
  if (await absent(active)) {
    const source = await readPrivate(staged, NATIVE_CONFIG_INPUT_LIMIT);
    if (source.text !== input.candidateText) {
      refuse();
    }
    await ctx.check();
    await link(staged, active);
  }
  const pair = await readNativeConfigImportSourceLinkPair({
    left: active,
    right: staged,
    signal: ctx.signal,
  });
  if (
    new TextDecoder("utf-8", { fatal: true }).decode(pair.bytes) !==
      input.candidateText ||
    (pair.info.mode & 0o777) !== 0o600
  ) {
    refuse();
  }
  const installed = {
    ...fileIdentity(pair.info),
    hash: hash(input.candidateText),
  };
  if (expected && JSON.stringify(installed) !== JSON.stringify(expected)) {
    refuse();
  }
  return installed;
}
async function finishCandidatePublication(
  ctx: Context,
  selected: Anchor,
  native: Artifact
) {
  const active = join(ctx.root, ".hack/hack.project.json"),
    staged = join(ctx.generationsRoot, selected.id, "originals/native.publish");
  if (await absent(staged)) {
    await readArtifact(active, native);
    return;
  }
  const pair = await readNativeConfigImportSourceLinkPair({
    left: active,
    right: staged,
    signal: ctx.signal,
  });
  if (
    !sameFile(pair.info, native) ||
    hash(new TextDecoder("utf-8", { fatal: true }).decode(pair.bytes)) !==
      native.hash ||
    (pair.info.mode & 0o777) !== 0o600
  ) {
    refuse();
  }
  await ctx.check();
  await unlink(staged);
  await readArtifact(active, native);
}
async function finishArchivedCandidate(
  ctx: Context,
  held: string,
  staged: string,
  native: Artifact
) {
  if (!(await absent(staged))) {
    const pair = await readNativeConfigImportSourceLinkPair({
      left: held,
      right: staged,
      signal: ctx.signal,
    });
    if (
      !sameFile(pair.info, native) ||
      hash(new TextDecoder("utf-8", { fatal: true }).decode(pair.bytes)) !==
        native.hash
    ) {
      refuse();
    }
    await ctx.check();
    await unlink(staged);
  }
  await readArtifact(held, native);
}
async function archiveCandidate(
  ctx: Context,
  selected: Anchor,
  publication: Publication,
  input: PrivateInputs
) {
  const active = join(ctx.root, ".hack/hack.project.json"),
    held = join(ctx.generationsRoot, selected.id, "originals/native.rollback");
  if (await absent(active)) {
    if (publication.native !== null) {
      const staged = join(
        ctx.generationsRoot,
        selected.id,
        "originals/native.publish"
      );
      await finishArchivedCandidate(ctx, held, staged, publication.native);
    }
    return;
  }
  if (!(await absent(held))) {
    refuse("E_LEGACY_ADOPTION_CHANGED");
  }
  const staged = join(
    ctx.generationsRoot,
    selected.id,
    "originals/native.publish"
  );
  if (!(await absent(staged))) {
    const pair = await readNativeConfigImportSourceLinkPair({
      left: active,
      right: staged,
      signal: ctx.signal,
    });
    if (
      new TextDecoder("utf-8", { fatal: true }).decode(pair.bytes) !==
        input.candidateText ||
      (publication.native !== null && !sameFile(pair.info, publication.native))
    ) {
      refuse();
    }
  } else if (publication.native) {
    await readArtifact(active, publication.native);
  } else {
    refuse();
  }
  await ctx.check();
  await rename(active, held);
  if (!(await absent(staged))) {
    await ctx.check();
    await unlink(staged);
  }
  if (publication.native) {
    await readArtifact(held, publication.native);
  }
}
async function completePublication(
  ctx: Context,
  state: Receipt,
  binary?: string
) {
  let stage: LegacyComposePublicationRefusal["stage"] = "publication-state";
  try {
    const publication = state.publication;
    if (!publication || publication.phase !== "switching") {
      refuse();
    }
    if (
      state.adoption_receipt_version === 14 &&
      state.routingHandoff !== "held"
    ) {
      refuse();
    }
    const routingDeadline =
      Date.now() + Math.min(ctx.timeoutMs ?? 15_000, 60_000);
    stage = "publication-inputs";
    const loaded = await readInputs(ctx, publication.generation);
    stage = "publication-layout";
    await requireFirstSliceLayout(ctx, loaded.inputs);
    stage = "publication-compiler";
    await admitCandidate(ctx, loaded.inputs, binary);
    stage = "publication-stopped";
    await requireStopped(ctx, loaded.inputs.binding);
    stage = "publication-routing";
    await assertPublicationRoutingStopped(
      ctx,
      loaded,
      state,
      routingDeadline,
      false,
      true
    );
    stage = "publication-originals-directory";
    const held = await holdDirectory(
      join(ctx.generationsRoot, publication.generation.id, "originals"),
      true
    );
    const transaction: Context = {
      ...ctx,
      check: async () => {
        await ctx.check();
        await recheckDirectories([held]);
        await ctx.sourceBind.current?.lease.assertDirectoriesFresh({
          signal: ctx.signal,
        });
      },
    };
    try {
      stage = "publication-hold-original";
      for (const location of originalLocations(
        transaction,
        publication.generation,
        loaded.manifest,
        loaded.inputs
      )) {
        await holdOriginal(transaction, location);
        await held.file.sync();
        await transaction.directories[1]?.file.sync();
      }
      stage = "publication-install-native";
      const native = await installCandidate(
        transaction,
        publication.generation,
        loaded.inputs,
        publication.native
      );
      const installed: Publication = { ...publication, native };
      stage = "publication-sync";
      await held.file.sync();
      await transaction.directories[1]?.file.sync();
      let current = state;
      if (publication.native === null) {
        stage = "publication-save-native";
        current = await save(
          transaction,
          { ...state, publication: installed },
          state
        );
      }
      stage = "publication-finish-native";
      await finishCandidatePublication(
        transaction,
        publication.generation,
        native
      );
      stage = "publication-active-candidate";
      await requireActiveCandidate(transaction, installed, loaded.inputs);
      stage = "publication-sync";
      await held.file.sync();
      await transaction.directories[1]?.file.sync();
      stage = "publication-final-inputs";
      await readInputs(transaction, publication.generation);
      stage = "publication-final-stopped";
      await requireStopped(transaction, loaded.inputs.binding);
      stage = "publication-final-directories";
      await recheckDirectories([held]);
      stage = "publication-save-active";
      await save(
        transaction,
        {
          ...current,
          publication: { ...installed, phase: "active" },
        },
        current,
        loaded.inputs.retainedRouting
          ? {
              beforeCommit: () =>
                assertPublicationRoutingStopped(
                  transaction,
                  loaded,
                  current,
                  routingDeadline
                ),
            }
          : undefined
      );
    } finally {
      const bodyStage = stage;
      stage = "publication-close-originals";
      await held.file.close();
      stage = bodyStage;
    }
  } catch (error: unknown) {
    recordPublicationRefusal(error, stage);
    throw error;
  }
}
async function completeRollback(ctx: Context, state: Receipt) {
  let publication = state.publication;
  if (!publication || publication.phase !== "rolling-back") {
    refuse();
  }
  const routingDeadline =
    Date.now() + Math.min(ctx.timeoutMs ?? 15_000, 60_000);
  const loaded = await readInputs(ctx, publication.generation);
  await requireStopped(ctx, loaded.inputs.binding);
  const held = await holdDirectory(
    join(ctx.generationsRoot, publication.generation.id, "originals"),
    true
  );
  const transaction: Context = {
    ...ctx,
    check: async () => {
      await ctx.check();
      await recheckDirectories([held]);
      await ctx.sourceBind.current?.lease.assertDirectoriesFresh({
        signal: ctx.signal,
      });
    },
  };
  try {
    let current = state;
    if (
      publication.native === null &&
      !(await absent(join(transaction.root, ".hack/hack.project.json")))
    ) {
      const native = await installCandidate(
        transaction,
        publication.generation,
        loaded.inputs,
        null
      );
      publication = { ...publication, native };
      current = await save(transaction, { ...state, publication }, state);
    }
    await archiveCandidate(
      transaction,
      publication.generation,
      publication,
      loaded.inputs
    );
    await held.file.sync();
    await transaction.directories[1]?.file.sync();
    for (const location of originalLocations(
      transaction,
      publication.generation,
      loaded.manifest,
      loaded.inputs
    )) {
      await restoreOriginal(transaction, location, held);
      await held.file.sync();
      await transaction.directories[1]?.file.sync();
    }
    if (!(await absent(join(transaction.root, ".hack/hack.project.json")))) {
      refuse();
    }
    await readInputs(transaction, publication.generation);
    await requireStopped(transaction, loaded.inputs.binding);
    await recheckDirectories([held]);
    if (loaded.inputs.retainedRouting) {
      await assertPublicationRoutingStopped(
        transaction,
        loaded,
        current,
        routingDeadline,
        true
      );
      if (current.routingHandoff !== "releasing") {
        current = await save(
          transaction,
          { ...current, routingHandoff: "releasing" },
          current,
          {
            beforeCommit: () =>
              assertPublicationRoutingStopped(
                transaction,
                loaded,
                current,
                routingDeadline,
                true
              ),
          }
        );
      }
      const routingGeneration = publication.generation.id;
      const claims = await openRetainedRoutingClaims(
        transaction,
        routingGeneration,
        loaded.inputs.binding
      );
      try {
        await claims.releaseRetained({
          assertStoppedAndRestored: async (claim) => {
            requireRetainedClaimContext({
              inputs: loaded.inputs,
              generation: routingGeneration,
              claim,
              handoff: true,
            });
            await assertPublicationRoutingStopped(
              transaction,
              loaded,
              current,
              routingDeadline,
              true
            );
          },
        });
      } finally {
        await claims.close();
      }
    }
    await save(
      transaction,
      {
        ...current,
        publication: { ...publication, phase: "rolled-back" },
      },
      current,
      loaded.inputs.retainedRouting
        ? {
            beforeCommit: () =>
              assertPublicationRoutingStopped(
                transaction,
                loaded,
                current,
                routingDeadline,
                true
              ),
          }
        : undefined
    );
  } finally {
    await held.file.close();
  }
}

/** Retained originals remain present. This proves their stopped state and no
 * proxy route; the native ABSENT-only release boundary remains unchanged. */
async function assertPublicationRoutingStopped(
  ctx: Context,
  loaded: Awaited<ReturnType<typeof readInputs>>,
  state: Receipt,
  deadline: number,
  restored = false,
  entryObserved = false
): Promise<void> {
  if (!loaded.inputs.retainedRouting) {
    return;
  }
  if (
    state.pendingOperation !== null ||
    state.routingOperation?.disposition === "prospective"
  ) {
    refuse("E_LEGACY_ADOPTION_BUSY");
  }
  await assertRetainedRouteState(
    ctx,
    loaded,
    "stopped",
    deadline,
    async (current) => {
      const fresh = await readInputs(current, state.prepared ?? refuse());
      await requireStopped(current, fresh.inputs.binding);
      if (restored) {
        await requireRestoredRoutingSourceInputs(current, fresh);
      }
      await requireReceiptSnapshot(current, state);
      cancelled(current.signal);
      if (Date.now() >= deadline) {
        refuse();
      }
      return fresh;
    },
    entryObserved
  );
}

type MutationOptions = Parameters<
  LegacyComposeAdoptedGenerationStore["withMutation"]
>[0];
function requireMutationDeadline(
  captured: MutationOptions,
  plan: LegacyComposeRetainedPlan
) {
  if (
    (legacyComposeRetainedOrdered(plan) ||
      captured.generation.report.adoption_generation_version === 9 ||
      captured.generation.report.adoption_generation_version === 12 ||
      captured.generation.report.adoption_generation_version === 14) &&
    (captured.deadline === undefined ||
      !Number.isFinite(captured.deadline) ||
      captured.deadline <= Date.now())
  ) {
    refuse("E_LEGACY_ADOPTION_CHANGED");
  }
}

/** New proof owners share one remaining clock; old receipt owners keep their prior budgets. */
function boundedMutationContext(ctx: Context, deadline: number) {
  function remaining() {
    cancelled(ctx.signal);
    const time = Math.floor(deadline - Date.now());
    if (time <= 0) {
      refuse("E_LEGACY_ADOPTION_CHANGED");
    }
    return time;
  }
  const initialRemaining = remaining();
  const controller = new AbortController();
  const abort = () => controller.abort();
  ctx.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(abort, initialRemaining);
  const bounded: Context = {
    ...ctx,
    signal: controller.signal,
    get timeoutMs() {
      return Math.min(ctx.timeoutMs ?? 15_000, 60_000, remaining());
    },
    check: async () => {
      remaining();
      await ctx.check();
      remaining();
    },
  };
  return {
    ctx: bounded,
    dispose: () => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", abort);
    },
  };
}

function preparedReceiptVersion(
  version: Manifest["adoption_generation_version"],
  prior: Receipt,
  checkout: Checkout
): Receipt["adoption_receipt_version"] {
  if (version !== 1) {
    return version;
  }
  // A rolled-back proof owner must not label a later plain generation with its version.
  if (
    prior.adoption_receipt_version === 5 ||
    prior.adoption_receipt_version === 6 ||
    prior.adoption_receipt_version === 9 ||
    prior.adoption_receipt_version === 7 ||
    prior.adoption_receipt_version === 10 ||
    prior.adoption_receipt_version === 11 ||
    prior.adoption_receipt_version === 12 ||
    prior.adoption_receipt_version === 13 ||
    prior.adoption_receipt_version === 14
  ) {
    return "kind" in checkout.git ? 2 : 1;
  }
  return prior.adoption_receipt_version;
}
function mutationPublication(
  state: Receipt,
  owned: Anchor | undefined,
  preparationStop: boolean
): Publication | null {
  const selected = preparationStop
    ? state.prepared
    : state.publication?.generation;
  if (
    !(owned && selected) ||
    JSON.stringify(owned) !== JSON.stringify(selected)
  ) {
    refuse();
  }
  if (preparationStop) {
    if (state.publication && state.publication.phase !== "rolled-back") {
      refuse();
    }
    return null;
  }
  if (state.publication?.phase !== "active") {
    refuse();
  }
  return state.publication;
}
async function requirePreparedSourceInputs(
  ctx: Context,
  loaded: Awaited<ReturnType<typeof readInputs>>
) {
  await requireFirstSliceLayout(ctx, loaded.inputs);
  if (!(await absent(join(ctx.root, ".hack/hack.project.json")))) {
    refuse("E_LEGACY_ADOPTION_CHANGED");
  }
  const selected = {
    id: loaded.manifest.id,
  };
  for (const location of originalLocations(
    ctx,
    selected,
    loaded.manifest,
    loaded.inputs
  )) {
    await requireOriginal(ctx, location.active, location, true);
  }
  await ctx.check();
}
/** Authenticated restoration preserves the original inode and bytes, while its
 * link/unlink transaction changes ctime. Initial preparation remains strict. */
async function requireRestoredRoutingSourceInputs(
  ctx: Context,
  loaded: Awaited<ReturnType<typeof readInputs>>
) {
  if (
    loaded.manifest.adoption_generation_version !== 14 ||
    loaded.inputs.retainedRouting !== true
  ) {
    refuse();
  }
  await requireFirstSliceLayout(ctx, loaded.inputs);
  if (!(await absent(join(ctx.root, ".hack/hack.project.json")))) {
    refuse("E_LEGACY_ADOPTION_CHANGED");
  }
  for (const location of originalLocations(
    ctx,
    { id: loaded.manifest.id },
    loaded.manifest,
    loaded.inputs
  )) {
    await requireOriginal(ctx, location.active, location);
  }
  await ctx.check();
}
async function requireMutationInputs(
  ctx: Context,
  active: Publication | null,
  loaded: Awaited<ReturnType<typeof readInputs>>
) {
  if (active) {
    await requireActiveCandidate(ctx, active, loaded.inputs);
    await requireFirstSliceLayout(ctx, loaded.inputs);
  } else {
    await requirePreparedSourceInputs(ctx, loaded);
  }
}
async function mutateRetainedContainers(
  original: Context,
  known: WeakMap<LegacyComposeAdoptedGeneration, Anchor>,
  captured: MutationOptions,
  preparationStop = false
): Promise<number> {
  if (!known.has(captured.generation)) {
    refuse();
  }
  if (
    ![5, 7, 9, 10, 12, 14].includes(
      captured.generation.report.adoption_generation_version
    )
  ) {
    return await mutateRetainedContainersWithinBudget(
      original,
      known,
      captured,
      preparationStop
    );
  }
  const deadline = captured.deadline;
  if (
    deadline === undefined ||
    !Number.isSafeInteger(deadline) ||
    deadline <= Date.now() ||
    deadline > Date.now() + 3_600_000
  ) {
    refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
  }
  const bounded = boundedMutationContext(original, deadline);
  try {
    return await mutateRetainedContainersWithinBudget(
      bounded.ctx,
      known,
      captured,
      preparationStop
    );
  } catch (error: unknown) {
    cancelled(original.signal);
    if (Date.now() >= deadline) {
      refuse("E_LEGACY_ADOPTION_CHANGED");
    }
    throw error;
  } finally {
    bounded.dispose();
  }
}

function requireRetainedCompletionState(opts: {
  readonly completed: Awaited<
    ReturnType<typeof inspectLegacyComposeContainerStates>
  >;
  readonly ids: ReadonlySet<string>;
  readonly jobIds: ReadonlySet<string | undefined>;
  readonly operation: AdoptionOperation;
}): void {
  if (
    opts.completed.some(
      (value) =>
        opts.ids.has(value.id) &&
        (value.paused ||
          value.running !==
            (opts.operation !== "stop" && !opts.jobIds.has(value.id)) ||
          !["created", "running", "exited"].includes(value.status))
    )
  ) {
    refuse("E_LEGACY_ADOPTION_CHANGED");
  }
}

async function mutateRetainedContainersWithinBudget(
  ctx: Context,
  known: WeakMap<LegacyComposeAdoptedGeneration, Anchor>,
  captured: MutationOptions,
  preparationStop = false
): Promise<number> {
  let state = await publicationState(ctx);
  requireStablePublication(state);
  const owned = known.get(captured.generation);
  const activePublication = mutationPublication(state, owned, preparationStop);
  if (!owned) {
    refuse();
  }
  const loaded = await readInputs(ctx, owned);
  await requireMutationInputs(ctx, activePublication, loaded);
  const routing = loaded.inputs.retainedRouting === true;
  if (routing && state.routingHandoff !== "held") {
    refuse("E_LEGACY_ADOPTION_BUSY");
  }
  const priorUnknown =
    routing &&
    captured.recover === true &&
    state.routingOperation?.disposition === "prospective";
  const routeClaims = routing
    ? await openRetainedRoutingClaims(ctx, owned.id, loaded.inputs.binding)
    : undefined;
  let routeAttempt: NativeComposeRouteAttempt | undefined;
  try {
    await admitCandidate(ctx, loaded.inputs, captured.binary);
    const services = loaded.inputs.binding.containers.map(
      (container) => container.service
    );
    const selectedServices = captured.services.length
      ? captured.services
      : services;
    const retainedPlan = legacyComposeRetainedPlan(
      JSON.parse(loaded.inputs.candidateText)
    );
    if (
      (legacyComposeRetainedOrdered(retainedPlan) ||
        loaded.inputs.retainedBuild ||
        loaded.inputs.retainedSourceBind ||
        routing) &&
      JSON.stringify([...selectedServices].sort()) !==
        JSON.stringify([...services].sort())
    ) {
      refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
    }
    validateMutationSelection(
      state,
      { ...captured, services: selectedServices },
      services
    );
    const observed = await inspectLegacyComposeContainerStates({
      binding: loaded.inputs.binding,
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
    });
    if (
      observed.some(
        (value) =>
          value.paused ||
          !["created", "running", "exited"].includes(value.status)
      )
    ) {
      refuse("E_LEGACY_ADOPTION_UNSUPPORTED");
    }
    if (!captured.recover) {
      requireMutationDeadline(captured, retainedPlan);
      routeAttempt = routeClaims
        ? await routeClaims.acquire({
            generationIdentity: owned.id,
            hostnames: retainedRoutingIntent(loaded.inputs).routes.flatMap(
              (route) => route.origins.map((origin) => new URL(origin).hostname)
            ),
          })
        : undefined;
      state = await save(
        ctx,
        {
          ...state,
          pendingOperation: {
            generation: owned,
            operation: captured.operation,
            services: selectedServices,
          },
          ...(routeAttempt
            ? {
                routingOperation: {
                  generation: owned,
                  token: token(),
                  reference: routeAttempt.reference,
                  disposition: "prospective" as const,
                  code: null,
                },
              }
            : {}),
        },
        state
      );
    } else if (routing) {
      const previous = state.routingOperation;
      if (
        !previous ||
        JSON.stringify(previous.generation) !== JSON.stringify(owned) ||
        !routeClaims
      ) {
        refuse();
      }
      routeAttempt = await routeClaims.reopen(previous.reference);
      await routeClaims.assertHeld(previous.reference);
      if (!priorUnknown) {
        state = await save(
          ctx,
          {
            ...state,
            routingOperation: {
              ...previous,
              disposition: "prospective",
              code: null,
            },
          },
          state
        );
      }
    }
    if (routeClaims && routeAttempt && !captured.recover) {
      await routeClaims.markEffectsPossible(routeAttempt);
    }
    await readInputs(ctx, owned);
    await requireMutationInputs(ctx, activePublication, loaded);
    await requireReceiptSnapshot(ctx, state);
    requireMutationDeadline(captured, retainedPlan);
    let callbackOpen = true;
    const assertActive = () => {
      if (!callbackOpen) {
        refuse();
      }
      cancelled(ctx.signal);
      requireMutationDeadline(captured, retainedPlan);
    };
    const privateInput = privateResult({
      configText: loaded.inputs.configText,
      composeText: loaded.inputs.composeText,
      candidateText: loaded.inputs.candidateText,
      binding: loaded.inputs.binding,
      ...(loaded.inputs.projectionMetadata
        ? { projectionMetadata: loaded.inputs.projectionMetadata }
        : {}),
      retainedPlan,
      ...(loaded.inputs.retainedBuild ? { retainedBuild: true as const } : {}),
      ...(routing ? { retainedRouting: true as const } : {}),
      ...(loaded.inputs.retainedSourceBind
        ? { retainedSourceBind: true as const }
        : {}),
      assertActive,
      assertFresh: async () => {
        assertActive();
        const current = await readInputs(ctx, owned);
        await requireMutationInputs(ctx, activePublication, current);
        await requireReceiptSnapshot(ctx, state);
        assertActive();
      },
    });
    let outcome: LegacyComposeRetainedOutcome;
    try {
      outcome = await captured.run(privateInput);
    } finally {
      callbackOpen = false;
    }
    if (routing) {
      const code = consumeLegacyComposeRoutingCompletion({
        outcome,
        input: privateInput,
        operation: captured.operation,
        deadline: captured.deadline ?? 0,
      });
      if (priorUnknown) {
        // A fresh stop cannot establish the disposition of an earlier unknown child.
        // No claim, receipt or original resource may be retired from engine absence.
        refuse("E_LEGACY_ADOPTION_BUSY");
      }
      const pendingRoute = state.routingOperation;
      if (!pendingRoute) {
        refuse();
      }
      state = await save(
        ctx,
        {
          ...state,
          routingOperation: { ...pendingRoute, disposition: "settled", code },
        },
        state
      );
      outcome = code;
    }
    await ctx.check();
    await readInputs(ctx, owned);
    await requireMutationInputs(ctx, activePublication, loaded);
    const completed = await inspectLegacyComposeContainerStates({
      binding: loaded.inputs.binding,
      signal: ctx.signal,
      timeoutMs: ctx.timeoutMs,
    });
    const ids = new Set(
      loaded.inputs.binding.containers
        .filter((container) => selectedServices.includes(container.service))
        .map((container) => container.id)
    );
    if (typeof outcome === "number" && outcome !== 0) {
      return outcome;
    }
    const jobAttempts =
      retainedPlan.requiresV7 && captured.operation !== "stop"
        ? consumeLegacyComposeJobCompletion({
            outcome,
            plan: retainedPlan,
            binding: privateInput.binding,
            operation: captured.operation,
            deadline: captured.deadline ?? 0,
            assertFresh: privateInput.assertFresh,
          })
        : undefined;
    if (!jobAttempts && outcome !== 0) {
      refuse("E_LEGACY_ADOPTION_CHANGED");
    }
    const jobIds = new Set(
      retainedPlan.ordered
        .filter((item) => item.kind === "job")
        .map(
          (item) =>
            loaded.inputs.binding.containers.find(
              (container) => container.service === item.service
            )?.id
        )
    );
    requireRetainedCompletionState({
      completed,
      ids,
      jobIds,
      operation: captured.operation,
    });
    const confirmV7Commit = async () => {
      await readInputs(ctx, owned);
      await requireMutationInputs(ctx, activePublication, loaded);
      await requireReceiptSnapshot(ctx, state);
      if (jobAttempts) {
        const finalRows = legacyComposeJobStates({
          binding: loaded.inputs.binding,
          observed: await inspectLegacyComposeJobStates({
            binding: loaded.inputs.binding,
            signal: ctx.signal,
            timeoutMs: ctx.timeoutMs,
          }),
        });
        const serviceRequired = retainedPlan.ordered
          .filter((item) => item.kind !== "job")
          .map((item) => ({
            service: item.service,
            condition: item.healthy ? ("ready" as const) : ("started" as const),
          }));
        if (
          jobAttempts.length !== jobIds.size ||
          jobAttempts.some((attempt) => {
            const row = finalRows.find((item) => item.id === attempt.id);
            return (
              !(jobIds.has(attempt.id) && row) ||
              legacyComposeFreshJobResult({ attempt, observed: row }) !==
                "ready"
            );
          }) ||
          !legacyComposeRetainedReady({
            plan: retainedPlan,
            ids: new Map(
              loaded.inputs.binding.containers.map((item) => [
                item.service,
                item.id,
              ])
            ),
            observed: finalRows,
            required: serviceRequired,
          })
        ) {
          refuse("E_LEGACY_ADOPTION_CHANGED");
        }
      } else {
        await requireStopped(ctx, loaded.inputs.binding);
      }
      await readInputs(ctx, owned);
      await requireMutationInputs(ctx, activePublication, loaded);
      await requireReceiptSnapshot(ctx, state);
      await ctx.check();
      cancelled(ctx.signal);
      requireMutationDeadline(captured, retainedPlan);
    };
    if (
      !retainedPlan.requiresV7 &&
      retainedPlan.requiresV5 &&
      captured.operation !== "stop"
    ) {
      const readiness = await inspectLegacyComposeReadiness({
        binding: loaded.inputs.binding,
        signal: ctx.signal,
        timeoutMs: ctx.timeoutMs,
      });
      if (
        !legacyComposeRetainedReady({
          plan: retainedPlan,
          ids: new Map(
            loaded.inputs.binding.containers.map((container) => [
              container.service,
              container.id,
            ])
          ),
          observed: readiness,
        })
      ) {
        refuse("E_LEGACY_ADOPTION_CHANGED");
      }
      await readInputs(ctx, owned);
      await requireMutationInputs(ctx, activePublication, loaded);
    }
    requireMutationDeadline(captured, retainedPlan);
    const confirmRoutingCommit = async () => {
      await assertRetainedRouteState(
        ctx,
        loaded,
        captured.operation === "stop" ? "stopped" : "active",
        captured.deadline ?? 0,
        async (current) => {
          const fresh = await readInputs(current, owned);
          await requireMutationInputs(current, activePublication, fresh);
          await requireReceiptSnapshot(current, state);
          requireMutationDeadline(captured, retainedPlan);
          return fresh;
        }
      );
      await requireReceiptSnapshot(ctx, state);
      requireMutationDeadline(captured, retainedPlan);
    };
    if (routeClaims && routeAttempt) {
      if (captured.recover) {
        await routeClaims.recoverRetainedStopped({
          references: [routeAttempt.reference],
          assertStopped: async (claim) => {
            requireRetainedClaimContext({
              inputs: loaded.inputs,
              generation: owned.id,
              claim,
            });
            await confirmRoutingCommit();
          },
        });
      } else {
        await routeClaims.complete({
          attempt: routeAttempt,
          assertTransition: confirmRoutingCommit,
        });
      }
    }
    let beforeCommit: (() => Promise<void>) | undefined;
    if (routing) {
      beforeCommit = confirmRoutingCommit;
    } else if (retainedPlan.requiresV7) {
      beforeCommit = confirmV7Commit;
    }
    await save(
      ctx,
      { ...state, pendingOperation: null },
      state,
      beforeCommit ? { beforeCommit } : undefined
    );
    return 0;
  } finally {
    await routeClaims?.close();
  }
}

/**
 * Durable preparation and explicit stopped format transition. Uses the same
 * bounded private file/lock authority as native generations, with a distinct
 * receipt/type/path and the original legacy resource owner. Saved reads need no
 * current authored files, env values or keys. Format publication holds the exact originals for rollback. Engine effects are
 * accepted only through a pending retained-resource operation; labels and data
 * names are never regenerated.
 * Cooperative leases and rechecks cannot freeze Docker or external editors.
 */
export async function openLegacyComposeAdoptedGenerationStore(input: {
  readonly projectRoot: string;
  readonly requestedBranch?: string;
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
      (input.mode !== undefined &&
        !["prepare", "saved"].includes(input.mode)) ||
      (input.requestedBranch !== undefined &&
        (typeof input.requestedBranch !== "string" ||
          !input.requestedBranch.trim() ||
          input.requestedBranch.includes("\0")))
    ) {
      refuse();
    }
    const root = resolve(input.projectRoot),
      mode = input.mode ?? "prepare";
    signal = input.signal;
    const timeoutMs = input.timeoutMs,
      capturedRoute = route(),
      routingRoot = join(resolveGlobalHackDir(), "compose-routing");
    cancelled(signal);
    for (const path of [root, join(root, ".hack")]) {
      directories.push(await holdDirectory(path, false));
    }
    const gitCheckout = await acquireLegacyComposeAdoptionCheckout({
      projectRoot: root,
      signal,
    });
    directories.push(...gitCheckout.directories);
    const rootInfo = directories[0]?.info,
      projectInfo = directories[1]?.info;
    if (!(rootInfo && projectInfo)) {
      refuse();
    }
    const checkout: Checkout = {
      root: fileIdentity(rootInfo),
      project: fileIdentity(projectInfo),
      git: gitCheckout.identity,
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
    const sourceBind: Context["sourceBind"] = {};
    const check = async () => {
      cancelled(signal);
      if (closed || route() !== capturedRoute) {
        refuse("E_LEGACY_ADOPTION_CHANGED");
      }
      await recheckDirectories(directories);
      await gitCheckout.assertFresh();
      const currentIgnore = await readPrivate(ignorePath, 2);
      if (
        !sameFile(ignore.info, currentIgnore.info) ||
        ignore.text !== currentIgnore.text
      ) {
        refuse();
      }
      await sourceBind.current?.lease.assertDirectoriesFresh({ signal });
    };
    const ctx: Context = {
      root,
      routingRoot,
      checkout,
      directories,
      stateRoot,
      generationsRoot,
      receiptPath,
      signal,
      timeoutMs,
      requestedBranch: input.requestedBranch,
      check,
      sourceBind,
      receiptSnapshots: new WeakMap(),
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
            adoption_receipt_version: "kind" in checkout.git ? 2 : 1,
            kind: KIND,
            checkout,
            prepared: null,
            publication: null,
            pendingOperation: null,
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
      return (await publicationState(ctx)).prepared;
    };
    const result: LegacyComposeAdoptedGenerationStore = {
      async prepare(opts = {}) {
        try {
          const binary = opts.binary;
          if (mode === "saved") {
            refuse();
          }
          return await lock.withLock(async () => {
            const prior = await publicationState(ctx);
            requireNoPendingOperation(prior);
            if (
              prior.publication !== null &&
              prior.publication.phase !== "rolled-back"
            ) {
              refuse("E_LEGACY_ADOPTION_BUSY");
            }
            if (prior.adoption_receipt_version === 13 && prior.prepared) {
              await readInputs(ctx, prior.prepared);
            }
            const previous = sourceBind.current;
            if (previous) {
              if (
                !prior.prepared ||
                JSON.stringify(previous.generation) !==
                  JSON.stringify(prior.prepared)
              ) {
                refuse("E_LEGACY_ADOPTION_CHANGED");
              }
              await previous.lease.close();
              sourceBind.current = undefined;
            }
            const generated = await prepare(ctx, binary);
            const loaded = await readInputs(ctx, generated, true);
            await save(
              ctx,
              {
                adoption_receipt_version: preparedReceiptVersion(
                  loaded.manifest.adoption_generation_version,
                  prior,
                  checkout
                ),
                kind: KIND,
                checkout,
                prepared: generated,
                publication: null,
                pendingOperation: null,
                ...(loaded.manifest.adoption_generation_version === 14
                  ? { routingOperation: null, routingHandoff: "held" as const }
                  : {}),
              },
              prior
            );
            return claim(
              generated,
              known,
              loaded.manifest.binding,
              "prepared",
              loaded.manifest.adoption_generation_version
            );
          });
        } catch (error: unknown) {
          translate(error, signal);
        }
      },
      async loadPrepared(opts = {}) {
        try {
          const state = await publicationState(ctx);
          requireStablePublication(state);
          if (!opts.recoverOperation) {
            requireNoPendingOperation(state);
          }
          const current = await selected();
          if (!current) {
            return null;
          }
          const loaded = await readInputs(ctx, current);
          return claim(
            current,
            known,
            loaded.manifest.binding,
            "prepared",
            loaded.manifest.adoption_generation_version
          );
        } catch (error: unknown) {
          translate(error, signal);
        }
      },
      async loadActive(opts = {}) {
        try {
          const state = await publicationState(ctx);
          requireStablePublication(state);
          if (!opts.recoverOperation) {
            requireNoPendingOperation(state);
          }
          if (state.publication?.phase !== "active") {
            return null;
          }
          const loaded = await readInputs(ctx, state.publication.generation);
          await requireActiveCandidate(ctx, state.publication, loaded.inputs);
          return claim(
            state.publication.generation,
            known,
            loaded.manifest.binding,
            "active",
            loaded.manifest.adoption_generation_version
          );
        } catch (error: unknown) {
          translate(error, signal);
        }
      },
      async publish(opts) {
        try {
          const generation = opts.generation,
            binary = opts.binary;
          await lock.withLock(async () => {
            const state = await publicationState(ctx),
              owned = known.get(generation);
            requireNoPendingOperation(state);
            if (
              !(owned && state.prepared) ||
              JSON.stringify(owned) !== JSON.stringify(state.prepared) ||
              (state.publication && state.publication.phase !== "rolled-back")
            ) {
              refuse();
            }
            const loaded = await readInputs(ctx, owned);
            if (
              loaded.inputs.retainedRouting &&
              state.routingHandoff !== "held"
            ) {
              refuse("E_LEGACY_ADOPTION_BUSY");
            }
            await requireFirstSliceLayout(ctx, loaded.inputs);
            await admitCandidate(ctx, loaded.inputs, binary);
            await requireStopped(ctx, loaded.inputs.binding);
            await requirePreparedSourceInputs(ctx, loaded);
            const publication: Publication = {
              generation: owned,
              phase: "switching",
              native: null,
            };
            const pending = await save(ctx, { ...state, publication }, state);
            await completePublication(ctx, pending, binary);
          });
        } catch (error: unknown) {
          translate(error, signal);
        }
      },
      async rollback() {
        try {
          await lock.withLock(async () => {
            const state = await publicationState(ctx);
            requireNoPendingOperation(state);
            if (state.publication?.phase !== "active") {
              refuse();
            }
            const loaded = await readInputs(ctx, state.publication.generation);
            await requireActiveCandidate(ctx, state.publication, loaded.inputs);
            await requireStopped(ctx, loaded.inputs.binding);
            const next: Receipt = {
              ...state,
              publication: { ...state.publication, phase: "rolling-back" },
            };
            const pending = await save(ctx, next, state);
            await completeRollback(ctx, pending);
          });
        } catch (error: unknown) {
          translate(error, signal);
        }
      },
      async repairPublication(opts) {
        try {
          const action = opts.action,
            binary = opts.binary;
          if (action !== "complete" && action !== "rollback") {
            refuse();
          }
          await lock.withLock(async () => {
            let state = await publicationState(ctx);
            if (!(state.publication && pending(state))) {
              refuse();
            }
            if (
              action === "rollback" &&
              state.publication.phase === "switching"
            ) {
              const next: Receipt = {
                ...state,
                publication: { ...state.publication, phase: "rolling-back" },
              };
              state = await save(ctx, next, state);
            }
            if (action === "rollback") {
              await completeRollback(ctx, state);
            } else {
              await completePublication(ctx, state, binary);
            }
          });
        } catch (error: unknown) {
          translate(error, signal);
        }
      },
      async withLease(opts) {
        try {
          const captured = { ...opts };
          return await lock.withLock(async () => {
            const publication = await publicationState(ctx);
            requireStablePublication(publication);
            requireNoPendingOperation(publication);
            const current = await selected(),
              selectedAnchor = known.get(captured.generation);
            if (
              !(current && selectedAnchor) ||
              JSON.stringify(current) !== JSON.stringify(selectedAnchor)
            ) {
              refuse();
            }
            const loaded = await readInputs(ctx, current);
            if (publication.publication?.phase === "active") {
              await requireActiveCandidate(
                ctx,
                publication.publication,
                loaded.inputs
              );
            }
            await requireReceiptSnapshot(ctx, publication);
            const value = await captured.run(loaded.inputs);
            await readInputs(ctx, current);
            if (publication.publication?.phase === "active") {
              await requireActiveCandidate(
                ctx,
                publication.publication,
                loaded.inputs
              );
            }
            if (
              JSON.stringify(await publicationState(ctx)) !==
              JSON.stringify(publication)
            ) {
              refuse();
            }
            if (sourceBind.current) {
              await requireReceiptSnapshot(ctx, publication);
            }
            return value;
          });
        } catch (error: unknown) {
          translate(error, signal);
        }
      },
      async withMutation(opts) {
        try {
          const captured = { ...opts, services: [...opts.services] };
          return await lock.withLock(
            async () => await mutateRetainedContainers(ctx, known, captured)
          );
        } catch (error: unknown) {
          translate(error, signal);
        }
      },
      async withPreparationStop(opts) {
        try {
          const captured = {
            ...opts,
            operation: "stop" as const,
            services: [],
          };
          return await lock.withLock(
            async () =>
              await mutateRetainedContainers(ctx, known, captured, true)
          );
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
        await sourceBind.current?.lease.close();
        sourceBind.current = undefined;
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
