import { createHash } from "node:crypto";
import { join } from "node:path";
import type { FileBinding } from "../../packages/config-compiler/generated/native-config.ts";
import {
  type HeldNativeComposeFile,
  holdNativeComposeFile,
  NATIVE_COMPOSE_FILE_BYTES_LIMIT,
  refuseNativeComposeFile,
} from "./native-compose-file-bytes.ts";
import { assertNativeComposeFileSubset } from "./native-compose-file-subset.ts";
import {
  assertNativeComposeMaterialAuthority,
  type NativeComposeMaterialAuthority,
  type NativeComposeReservation,
} from "./native-compose-generation.ts";
import {
  type NativeComposeExecutionInputs,
  nativeComposeSourceRevision,
} from "./native-compose-inputs.ts";
import {
  type HeldDirectory,
  holdDirectory,
  recheckDirectories,
  sameFile,
} from "./native-compose-private-state.ts";
import {
  NativeConfigCompilerError,
  type NativeConfigPlanResult,
} from "./native-config-compiler.ts";
import {
  type NativeProjectSelection,
  planPreparedNativeProject,
  prepareNativeProjectSelection,
} from "./native-project-validation.ts";
import {
  acquireProjectEnvForNativeExecution,
  type NativeProjectEnvSelectionOptions,
  selectProjectEnvValuesForNativeExecutionTarget,
} from "./project-env-config.ts";

type Planned = Extract<NativeConfigPlanResult, { readonly ok: true }>;
/** Public names-only result. Private bytes remain in a branded, revocable acquisition. */
export type NativeComposeFileSources = { readonly result: Planned };
export type NativeComposeAcquiredFile = {
  readonly workload: string;
  readonly binding: Readonly<FileBinding>;
  readonly bytes: Uint8Array;
};
type SourceState = {
  readonly authority: NativeComposeMaterialAuthority;
  readonly reservation: NativeComposeReservation;
  readonly members: readonly NativeComposeAcquiredFile[];
  readonly revision: string;
  readonly inputs: NativeComposeExecutionInputs;
  readonly assertFresh: () => Promise<void>;
  readonly close: () => Promise<void>;
};
const acquisitions = new WeakMap<NativeComposeFileSources, SourceState>();
function freeze(value: unknown): void {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) {
      freeze(child);
    }
    Object.freeze(value);
  }
}
const RELATIVE_FORBIDDEN = /[\\\0:]/;
function relativeParts(path: string): readonly string[] {
  const parts = path.split("/");
  if (
    !path ||
    path.startsWith("/") ||
    RELATIVE_FORBIDDEN.test(path) ||
    parts.some((part) => !part || part === "." || part === "..")
  ) {
    return refuseNativeComposeFile();
  }
  return parts;
}
async function fileSource(opts: {
  readonly root: string;
  readonly binding: Readonly<FileBinding>;
  readonly directories: HeldDirectory[];
  readonly remaining: number;
}): Promise<HeldNativeComposeFile> {
  if (opts.binding.source.kind !== "file") {
    return refuseNativeComposeFile();
  }
  const parts = relativeParts(opts.binding.source.file);
  let parent = opts.root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    if (!opts.directories.some((held) => held.path === parent)) {
      opts.directories.push(await holdDirectory(parent, false));
    }
  }
  return await holdNativeComposeFile({
    path: join(opts.root, ...parts),
    modes: opts.binding.kind === "secret" ? [0o400, 0o600] : [],
    limit: opts.remaining,
  });
}
function selectionForEnv(
  prepared: Awaited<ReturnType<typeof prepareNativeProjectSelection>>
): NativeProjectEnvSelectionOptions {
  const resolved = prepared.result;
  if (!(resolved.ok && resolved.declared_workloads)) {
    return refuseNativeComposeFile();
  }
  return {
    projectRoot: prepared.projectRoot,
    overlay: resolved.local_resolution.overlay,
    inheritLocal: resolved.local_resolution.inherit_local,
    declaredWorkloadNames: Object.keys(resolved.declared_workloads),
    ...(resolved.host_env_targets === undefined
      ? {}
      : {
          hostTargets: {
            includeDefault: resolved.host_env_targets.include_default,
            workloadNames: resolved.host_env_targets.workloads,
          },
        }),
    signal: prepared.selection.signal,
  };
}
async function acquireMembers(opts: {
  readonly planned: Planned;
  readonly values: Awaited<
    ReturnType<
      Awaited<
        ReturnType<typeof acquireProjectEnvForNativeExecution>
      >["resolveValues"]
    >
  > | null;
  readonly metadata: Awaited<
    ReturnType<typeof acquireProjectEnvForNativeExecution>
  >["metadata"];
  readonly root: string;
  readonly directories: HeldDirectory[];
  readonly files: HeldNativeComposeFile[];
  readonly members: NativeComposeAcquiredFile[];
  readonly checkAuthority: () => Promise<unknown>;
}): Promise<void> {
  const {
    planned,
    values,
    metadata,
    directories,
    files,
    members,
    checkAuthority,
  } = opts;
  if (!planned.file_plan) {
    refuseNativeComposeFile();
  }
  let total = 0;
  for (const [workload, grants] of Object.entries(
    planned.file_plan.workloads
  )) {
    for (const grant of grants) {
      let bytes: Uint8Array;
      if (grant.source.kind === "file") {
        const file = await fileSource({
          root: opts.root,
          binding: grant,
          directories,
          remaining: NATIVE_COMPOSE_FILE_BYTES_LIMIT - total,
        });
        files.push(file);
        bytes = Buffer.from(file.bytes);
      } else {
        const value = values?.workloadEnv[workload]?.[grant.source.key];
        const selectedMetadata =
          metadata.effectiveMetadata[workload]?.[grant.source.key];
        if (
          typeof value !== "string" ||
          !selectedMetadata ||
          selectedMetadata.scope !== grant.source.scope ||
          selectedMetadata.secret !== grant.source.secret
        ) {
          return refuseNativeComposeFile();
        }
        if (
          Buffer.byteLength(value) >
          NATIVE_COMPOSE_FILE_BYTES_LIMIT - total
        ) {
          return refuseNativeComposeFile();
        }
        bytes = Buffer.from(value, "utf8");
      }
      total += bytes.length;
      members.push({ workload, binding: grant, bytes });
      await checkAuthority();
    }
  }
}
/**
 * Actual acquisition, not a caller-provided plan/value resolver. It anchors the current
 * checkout and managed baseline, preserves empty/binary bytes and holds source FDs.
 * This capability is not wired into any command until owner and engine qualification.
 */
export async function acquireNativeComposeFileSources(opts: {
  readonly authority: NativeComposeMaterialAuthority;
  readonly reservation: NativeComposeReservation;
  readonly profiles?: readonly string[];
  readonly explicitOverlay?: string | null;
  readonly explicitDomain?: string;
  readonly signal?: AbortSignal;
}): Promise<NativeComposeFileSources> {
  const authority = opts.authority;
  const reservation = opts.reservation;
  const signal = opts.signal;
  const profiles = [...(opts.profiles ?? [])];
  const explicitOverlay = opts.explicitOverlay;
  const explicitDomain = opts.explicitDomain;
  const checkAuthority = () =>
    assertNativeComposeMaterialAuthority({
      authority,
      reservation,
      phase: "source",
    });
  const binding = await checkAuthority();
  const selection: NativeProjectSelection = {
    startDir: binding.identity.checkoutRoot,
    profiles,
    explicitOverlay,
    explicitDomain,
    signal,
  };
  const prepare = () =>
    prepareNativeProjectSelection({ ...selection, requireEnvPlanning: true });
  const directories: HeldDirectory[] = [];
  const files: HeldNativeComposeFile[] = [];
  const members: NativeComposeAcquiredFile[] = [];
  let ticket: NativeComposeFileSources | undefined;
  let active = true;
  const close = async () => {
    active = false;
    if (ticket) {
      acquisitions.delete(ticket);
    }
    for (const member of members) {
      member.bytes.fill(0);
    }
    await Promise.allSettled([
      ...files.map((file) => file.close()),
      ...directories.map((held) => held.file.close()),
    ]);
  };
  try {
    const prepared = await prepare();
    if (
      !prepared.result.ok ||
      prepared.projectRoot !== binding.identity.checkoutRoot
    ) {
      return refuseNativeComposeFile();
    }
    assertNativeComposeFileSubset(prepared.input);
    await checkAuthority();
    const checkout = await holdDirectory(prepared.projectRoot, false);
    directories.push(checkout);
    if (!sameFile(checkout.info, binding.checkout)) {
      return refuseNativeComposeFile();
    }
    const envSelection = selectionForEnv(prepared);
    const env = await acquireProjectEnvForNativeExecution(envSelection);
    const planned = await planPreparedNativeProject({
      prepared,
      metadata: env.metadata,
      signal,
    });
    if (
      !(
        planned.ok &&
        planned.environment_plan.complete &&
        planned.file_plan?.complete
      )
    ) {
      return refuseNativeComposeFile();
    }
    const revision = nativeComposeSourceRevision(prepared);
    const assertFresh = async () => {
      if (!active || signal?.aborted) {
        return refuseNativeComposeFile();
      }
      await checkAuthority();
      await recheckDirectories(directories);
      const current = await prepare();
      if (
        !current.result.ok ||
        current.projectRoot !== prepared.projectRoot ||
        nativeComposeSourceRevision(current) !== revision
      ) {
        return refuseNativeComposeFile();
      }
      await env.assertFresh(envSelection);
      for (const file of files) {
        await file.assertFresh();
      }
      await recheckDirectories(directories);
      await checkAuthority();
    };
    await assertFresh();
    const needsValues = Object.values(planned.file_plan.workloads).some(
      (grants) => grants.some((grant) => grant.source.kind === "managed")
    );
    const values = needsValues ? await env.resolveValues({ signal }) : null;
    await assertFresh();
    await acquireMembers({
      planned,
      values,
      metadata: env.metadata,
      root: prepared.projectRoot,
      directories,
      files,
      members,
      checkAuthority,
    });
    await assertFresh();
    freeze(planned);
    const digest = createHash("sha256").update(revision);
    for (const member of members) {
      digest.update(
        JSON.stringify({ workload: member.workload, binding: member.binding })
      );
      digest.update(member.bytes);
    }
    ticket = Object.freeze({ result: planned });
    const resolvedValues = async () => {
      await assertFresh();
      const resolved = values ?? (await env.resolveValues({ signal }));
      await assertFresh();
      return resolved;
    };
    const resolveManagedValues = async () => {
      const resolved = await resolvedValues();
      return Object.fromEntries(
        Object.keys(planned.environment_plan.workloads).map((name) => {
          const selected = resolved.workloadEnv[name];
          if (selected === undefined) {
            return refuseNativeComposeFile();
          }
          return [name, selected];
        })
      );
    };
    const resolveHostValues = async (name: string) => {
      const reports = planned.environment_plan.host;
      if (!(reports && Object.hasOwn(reports, name))) {
        return refuseNativeComposeFile();
      }
      const report = reports[name];
      if (!report) {
        return refuseNativeComposeFile();
      }
      return selectProjectEnvValuesForNativeExecutionTarget({
        resolved: await resolvedValues(),
        target: "host",
        workloadName:
          report.env_target.kind === "workload" ? report.env_target.name : null,
      });
    };
    const inputs = Object.freeze(
      Object.defineProperties(
        { result: planned } as NativeComposeExecutionInputs,
        {
          inputRevision: { value: revision },
          assertFresh: { value: assertFresh },
          resolveManagedValues: { value: resolveManagedValues },
          resolveHostValues: { value: resolveHostValues },
        }
      )
    );
    acquisitions.set(ticket, {
      authority,
      reservation,
      members,
      revision: digest.digest("hex"),
      inputs,
      assertFresh,
      close,
    });
    return ticket;
  } catch (error) {
    await close();
    if (
      error instanceof NativeConfigCompilerError &&
      error.code === "E_NATIVE_PROJECT_UNSUPPORTED"
    ) {
      throw error;
    }
    return refuseNativeComposeFile();
  }
}
function stateFor(opts: {
  readonly sources: NativeComposeFileSources;
  readonly authority: NativeComposeMaterialAuthority;
  readonly reservation: NativeComposeReservation;
}): SourceState {
  const state = acquisitions.get(opts.sources);
  if (
    !state ||
    state.authority !== opts.authority ||
    state.reservation !== opts.reservation
  ) {
    return refuseNativeComposeFile();
  }
  return state;
}
export async function assertNativeComposeFileSources(opts: {
  readonly sources: NativeComposeFileSources;
  readonly authority: NativeComposeMaterialAuthority;
  readonly reservation: NativeComposeReservation;
}): Promise<string> {
  const state = stateFor(opts);
  await state.assertFresh();
  return state.revision;
}
/** Private ordinary env/hook delivery shares the actual acquired managed baseline owner. */
export async function acquireNativeComposeFileDeliveryInputs(opts: {
  readonly sources: NativeComposeFileSources;
  readonly authority: NativeComposeMaterialAuthority;
  readonly reservation: NativeComposeReservation;
}): Promise<NativeComposeExecutionInputs> {
  const state = stateFor(opts);
  await state.assertFresh();
  return state.inputs;
}
/** Private byte handoff to the material owner; copied buffers are wiped after the owned callback. */
export async function withNativeComposeFileBytes<T>(opts: {
  readonly sources: NativeComposeFileSources;
  readonly authority: NativeComposeMaterialAuthority;
  readonly reservation: NativeComposeReservation;
  readonly run: (members: readonly NativeComposeAcquiredFile[]) => Promise<T>;
}): Promise<T> {
  const state = stateFor(opts);
  const run = opts.run;
  await state.assertFresh();
  const members = state.members.map((member) =>
    Object.freeze({ ...member, bytes: Buffer.from(member.bytes) })
  );
  try {
    const result = await run(members);
    await state.assertFresh();
    return result;
  } finally {
    for (const member of members) {
      member.bytes.fill(0);
    }
  }
}
export async function closeNativeComposeFileSources(
  sources: NativeComposeFileSources
): Promise<void> {
  await acquisitions.get(sources)?.close();
}
