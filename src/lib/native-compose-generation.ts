import { createHash } from "node:crypto";
import { lstat, mkdir, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_INGRESS_NETWORK } from "../constants.ts";
import { isRecord } from "./guards.ts";
import {
  createNativeComposePrivateMutationLock,
  type HeldDirectory,
  hasCode,
  holdDirectory,
  jsonPrivate,
  keys,
  NativeComposeGenerationError,
  parsePrivateJson,
  privateDirectory,
  privateIgnore,
  readPrivate,
  recheckDirectories,
  sameFile,
  synchronizeDirectories,
  token,
  writeExclusive,
} from "./native-compose-private-state.ts";
import { inspectProjectInputsAtRoot } from "./project-input-selection.ts";
import { resolveVerifiedPrimaryWorktreeRoot } from "./worktree-local-config.ts";

// biome-ignore lint/performance/noBarrelFile: Preserve the existing generation error import and class identity after the mechanical owner extraction.
export { NativeComposeGenerationError } from "./native-compose-private-state.ts";

const RECEIPT_LIMIT = 64 * 1024;
function refuse(): never {
  throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_STATE");
}

const TOKEN = /^[a-f0-9]{32}$/;
const HASH = /^[a-f0-9]{64}$/;
const PROFILE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const CONTROL = /[\x00-\x1f\x7f]/;
/** Matches the compiler output budget; this is an artifact bound, not a workload limit. */
export const NATIVE_COMPOSE_DOCUMENT_LIMIT = 8 * 1024 * 1024;

export type NativeComposeIdentity = {
  readonly checkoutRoot: string;
  readonly repositoryRoot: string;
  readonly instance: string | null;
  readonly instanceId: string;
  readonly composeProject: string;
  readonly ownerToken: string;
};

export type NativeComposeGeneration = {
  readonly identity: NativeComposeIdentity;
  readonly generationId: string;
  readonly composeFile: string;
  readonly profiles: readonly string[];
};

export type NativeComposeReservation = {
  readonly identity: NativeComposeIdentity;
  readonly generationId: string;
};

/** Opaque live authority. Copies of public identities or this empty object do not qualify. */
export type NativeComposeMaterialAuthority = Readonly<Record<never, never>>;
type MaterialSelection = {
  readonly phase: "prepare" | "source" | "inspect" | "effect" | "retire";
  readonly reservation?: NativeComposeReservation;
  readonly generation?: NativeComposeGeneration;
};
/** Private binding: never serialize it into a public report, label or receipt. */
export type NativeComposeMaterialBinding = {
  readonly identity: NativeComposeIdentity;
  readonly generationId: string;
  readonly checkout: CheckoutAnchor;
  readonly receipt: {
    readonly dev: number;
    readonly ino: number;
    readonly hash: string;
  };
  readonly lease: {
    readonly token: string;
    readonly directory: { readonly dev: number; readonly ino: number };
    readonly owner: { readonly dev: number; readonly ino: number };
  };
  readonly generation: GenerationAnchor | null;
  readonly documentHash: string | null;
  readonly currentGenerationId: string | null;
  readonly pendingGenerationId: string | null;
  readonly pendingToken: string | null;
};
const materialAuthorities = new WeakMap<
  object,
  (selection: MaterialSelection) => Promise<NativeComposeMaterialBinding>
>();
const materialActions = new WeakMap<
  object,
  <T>(run: () => Promise<T>) => Promise<T>
>();
/** The generation lease remains held until owned material work has settled, even after revocation. */
export async function runNativeComposeMaterialAction<T>(opts: {
  readonly authority: NativeComposeMaterialAuthority;
  readonly run: () => Promise<T>;
}): Promise<T> {
  const action = materialActions.get(opts.authority);
  if (!action) {
    return refuse();
  }
  return await action(opts.run);
}
function frozenCheckout(anchor: CheckoutAnchor): CheckoutAnchor {
  return Object.freeze({
    ...anchor,
    projectDirectory: Object.freeze({ ...anchor.projectDirectory }),
    gitMarker:
      anchor.gitMarker === null ? null : Object.freeze({ ...anchor.gitMarker }),
  });
}
function frozenGeneration(anchor: GenerationAnchor): GenerationAnchor {
  return Object.freeze({
    ...anchor,
    manifest: Object.freeze({ ...anchor.manifest }),
  });
}
function receiptReferencesGeneration(
  state: Receipt,
  anchor: GenerationAnchor
): boolean {
  return [state.current, state.pending].some(
    (value) =>
      value !== null &&
      value.generationId === anchor.generationId &&
      value.manifestHash === anchor.manifestHash &&
      value.manifest.dev === anchor.manifest.dev &&
      value.manifest.ino === anchor.manifest.ino
  );
}
function materialEffectAllowed(
  phase: MaterialSelection["phase"],
  operation: NativeComposeOperation | null,
  state: Receipt,
  generationId: string
): boolean {
  if (phase === "inspect") {
    return true;
  }
  if (state.beforeHooks !== null || state.pending === null) {
    return false;
  }
  const startup = operation === "up" || operation === "restart";
  if (phase === "effect") {
    return startup && state.pending.generationId === generationId;
  }
  return (
    phase === "retire" &&
    (operation === "down" ||
      (startup &&
        state.current?.generationId === generationId &&
        state.pending.generationId !== generationId))
  );
}
function materialPreparation(opts: {
  readonly selection: MaterialSelection;
  readonly state: Receipt;
  readonly saved: boolean;
  readonly liveAfterHook: boolean;
  readonly reservations: WeakSet<NativeComposeReservation>;
}): { readonly generationId: string; readonly anchor: null } {
  const { selection, state } = opts;
  if (
    opts.saved ||
    selection.generation !== undefined ||
    !selection.reservation ||
    !opts.reservations.has(selection.reservation) ||
    (state.pending !== null &&
      (selection.phase !== "source" ||
        state.pending.generationId !== selection.reservation.generationId)) ||
    (state.beforeHooks !== null && !opts.liveAfterHook)
  ) {
    return refuse();
  }
  return { generationId: selection.reservation.generationId, anchor: null };
}
function materialDocumentHash(
  selection: MaterialSelection,
  known: WeakMap<NativeComposeGeneration, Manifest>
): string | null {
  if (selection.generation === undefined) {
    return null;
  }
  return known.get(selection.generation)?.documentHash ?? refuse();
}
function materialSourceHookAllowed(
  selection: MaterialSelection,
  state: Receipt,
  operation: NativeComposeOperation | null,
  pending: Receipt["pending"]
): boolean {
  return (
    selection.phase === "source" &&
    state.beforeHooks?.phase === "after" &&
    (operation === "up" || operation === "restart") &&
    pending !== null &&
    JSON.stringify(state.pending) === JSON.stringify(pending)
  );
}
/** Check the actual generation-store mutation, including revocation and kernel-lock identity. */
export async function assertNativeComposeMaterialAuthority(
  opts: MaterialSelection & {
    readonly authority: NativeComposeMaterialAuthority;
  }
): Promise<NativeComposeMaterialBinding> {
  const { authority, ...selection } = opts;
  if (typeof authority !== "object" || authority === null) {
    return refuse();
  }
  const assert = materialAuthorities.get(authority);
  if (!assert) {
    return refuse();
  }
  return await assert(selection);
}

export type NativeComposeOperation = "up" | "restart" | "run" | "down";
export type NativeComposePending = {
  readonly token: string;
  readonly operation: NativeComposeOperation;
  readonly generationId: string;
  readonly recoveryToken?: string;
};

type HostHookIntent =
  | { readonly token: string; readonly phase: "before" }
  | {
      readonly token: string;
      readonly phase: "after";
      readonly pendingToken: string;
      readonly generationId: string;
      readonly operation: "up" | "restart";
    };
type Receipt = {
  readonly version: 1;
  readonly identity: NativeComposeIdentity;
  readonly checkout: CheckoutAnchor;
  readonly current: GenerationAnchor | null;
  readonly stopped: boolean;
  readonly pending: (NativeComposePending & GenerationAnchor) | null;
  /** No command, PID, environment, or content fingerprint. Interrupted finite hooks never replay. */
  readonly beforeHooks: HostHookIntent | null;
};
type FileIdentity = { readonly dev: number; readonly ino: number };
type CheckoutAnchor = FileIdentity & {
  readonly projectDirectory: FileIdentity;
  readonly gitMarker: FileIdentity | null;
};
type GenerationAnchor = {
  readonly generationId: string;
  readonly manifestHash: string;
  readonly manifest: { readonly dev: number; readonly ino: number };
};
type Manifest = {
  readonly version: 1;
  readonly identity: NativeComposeIdentity;
  readonly generationId: string;
  readonly profiles: readonly string[];
  readonly documentHash: string;
  readonly inputRevision: string;
  readonly document: { readonly dev: number; readonly ino: number };
};
function hash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
function identityMatches(left: unknown, right: NativeComposeIdentity): boolean {
  return (
    isRecord(left) &&
    keys(
      left,
      "checkoutRoot,composeProject,instance,instanceId,ownerToken,repositoryRoot"
    ) &&
    left.checkoutRoot === right.checkoutRoot &&
    left.repositoryRoot === right.repositoryRoot &&
    left.instance === right.instance &&
    left.instanceId === right.instanceId &&
    left.composeProject === right.composeProject &&
    left.ownerToken === right.ownerToken
  );
}
function anchorValid(
  value: unknown
): value is GenerationAnchor & Record<string, unknown> {
  return (
    isRecord(value) &&
    typeof value.generationId === "string" &&
    TOKEN.test(value.generationId) &&
    typeof value.manifestHash === "string" &&
    HASH.test(value.manifestHash) &&
    isRecord(value.manifest) &&
    keys(value.manifest, "dev,ino") &&
    typeof value.manifest.dev === "number" &&
    Number.isSafeInteger(value.manifest.dev) &&
    typeof value.manifest.ino === "number" &&
    Number.isSafeInteger(value.manifest.ino)
  );
}
function pendingValid(
  value: unknown
): value is NativeComposePending & GenerationAnchor {
  return (
    isRecord(value) &&
    [
      "generationId,manifest,manifestHash,operation,token",
      "generationId,manifest,manifestHash,operation,recoveryToken,token",
    ].includes(Object.keys(value).sort().join()) &&
    anchorValid(value) &&
    typeof value.token === "string" &&
    TOKEN.test(value.token) &&
    ["up", "restart", "run", "down"].includes(String(value.operation)) &&
    (!Object.hasOwn(value, "recoveryToken") ||
      (typeof value.recoveryToken === "string" &&
        TOKEN.test(value.recoveryToken)))
  );
}
function beforeHooksValid(
  value: unknown
): value is
  | HostHookIntent
  | { readonly token: string; readonly phase?: "before" }
  | null {
  return (
    value === null ||
    (isRecord(value) &&
      typeof value.token === "string" &&
      TOKEN.test(value.token) &&
      (keys(value, "token") ||
        (keys(value, "phase,token") && value.phase === "before") ||
        (keys(value, "generationId,operation,pendingToken,phase,token") &&
          value.phase === "after" &&
          (value.operation === "up" || value.operation === "restart") &&
          typeof value.pendingToken === "string" &&
          TOKEN.test(value.pendingToken) &&
          typeof value.generationId === "string" &&
          TOKEN.test(value.generationId))))
  );
}
function normalizeHostIntent(
  value:
    | HostHookIntent
    | { readonly token: string; readonly phase?: "before" }
    | null
    | undefined
): HostHookIntent | null {
  if (value == null) {
    return null;
  }
  if (value.phase === "after") {
    return value;
  }
  return { token: value.token, phase: "before" };
}
function afterHookOperation(
  operation: NativeComposeOperation
): "up" | "restart" {
  if (operation === "up" || operation === "restart") {
    return operation;
  }
  return refuse();
}
function requireBeforeHooksAdmission(
  state: Receipt,
  mode: "prepare" | "saved" | undefined
): void {
  if (
    mode === "saved" ||
    state.pending !== null ||
    state.beforeHooks !== null
  ) {
    throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_UNCERTAIN");
  }
}
function parseReceipt(
  value: unknown,
  identity: NativeComposeIdentity,
  checkout: CheckoutAnchor
): Receipt {
  if (
    !(
      isRecord(value) &&
      (keys(value, "checkout,current,identity,pending,stopped,version") ||
        keys(
          value,
          "beforeHooks,checkout,current,identity,pending,stopped,version"
        )) &&
      value.version === 1 &&
      identityMatches(value.identity, identity) &&
      checkoutMatches(value.checkout, checkout) &&
      (value.current === null ||
        (isRecord(value.current) &&
          keys(value.current, "generationId,manifest,manifestHash") &&
          anchorValid(value.current))) &&
      typeof value.stopped === "boolean" &&
      (value.pending === null || pendingValid(value.pending)) &&
      (value.beforeHooks === undefined || beforeHooksValid(value.beforeHooks))
    )
  ) {
    return refuse();
  }
  return {
    version: 1,
    identity,
    checkout,
    current: value.current,
    stopped: value.stopped,
    pending: value.pending,
    beforeHooks: normalizeHostIntent(value.beforeHooks),
  };
}
function checkoutMatches(value: unknown, expected: CheckoutAnchor): boolean {
  if (
    !(
      isRecord(value) &&
      keys(value, "dev,gitMarker,ino,projectDirectory") &&
      value.dev === expected.dev &&
      value.ino === expected.ino &&
      isRecord(value.projectDirectory) &&
      keys(value.projectDirectory, "dev,ino") &&
      value.projectDirectory.dev === expected.projectDirectory.dev &&
      value.projectDirectory.ino === expected.projectDirectory.ino
    )
  ) {
    return false;
  }
  if (expected.gitMarker === null) {
    return value.gitMarker === null;
  }
  return (
    isRecord(value.gitMarker) &&
    keys(value.gitMarker, "dev,ino") &&
    value.gitMarker.dev === expected.gitMarker.dev &&
    value.gitMarker.ino === expected.gitMarker.ino
  );
}
function profilesValid(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.every((name) => typeof name === "string" && PROFILE.test(name)) &&
    new Set(value).size === value.length
  );
}
function parseManifest(
  value: unknown,
  identity: NativeComposeIdentity,
  generationId: string
): Manifest {
  if (
    !(
      isRecord(value) &&
      keys(
        value,
        "document,documentHash,generationId,identity,inputRevision,profiles,version"
      ) &&
      value.version === 1 &&
      identityMatches(value.identity, identity) &&
      value.generationId === generationId &&
      profilesValid(value.profiles) &&
      typeof value.documentHash === "string" &&
      HASH.test(value.documentHash) &&
      typeof value.inputRevision === "string" &&
      HASH.test(value.inputRevision) &&
      isRecord(value.document) &&
      keys(value.document, "dev,ino") &&
      typeof value.document.dev === "number" &&
      Number.isSafeInteger(value.document.dev) &&
      typeof value.document.ino === "number" &&
      Number.isSafeInteger(value.document.ino)
    )
  ) {
    return refuse();
  }
  return {
    version: 1,
    identity,
    generationId,
    profiles: value.profiles,
    documentHash: value.documentHash,
    inputRevision: value.inputRevision,
    document: { dev: value.document.dev, ino: value.document.ino },
  };
}
function publicPending(value: Receipt["pending"]): NativeComposePending | null {
  return value === null
    ? null
    : {
        token: value.token,
        operation: value.operation,
        generationId: value.generationId,
        ...(value.recoveryToken === undefined
          ? {}
          : { recoveryToken: value.recoveryToken }),
      };
}
/** Check reserved delivery identity only; renderer owns all Compose feature policy. */
function documentOwned(
  document: unknown,
  reservation: NativeComposeReservation
): boolean {
  if (
    !(
      isRecord(document) &&
      document.name === reservation.identity.composeProject &&
      isRecord(document.services)
    )
  ) {
    return false;
  }
  const labelsMatch = (item: unknown, generation: boolean, storage?: string) =>
    isRecord(item) &&
    isRecord(item.labels) &&
    item.labels["io.hack.native-config.version"] === "1" &&
    item.labels["io.hack.native-config.instance"] ===
      reservation.identity.composeProject &&
    item.labels["io.hack.native-config.owner"] ===
      reservation.identity.ownerToken &&
    (!generation ||
      (item.labels["io.hack.native-config.generation"] ===
        reservation.generationId &&
        (item.labels["io.hack.native-config.workload"] === "service" ||
          item.labels["io.hack.native-config.workload"] === "job"))) &&
    (storage === undefined ||
      item.labels["io.hack.native-config.storage"] === storage);
  if (
    !Object.values(document.services).every((service) =>
      labelsMatch(service, true)
    )
  ) {
    return false;
  }
  if (
    Object.hasOwn(document, "volumes") &&
    !(
      isRecord(document.volumes) &&
      Object.entries(document.volumes).every(([name, volume]) =>
        labelsMatch(volume, false, name)
      )
    )
  ) {
    return false;
  }
  return (
    !Object.hasOwn(document, "networks") ||
    (isRecord(document.networks) &&
      Object.entries(document.networks).every(([name, network]) =>
        name === "ingress"
          ? isRecord(network) &&
            keys(network, "external,name") &&
            network.external === true &&
            network.name === DEFAULT_INGRESS_NETWORK
          : labelsMatch(network, false)
      ))
  );
}
function requireDocumentOwned(
  json: string,
  reservation: NativeComposeReservation
): void {
  let document: unknown;
  try {
    document = JSON.parse(json) as unknown;
  } catch {
    refuse();
  }
  if (!documentOwned(document, reservation)) {
    refuse();
  }
}

export type NativeComposeEffectOptions<T> = {
  readonly generation: NativeComposeGeneration;
  readonly operation: NativeComposeOperation;
  readonly assertFresh?: () => Promise<void>;
  readonly assertOwned: () => Promise<void>;
  readonly recoverPending?: boolean;
  /**
   * Finalize dependent ownership after a reaped, verified complete effect and fresh
   * pending/ownership checks, before publishing the completed generation receipt.
   * Failure preserves the uncertain pending generation; this is not a cross-store
   * atomic commit, and the finalizer must retain its own crash recovery evidence.
   */
  readonly beforeComplete?: () => Promise<void>;
  /** Prepare private values after verified engine readiness, then journal a generation-bound finite phase before spawn. */
  readonly afterHooks?: {
    readonly prepare: () => Promise<
      () => Promise<{
        readonly outcome: "complete" | "uncertain";
        readonly value: T;
        readonly ready: boolean;
      }>
    >;
  };
  readonly effect: () => Promise<{
    readonly outcome: "complete" | "uncertain";
    readonly value: T;
  }>;
};
type PublishOptions = {
  readonly reservation: NativeComposeReservation;
  readonly composeJson: string;
  readonly profiles: readonly string[];
  readonly inputRevision: string;
  readonly assertFresh: () => Promise<void>;
};
function publishInputValid(input: PublishOptions): boolean {
  return (
    profilesValid(input.profiles) &&
    HASH.test(input.inputRevision) &&
    Buffer.byteLength(input.composeJson) <= NATIVE_COMPOSE_DOCUMENT_LIMIT
  );
}
function admitEffect<T>(
  input: NativeComposeEffectOptions<T>,
  state: Receipt,
  mode: "prepare" | "saved" | undefined
): void {
  if (!["up", "restart", "run", "down"].includes(input.operation)) {
    refuse();
  }
  if (
    input.afterHooks &&
    input.operation !== "up" &&
    input.operation !== "restart"
  ) {
    refuse();
  }
  if (input.operation !== "down" && state.beforeHooks !== null) {
    throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_UNCERTAIN");
  }
  if (
    (mode === "saved" && input.operation !== "down") ||
    (input.operation !== "down" && input.assertFresh === undefined)
  ) {
    refuse();
  }
  if (
    input.operation === "run" &&
    state.current !== null &&
    input.generation.generationId !== state.current.generationId
  ) {
    refuse();
  }
  if (
    state.pending !== null &&
    !(
      input.operation === "down" &&
      input.recoverPending === true &&
      input.generation.generationId === state.pending.generationId
    )
  ) {
    throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_UNCERTAIN");
  }
  if (input.recoverPending && state.pending === null) {
    refuse();
  }
}
function completedReceipt(
  state: Receipt,
  anchor: GenerationAnchor,
  operation: NativeComposeOperation
): Receipt {
  if (operation === "up" || operation === "restart") {
    return { ...state, current: anchor, stopped: false, pending: null };
  }
  if (operation === "run") {
    return {
      ...state,
      current: state.current ?? anchor,
      stopped: false,
      pending: null,
    };
  }
  return {
    ...state,
    current: state.current ?? anchor,
    stopped: operation === "down" || state.stopped,
    pending: null,
  };
}

export type NativeComposeMutation = {
  /** Nonenumerable, live only within this withMutation invocation. */
  readonly materialAuthority: NativeComposeMaterialAuthority;
  /** Journal finite host effects before spawning. Unknown completion permanently fences replay. */
  runBeforeHooks<T>(opts: {
    readonly assertFresh: () => Promise<void>;
    readonly effect: () => Promise<{
      readonly outcome: "complete" | "uncertain";
      readonly value: T;
    }>;
  }): Promise<{
    readonly outcome: "complete" | "uncertain";
    readonly value: T;
  }>;
  reserveGeneration(): NativeComposeReservation;
  publish(opts: PublishOptions): Promise<NativeComposeGeneration>;
  /** Only a caller-verified complete postcondition clears intent; engine exit alone is insufficient. */
  runEffect<T>(opts: NativeComposeEffectOptions<T>): Promise<{
    readonly outcome: "complete" | "uncertain";
    readonly value: T;
  }>;
};
export type NativeComposeGenerationStore = {
  readonly identity: NativeComposeIdentity;
  loadCurrent(): Promise<{
    readonly generation: NativeComposeGeneration | null;
    readonly stopped: boolean;
    readonly pending: NativeComposePending | null;
    readonly beforeHooksPending: boolean;
    readonly hostHookPhase: "before" | "after" | null;
  }>;
  loadPending(): Promise<NativeComposeGeneration | null>;
  /** Private values: never serialize/log this object. Use within a saved-generation lease. */
  readGenerationDocument(
    generation: NativeComposeGeneration
  ): Promise<Readonly<Record<string, unknown>>>;
  /** Explicit same-boot recovery only; live/unknown owners, empty locks and recovery guards refuse. */
  recoverInterruptedLock(): Promise<void>;
  withMutation<T>(
    run: (mutation: NativeComposeMutation) => Promise<T>
  ): Promise<T>;
  withLease<T>(opts: {
    readonly generation: NativeComposeGeneration;
    readonly run: (generation: NativeComposeGeneration) => Promise<T>;
  }): Promise<T>;
  close(): Promise<void>;
};

/**
 * Owned private documents for cooperative writers. Saved mode reads/stops retained
 * identity without reading authored contents or managed env. It cannot publish/start.
 * Held directories and effect-time checks detect rebinding, but cannot freeze arbitrary
 * outside edits. Locks are never stolen; interrupted locks require explicit recovery.
 * No API removes generations or persistent engine data.
 */
export async function openNativeComposeGenerationStore(opts: {
  readonly projectRoot: string;
  readonly instance: string | null;
  readonly mode?: "prepare" | "saved";
}): Promise<NativeComposeGenerationStore> {
  const directories: HeldDirectory[] = [];
  try {
    const checkoutRoot = resolve(opts.projectRoot);
    if (
      opts.mode !== undefined &&
      opts.mode !== "prepare" &&
      opts.mode !== "saved"
    ) {
      refuse();
    }
    if (
      opts.instance !== null &&
      (!opts.instance ||
        Buffer.byteLength(opts.instance) > 256 ||
        CONTROL.test(opts.instance))
    ) {
      refuse();
    }
    if (
      opts.mode !== "saved" &&
      (await inspectProjectInputsAtRoot({ projectRoot: checkoutRoot })).kind !==
        "native"
    ) {
      refuse();
    }
    directories.push(await holdDirectory(checkoutRoot, false));
    const checkout = directories[0];
    if (!checkout) {
      refuse();
    }
    const repositoryRoot =
      (await resolveVerifiedPrimaryWorktreeRoot({
        projectRoot: checkoutRoot,
      })) ?? checkoutRoot;
    const gitMarker = join(checkoutRoot, ".git");
    const gitIdentity = await lstat(gitMarker).catch((error: unknown) => {
      if (hasCode(error, "ENOENT")) {
        return null;
      }
      throw error;
    });
    const projectDirectory = await holdDirectory(
      join(checkoutRoot, ".hack"),
      false
    );
    directories.push(projectDirectory);
    const checkoutAnchor: CheckoutAnchor = {
      dev: checkout.info.dev,
      ino: checkout.info.ino,
      projectDirectory: {
        dev: projectDirectory.info.dev,
        ino: projectDirectory.info.ino,
      },
      gitMarker:
        gitIdentity === null
          ? null
          : { dev: gitIdentity.dev, ino: gitIdentity.ino },
    };
    const internal = join(checkoutRoot, ".hack", ".internal");
    if (opts.mode !== "saved") {
      try {
        await mkdir(internal, { mode: 0o700 });
      } catch (error) {
        if (!hasCode(error, "EEXIST")) {
          throw error;
        }
      }
    }
    directories.push(await holdDirectory(internal, false));
    const root = join(internal, "native-compose");
    const ownedDirectory = async (path: string) =>
      opts.mode === "saved"
        ? await holdDirectory(path, true)
        : await privateDirectory(path);
    directories.push(await ownedDirectory(root));
    const ignorePath = join(root, ".gitignore");
    const ignore = await privateIgnore(ignorePath, opts.mode !== "saved");
    const instanceId = hash(
      JSON.stringify([
        checkoutRoot,
        checkout.info.dev,
        checkout.info.ino,
        opts.instance,
      ])
    );
    const instanceRoot = join(root, instanceId);
    directories.push(await ownedDirectory(instanceRoot));
    const generationsRoot = join(instanceRoot, "generations");
    const leasesRoot = join(instanceRoot, "leases");
    directories.push(
      await ownedDirectory(generationsRoot),
      await ownedDirectory(leasesRoot)
    );
    const receiptPath = join(instanceRoot, "receipt.json");
    const lockPath = join(instanceRoot, "mutation.lock");
    const recoveryPath = join(instanceRoot, "recovery.lock");
    let closed = false;
    const check = async () => {
      if (closed) {
        refuse();
      }
      await recheckDirectories(directories);
      const currentIgnore = await readPrivate(ignorePath, 2);
      if (
        !sameFile(currentIgnore.info, ignore.info) ||
        currentIgnore.text !== ignore.text
      ) {
        refuse();
      }
      const currentGit = await lstat(gitMarker).catch((error: unknown) => {
        if (hasCode(error, "ENOENT")) {
          return null;
        }
        throw error;
      });
      if (
        gitIdentity === null
          ? currentGit !== null
          : currentGit === null ||
            !sameFile(currentGit, gitIdentity) ||
            (gitIdentity.isFile() && currentGit.ctimeMs !== gitIdentity.ctimeMs)
      ) {
        refuse();
      }
    };
    const { withLock, recoverInterruptedLock } =
      createNativeComposePrivateMutationLock({
        lockPath,
        recoveryPath,
        parent: directories[4],
        check,
      });
    const initialize = async () => {
      let value: unknown;
      try {
        value = await jsonPrivate(receiptPath);
      } catch (error) {
        if (!hasCode(error, "ENOENT")) {
          throw error;
        }
        if (opts.mode === "saved") {
          refuse();
        }
        const initialIdentity = {
          checkoutRoot,
          repositoryRoot,
          instance: opts.instance,
          instanceId,
          composeProject: `hack-nc-${instanceId.slice(0, 32)}`,
          ownerToken: token(),
        };
        value = {
          version: 1,
          identity: initialIdentity,
          checkout: checkoutAnchor,
          current: null,
          stopped: true,
          pending: null,
          beforeHooks: null,
        };
        await writeExclusive(receiptPath, JSON.stringify(value));
        await synchronizeDirectories(directories);
      }
      if (
        !(isRecord(value) && isRecord(value.identity)) ||
        typeof value.identity.ownerToken !== "string" ||
        !TOKEN.test(value.identity.ownerToken)
      ) {
        refuse();
      }
      const identity = Object.freeze({
        checkoutRoot,
        repositoryRoot,
        instance: opts.instance,
        instanceId,
        composeProject: `hack-nc-${instanceId.slice(0, 32)}`,
        ownerToken: value.identity.ownerToken,
      });
      parseReceipt(value, identity, checkoutAnchor);
      return identity;
    };
    const ownedIdentity =
      opts.mode === "saved" ? await initialize() : await withLock(initialize);
    let mutationReceipt: {
      readonly dev: number;
      readonly ino: number;
      readonly text: string;
    } | null = null;
    const receipt = async () => {
      await check();
      const read = await readPrivate(receiptPath, RECEIPT_LIMIT);
      const result = parseReceipt(
        parsePrivateJson(read.text),
        ownedIdentity,
        checkoutAnchor
      );
      await check();
      return result;
    };
    const assertMutationReceipt = async () => {
      if (mutationReceipt === null) {
        return;
      }
      const read = await readPrivate(receiptPath, RECEIPT_LIMIT);
      if (
        !sameFile(read.info, mutationReceipt) ||
        read.text !== mutationReceipt.text
      ) {
        refuse();
      }
    };
    const save = async (state: Receipt) => {
      await receipt();
      await assertMutationReceipt();
      const temporary = join(instanceRoot, `${token()}.receipt.tmp`);
      const text = JSON.stringify(state);
      const stagedInfo = await writeExclusive(temporary, text);
      await check();
      await receipt();
      const staged = await readPrivate(temporary, RECEIPT_LIMIT);
      if (!sameFile(staged.info, stagedInfo) || staged.text !== text) {
        refuse();
      }
      await assertMutationReceipt();
      await rename(temporary, receiptPath);
      if (mutationReceipt !== null) {
        mutationReceipt = { dev: stagedInfo.dev, ino: stagedInfo.ino, text };
      }
      await directories[4]?.file.sync();
      await receipt();
    };
    const known = new WeakMap<NativeComposeGeneration, Manifest>();
    const anchors = new WeakMap<NativeComposeGeneration, GenerationAnchor>();
    const reservations = new WeakSet<NativeComposeReservation>();
    const load = async (
      generationId: string,
      expected?: GenerationAnchor
    ): Promise<NativeComposeGeneration> => {
      if (!TOKEN.test(generationId)) {
        refuse();
      }
      await check();
      const generationRoot = join(generationsRoot, generationId);
      const held = await holdDirectory(generationRoot, true);
      try {
        const manifestRead = await readPrivate(
          join(generationRoot, "manifest.json"),
          RECEIPT_LIMIT
        );
        const anchor: GenerationAnchor = {
          generationId,
          manifestHash: hash(manifestRead.text),
          manifest: { dev: manifestRead.info.dev, ino: manifestRead.info.ino },
        };
        if (expected && JSON.stringify(expected) !== JSON.stringify(anchor)) {
          refuse();
        }
        let value: unknown;
        try {
          value = JSON.parse(manifestRead.text) as unknown;
        } catch {
          return refuse();
        }
        const manifest = parseManifest(value, ownedIdentity, generationId);
        const document = await readPrivate(
          join(generationRoot, "compose.json"),
          NATIVE_COMPOSE_DOCUMENT_LIMIT
        );
        if (
          !sameFile(document.info, manifest.document) ||
          hash(document.text) !== manifest.documentHash
        ) {
          refuse();
        }
        await recheckDirectories([held]);
        await check();
        const generation = Object.freeze({
          identity: ownedIdentity,
          generationId,
          composeFile: join(generationRoot, "compose.json"),
          profiles: Object.freeze([...manifest.profiles]),
        });
        known.set(generation, manifest);
        anchors.set(generation, anchor);
        return generation;
      } finally {
        await held.file.close();
      }
    };
    const verifyGeneration = async (generation: NativeComposeGeneration) => {
      const manifest = known.get(generation);
      if (!manifest) {
        refuse();
      }
      const anchor = anchors.get(generation);
      if (!anchor) {
        refuse();
      }
      const loaded = await load(generation.generationId, anchor);
      if (JSON.stringify(known.get(loaded)) !== JSON.stringify(manifest)) {
        refuse();
      }
    };
    const knownAnchor = (generation: NativeComposeGeneration) => {
      const anchor = anchors.get(generation);
      if (!anchor) {
        return refuse();
      }
      return anchor;
    };
    const finalizeEffect = async <T>(
      input: NativeComposeEffectOptions<T>,
      pending: Receipt["pending"],
      anchor: GenerationAnchor
    ) => {
      if (input.assertFresh) {
        await assertFresh(input.assertFresh);
      }
      await verifyGeneration(input.generation);
      await input.assertOwned();
      let latest = await receipt();
      if (
        JSON.stringify(latest.pending) !== JSON.stringify(pending) ||
        (input.operation !== "down" && latest.beforeHooks !== null)
      ) {
        refuse();
      }
      if (input.beforeComplete) {
        await input.beforeComplete();
        if (input.assertFresh) {
          await assertFresh(input.assertFresh);
        }
        await verifyGeneration(input.generation);
        await input.assertOwned();
        latest = await receipt();
        if (
          JSON.stringify(latest.pending) !== JSON.stringify(pending) ||
          (input.operation !== "down" && latest.beforeHooks !== null)
        ) {
          refuse();
        }
      }
      await save(completedReceipt(latest, anchor, input.operation));
    };
    const assertFresh = async (callback: () => Promise<void>) => {
      try {
        await callback();
      } catch {
        throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_STALE");
      }
      await check();
    };
    return {
      identity: ownedIdentity,
      async loadCurrent() {
        const state = await receipt();
        return {
          generation:
            state.current === null
              ? null
              : await load(state.current.generationId, state.current),
          stopped: state.stopped,
          pending: publicPending(state.pending),
          beforeHooksPending: state.beforeHooks !== null,
          hostHookPhase: state.beforeHooks?.phase ?? null,
        };
      },
      async loadPending() {
        const state = await receipt();
        return state.pending === null
          ? null
          : await load(state.pending.generationId, {
              generationId: state.pending.generationId,
              manifestHash: state.pending.manifestHash,
              manifest: state.pending.manifest,
            });
      },
      async readGenerationDocument(generation) {
        await verifyGeneration(generation);
        const manifest = known.get(generation);
        if (!manifest) {
          return refuse();
        }
        const read = await readPrivate(
          generation.composeFile,
          NATIVE_COMPOSE_DOCUMENT_LIMIT
        );
        if (
          !sameFile(read.info, manifest.document) ||
          hash(read.text) !== manifest.documentHash
        ) {
          refuse();
        }
        let value: unknown;
        try {
          value = JSON.parse(read.text) as unknown;
        } catch {
          return refuse();
        }
        if (
          !(
            isRecord(value) &&
            documentOwned(value, {
              identity: ownedIdentity,
              generationId: generation.generationId,
            })
          )
        ) {
          return refuse();
        }
        await check();
        return Object.freeze(value);
      },
      recoverInterruptedLock,
      async withMutation<T>(
        run: (mutation: NativeComposeMutation) => Promise<T>
      ) {
        return await withLock(async (lease) => {
          const guarded = await readPrivate(receiptPath, RECEIPT_LIMIT);
          parseReceipt(
            parsePrivateJson(guarded.text),
            ownedIdentity,
            checkoutAnchor
          );
          mutationReceipt = {
            dev: guarded.info.dev,
            ino: guarded.info.ino,
            text: guarded.text,
          };
          let active = true;
          let effectOperation: NativeComposeOperation | null = null;
          let activePending: Receipt["pending"] = null;
          const materialReservations = new WeakSet<NativeComposeReservation>();
          const materialAuthority = Object.freeze({});
          const materialWork = new Set<Promise<unknown>>();
          let actionDone: Promise<void> | null = null;
          const requireActive = () => {
            if (!active) {
              refuse();
            }
          };
          materialActions.set(materialAuthority, async (run) => {
            requireActive();
            const work = run();
            materialWork.add(work);
            try {
              return await work;
            } finally {
              materialWork.delete(work);
            }
          });
          const runAction = async <T>(action: () => Promise<T>): Promise<T> => {
            requireActive();
            if (actionDone !== null) {
              throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_BUSY");
            }
            let done = () => {
              /* Assigned synchronously by the Promise constructor. */
            };
            actionDone = new Promise<void>((resolveDone) => {
              done = resolveDone;
            });
            try {
              return await action();
            } finally {
              done();
              actionDone = null;
            }
          };
          const selectMaterialGeneration = async (
            selection: MaterialSelection,
            state: Receipt
          ) => {
            if (["prepare", "source"].includes(selection.phase)) {
              return materialPreparation({
                selection,
                state,
                saved: opts.mode === "saved",
                liveAfterHook: materialSourceHookAllowed(
                  selection,
                  state,
                  effectOperation,
                  activePending
                ),
                reservations: materialReservations,
              });
            }
            if (
              !selection.generation ||
              selection.reservation !== undefined ||
              !["inspect", "effect", "retire"].includes(selection.phase)
            ) {
              return refuse();
            }
            await verifyGeneration(selection.generation);
            const anchor = knownAnchor(selection.generation);
            if (
              !(
                receiptReferencesGeneration(state, anchor) &&
                materialEffectAllowed(
                  selection.phase,
                  effectOperation,
                  state,
                  selection.generation.generationId
                )
              )
            ) {
              return refuse();
            }
            if (
              selection.phase !== "inspect" &&
              (activePending === null ||
                JSON.stringify(state.pending) !== JSON.stringify(activePending))
            ) {
              return refuse();
            }
            return { generationId: selection.generation.generationId, anchor };
          };
          materialAuthorities.set(materialAuthority, async (selection) => {
            requireActive();
            await lease.assertHeld();
            const read = await readPrivate(receiptPath, RECEIPT_LIMIT);
            if (
              mutationReceipt === null ||
              !sameFile(read.info, mutationReceipt) ||
              read.text !== mutationReceipt.text
            ) {
              return refuse();
            }
            const state = parseReceipt(
              parsePrivateJson(read.text),
              ownedIdentity,
              checkoutAnchor
            );
            const { generationId, anchor } = await selectMaterialGeneration(
              selection,
              state
            );
            await lease.assertHeld();
            const latest = await readPrivate(receiptPath, RECEIPT_LIMIT);
            requireActive();
            if (
              !sameFile(read.info, latest.info) ||
              read.text !== latest.text
            ) {
              return refuse();
            }
            return Object.freeze({
              identity: ownedIdentity,
              generationId,
              checkout: frozenCheckout(checkoutAnchor),
              receipt: Object.freeze({
                dev: read.info.dev,
                ino: read.info.ino,
                hash: hash(read.text),
              }),
              lease: Object.freeze({
                token: lease.token,
                directory: lease.directory,
                owner: lease.owner,
              }),
              generation: anchor === null ? null : frozenGeneration(anchor),
              documentHash: materialDocumentHash(selection, known),
              currentGenerationId: state.current?.generationId ?? null,
              pendingGenerationId: state.pending?.generationId ?? null,
              pendingToken: state.pending?.token ?? null,
            });
          });
          const checkEffect = async <T>(
            input: NativeComposeEffectOptions<T>
          ) => {
            requireActive();
            await verifyGeneration(input.generation);
            if (input.assertFresh) {
              await assertFresh(input.assertFresh);
            }
            try {
              await input.assertOwned();
            } catch (error) {
              if (error instanceof NativeComposeGenerationError) {
                throw error;
              }
              refuse();
            }
            await check();
            requireActive();
          };
          const performAfterHooks = async <T>(
            input: NativeComposeEffectOptions<T>,
            pending: NonNullable<Receipt["pending"]>
          ) => {
            if (!input.afterHooks) {
              return refuse();
            }
            await checkEffect(input);
            const execute = await input.afterHooks.prepare();
            await checkEffect(input);
            const state = await receipt();
            if (
              state.beforeHooks !== null ||
              JSON.stringify(state.pending) !== JSON.stringify(pending)
            ) {
              return refuse();
            }
            const intent: HostHookIntent = Object.freeze({
              token: token(),
              phase: "after",
              pendingToken: pending.token,
              generationId: pending.generationId,
              operation: afterHookOperation(input.operation),
            });
            await save({ ...state, beforeHooks: intent });
            await checkEffect(input);
            const result = await execute();
            if (result.outcome === "complete") {
              const latest = await receipt();
              if (
                JSON.stringify(latest.beforeHooks) !== JSON.stringify(intent) ||
                JSON.stringify(latest.pending) !== JSON.stringify(pending)
              ) {
                return refuse();
              }
              await save({ ...latest, beforeHooks: null });
            }
            return result;
          };
          const finishEffect = async <T>(
            input: NativeComposeEffectOptions<T>,
            pending: NonNullable<Receipt["pending"]>,
            anchor: GenerationAnchor,
            result: Awaited<ReturnType<NativeComposeEffectOptions<T>["effect"]>>
          ) => {
            if (result.outcome !== "complete") {
              return result;
            }
            if (input.afterHooks) {
              const after = await performAfterHooks(input, pending);
              if (after.outcome !== "complete" || !after.ready) {
                return { value: after.value, outcome: "uncertain" as const };
              }
            }
            await finalizeEffect(input, pending, anchor);
            return result;
          };
          const mutation: NativeComposeMutation = {
            materialAuthority,
            async runBeforeHooks<T>(input: {
              readonly assertFresh: () => Promise<void>;
              readonly effect: () => Promise<{
                readonly outcome: "complete" | "uncertain";
                readonly value: T;
              }>;
            }) {
              const captured = Object.freeze({ ...input });
              return await runAction(async () => {
                const state = await receipt();
                requireBeforeHooksAdmission(state, opts.mode);
                await assertFresh(captured.assertFresh);
                const beforeHooks = Object.freeze({
                  token: token(),
                  phase: "before" as const,
                });
                await save({ ...state, beforeHooks });
                try {
                  await assertFresh(captured.assertFresh);
                  const result = await captured.effect();
                  if (result.outcome !== "complete") {
                    return result;
                  }
                  const latest = await receipt();
                  if (
                    JSON.stringify(latest.beforeHooks) !==
                    JSON.stringify(beforeHooks)
                  ) {
                    refuse();
                  }
                  await save({ ...latest, beforeHooks: null });
                  return result;
                } catch {
                  throw new NativeComposeGenerationError(
                    "E_NATIVE_COMPOSE_UNCERTAIN"
                  );
                }
              });
            },
            reserveGeneration() {
              requireActive();
              if (opts.mode === "saved") {
                refuse();
              }
              const reservation = Object.freeze({
                identity: ownedIdentity,
                generationId: token(),
              });
              reservations.add(reservation);
              materialReservations.add(reservation);
              return reservation;
            },
            async publish(input) {
              const captured = Object.freeze({
                ...input,
                profiles: Object.freeze([...input.profiles]),
              });
              return await runAction(async () => {
                requireActive();
                if (
                  opts.mode === "saved" ||
                  !reservations.has(captured.reservation) ||
                  !publishInputValid(captured)
                ) {
                  refuse();
                }
                requireDocumentOwned(
                  captured.composeJson,
                  captured.reservation
                );
                const state = await receipt();
                if (state.pending !== null || state.beforeHooks !== null) {
                  throw new NativeComposeGenerationError(
                    "E_NATIVE_COMPOSE_UNCERTAIN"
                  );
                }
                await assertFresh(captured.assertFresh);
                const generationRoot = join(
                  generationsRoot,
                  captured.reservation.generationId
                );
                await mkdir(generationRoot, { mode: 0o700 });
                const held = await holdDirectory(generationRoot, true);
                try {
                  const path = join(generationRoot, "compose.json");
                  await writeExclusive(path, captured.composeJson);
                  const written = await readPrivate(
                    path,
                    NATIVE_COMPOSE_DOCUMENT_LIMIT
                  );
                  const manifest: Manifest = {
                    version: 1,
                    identity: ownedIdentity,
                    generationId: captured.reservation.generationId,
                    profiles: [...captured.profiles],
                    documentHash: hash(captured.composeJson),
                    inputRevision: captured.inputRevision,
                    document: { dev: written.info.dev, ino: written.info.ino },
                  };
                  await writeExclusive(
                    join(generationRoot, "manifest.json"),
                    JSON.stringify(manifest)
                  );
                  await held.file.sync();
                  await directories[5]?.file.sync();
                  await recheckDirectories([held]);
                  await assertFresh(captured.assertFresh);
                  requireActive();
                  reservations.delete(captured.reservation);
                  return await load(captured.reservation.generationId);
                } finally {
                  await held.file.close();
                }
              });
            },
            async runEffect<T>(options: NativeComposeEffectOptions<T>) {
              const input = Object.freeze({ ...options });
              return await runAction(async () => {
                requireActive();
                const state = await receipt();
                admitEffect(input, state, opts.mode);
                await checkEffect(input);
                const anchor = knownAnchor(input.generation);
                const pending: NativeComposePending & GenerationAnchor =
                  state.pending === null
                    ? { ...anchor, token: token(), operation: input.operation }
                    : { ...state.pending, recoveryToken: token() };
                await save({ ...state, pending });
                effectOperation = input.operation;
                activePending = pending;
                try {
                  await checkEffect(input);
                  const result = await input.effect();
                  return await finishEffect(input, pending, anchor, result);
                } catch {
                  throw new NativeComposeGenerationError(
                    "E_NATIVE_COMPOSE_UNCERTAIN"
                  );
                } finally {
                  effectOperation = null;
                  activePending = null;
                }
              });
            },
          };
          Object.defineProperty(mutation, "materialAuthority", {
            enumerable: false,
          });
          Object.freeze(mutation);
          try {
            return await run(mutation);
          } finally {
            active = false;
            materialAuthorities.delete(materialAuthority);
            materialActions.delete(materialAuthority);
            if (actionDone !== null) {
              await actionDone;
            }
            await Promise.allSettled(materialWork);
            mutationReceipt = null;
          }
        });
      },
      async withLease<T>(input: {
        readonly generation: NativeComposeGeneration;
        readonly run: (generation: NativeComposeGeneration) => Promise<T>;
      }) {
        await verifyGeneration(input.generation);
        const leasePath = join(leasesRoot, `${token()}.json`);
        const lease = JSON.stringify({
          version: 1,
          identity: ownedIdentity,
          generationId: input.generation.generationId,
        });
        const leaseInfo = await writeExclusive(leasePath, lease);
        await directories[6]?.file.sync();
        try {
          await verifyGeneration(input.generation);
          return await input.run(input.generation);
        } finally {
          await check();
          const latest = await readPrivate(leasePath, RECEIPT_LIMIT);
          if (!sameFile(latest.info, leaseInfo) || latest.text !== lease) {
            refuse();
          }
          await unlink(leasePath);
          await directories[6]?.file.sync();
        }
      },
      async close() {
        closed = true;
        await Promise.all(directories.map((held) => held.file.close()));
      },
    };
  } catch (error) {
    await Promise.all(directories.map((held) => held.file.close()));
    if (error instanceof NativeComposeGenerationError) {
      throw error;
    }
    throw new NativeComposeGenerationError("E_NATIVE_COMPOSE_STATE");
  }
}
