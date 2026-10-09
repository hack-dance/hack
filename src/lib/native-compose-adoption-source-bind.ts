import { join, resolve } from "node:path";
import { isRecord } from "./guards.ts";
import {
  legacyComposeAdoptionCandidateSupported,
  legacyComposeAdoptionLayoutSupported,
} from "./native-compose-adoption-contract.ts";
import { hasLegacyComposeGeneratedSources } from "./native-compose-adoption-projection.ts";
import {
  type HeldDirectory,
  holdDirectory,
  recheckDirectories,
} from "./native-compose-private-state.ts";
import {
  type NativeConfigImportInputs,
  privateNativeConfigImportSourceProof,
} from "./native-config-import-inputs.ts";
import {
  freezeImportValue,
  mapLegacyNativeRetainedSourceBind,
} from "./native-config-import-plan.ts";

const LIMIT = 16 * 1024;
type Directory = {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly uid: number;
};
/** Private path-incarnation proof. No file contents, directory timestamps, env or keys are captured. */
export type LegacyComposeSourceBindProof = {
  readonly source_bind_version: 1;
  readonly directories: readonly Directory[];
};
type Source = Extract<NativeConfigImportInputs, { readonly ok: true }>;
function refuse(): never {
  throw new Error(
    "Legacy source bind is unsupported, unsafe or changed; values omitted."
  );
}
function check(signal?: AbortSignal) {
  if (signal?.aborted) {
    refuse();
  }
}
function candidatePaths(candidate: unknown): readonly string[] {
  if (
    !(
      legacyComposeAdoptionCandidateSupported(candidate) &&
      isRecord(candidate) &&
      isRecord(candidate.services)
    )
  ) {
    refuse();
  }
  if (
    [
      "jobs",
      "environment",
      "profiles",
      "routes",
      "host",
      "host_bindings",
      "networks",
      "files",
    ].some((key) => Object.hasOwn(candidate, key))
  ) {
    refuse();
  }
  const paths = new Set<string>(["."]);
  let binds = 0;
  for (const service of Object.values(candidate.services)) {
    if (
      !(isRecord(service) && typeof service.image === "string") ||
      [
        "build",
        "profiles",
        "depends_on",
        "readiness",
        "files",
        "networks",
      ].some((key) => Object.hasOwn(service, key)) ||
      (Object.hasOwn(service, "pull_policy") && service.pull_policy !== "never")
    ) {
      refuse();
    }
    if (service.mounts === undefined) {
      continue;
    }
    if (!Array.isArray(service.mounts)) {
      refuse();
    }
    for (const mount of service.mounts) {
      if (!isRecord(mount)) {
        refuse();
      }
      if (!Object.hasOwn(mount, "source")) {
        continue;
      }
      if (
        typeof mount.source !== "string" ||
        mount.source.length > 1024 ||
        mount.source.split("/").length > 32
      ) {
        refuse();
      }
      binds++;
      const parts = mount.source === "." ? [] : mount.source.split("/");
      for (let index = 1; index <= parts.length; index++) {
        paths.add(parts.slice(0, index).join("/"));
      }
      if (binds > 128 || paths.size > 128) {
        refuse();
      }
    }
  }
  if (binds === 0) {
    refuse();
  }
  return [...paths].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)
  );
}
async function requireLayout(
  root: string,
  candidate: unknown,
  signal?: AbortSignal
) {
  check(signal);
  if (
    (await hasLegacyComposeGeneratedSources(root, signal)) ||
    !(await legacyComposeAdoptionLayoutSupported({
      projectRoot: root,
      candidate,
      signal,
    }))
  ) {
    refuse();
  }
  check(signal);
}
async function lease(opts: {
  readonly root: string;
  readonly candidate: unknown;
  readonly proof?: unknown;
  readonly signal?: AbortSignal;
}) {
  const paths = candidatePaths(opts.candidate);
  await requireLayout(opts.root, opts.candidate, opts.signal);
  const held: HeldDirectory[] = [];
  try {
    for (const path of paths) {
      check(opts.signal);
      held.push(
        await holdDirectory(
          path === "." ? opts.root : join(opts.root, path),
          false
        )
      );
    }
    const proof: LegacyComposeSourceBindProof = {
      source_bind_version: 1,
      directories: held.map((item, index) => ({
        path: paths[index] ?? refuse(),
        dev: item.info.dev,
        ino: item.info.ino,
        mode: item.info.mode,
        uid: item.info.uid,
      })),
    };
    const serialized = JSON.stringify(proof);
    if (
      Buffer.byteLength(serialized) > LIMIT ||
      (opts.proof !== undefined && serialized !== JSON.stringify(opts.proof))
    ) {
      refuse();
    }
    freezeImportValue(proof);
    let open = true;
    const assertDirectoriesFresh = async () => {
      check(opts.signal);
      if (!open) {
        refuse();
      }
      for (const item of held) {
        const current = await item.file.stat();
        if (
          !(
            current.isDirectory() &&
            current.dev === item.info.dev &&
            current.ino === item.info.ino &&
            current.mode === item.info.mode &&
            current.uid === item.info.uid
          )
        ) {
          refuse();
        }
      }
      await recheckDirectories(held);
      check(opts.signal);
      if (!open) {
        refuse();
      }
    };
    const assertFresh = async () => {
      check(opts.signal);
      if (!open) {
        refuse();
      }
      // Layout checks can await unrelated input owners. Mounted pathname and
      // descriptor identities must be checked after that final async boundary.
      await requireLayout(opts.root, opts.candidate, opts.signal);
      await assertDirectoriesFresh();
    };
    const close = async () => {
      if (open) {
        open = false;
        await Promise.all(held.map((item) => item.file.close()));
      }
    };
    await assertFresh();
    const result = { proof, assertFresh, assertDirectoriesFresh, close };
    for (const key of Object.keys(result)) {
      Object.defineProperty(result, key, { enumerable: false });
    }
    return Object.freeze(result);
  } catch {
    await Promise.all(held.map((item) => item.file.close()));
    refuse();
  }
}

/** Issued source only. Fresh leases bracket each engine observation; all options are captured before awaiting. */
export async function acquireLegacyComposeSourceBind(opts: {
  readonly source: Source;
  readonly signal?: AbortSignal;
}) {
  try {
    const source = opts.source;
    const signal = opts.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      refuse();
    }
    privateNativeConfigImportSourceProof(source);
    const root = source.projectRoot;
    const candidate = mapLegacyNativeRetainedSourceBind({
      configText: source.configText,
      composeText: source.composeText,
    }).candidate;
    candidatePaths(candidate);
    await source.assertFresh({ signal });
    const initial = await lease({ root, candidate, signal });
    const proof = initial.proof;
    await initial.close();
    const withFresh = async <T>(
      current: { readonly signal?: AbortSignal },
      action: () => Promise<T>
    ): Promise<T> => {
      const selected =
        signal && current.signal
          ? AbortSignal.any([signal, current.signal])
          : (current.signal ?? signal);
      try {
        check(signal);
        await source.assertFresh({ signal: selected });
        const held = await lease({ root, candidate, proof, signal: selected });
        try {
          const result = await action();
          await source.assertFresh({ signal: selected });
          await held.assertFresh();
          check(signal);
          return result;
        } finally {
          await held.close();
        }
      } catch {
        refuse();
      }
    };
    const result = { candidate, proof, withFresh };
    for (const key of Object.keys(result)) {
      Object.defineProperty(result, key, { enumerable: false });
    }
    return Object.freeze(result);
  } catch {
    refuse();
  }
}

/** Held, key-free saved read. The store authenticates the raw source and private proof before calling. */
export async function holdSavedLegacyComposeSourceBind(opts: {
  readonly projectRoot: string;
  readonly configText: string;
  readonly composeText: string;
  readonly proof: unknown;
  readonly signal?: AbortSignal;
}) {
  try {
    const root = resolve(opts.projectRoot);
    const configText = opts.configText;
    const composeText = opts.composeText;
    const signal = opts.signal;
    const proof = JSON.stringify(opts.proof);
    if (
      (signal !== undefined && !(signal instanceof AbortSignal)) ||
      typeof proof !== "string" ||
      Buffer.byteLength(proof) > LIMIT
    ) {
      refuse();
    }
    const candidate = mapLegacyNativeRetainedSourceBind({
      configText,
      composeText,
    }).candidate;
    return await lease({ root, candidate, proof: JSON.parse(proof), signal });
  } catch {
    refuse();
  }
}
