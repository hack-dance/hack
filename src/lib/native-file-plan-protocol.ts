import type {
  FileBinding,
  FilePlan,
} from "../../packages/config-compiler/generated/native-config.ts";
import { isRecord } from "./guards.ts";
import type { NativeConfigDiagnostic } from "./native-config-compiler.ts";
import type {
  NativeDeclaredWorkloads,
  NativeEnvMetadata,
} from "./native-env-plan-protocol.ts";

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const MANAGED_KEY = /^[A-Z_][A-Z0-9_]*$/;
const MODE = /^0[0-7]{3}$/;
const RELATIVE_FORBIDDEN = /[\\\0:]/;
const ABSOLUTE_FORBIDDEN = /[\\\0]/;
export type NativeFilePlan = Readonly<
  Omit<FilePlan, "workloads" | "diagnostics">
> & {
  readonly workloads: Readonly<
    Record<string, readonly Readonly<FileBinding>[]>
  >;
  readonly diagnostics: readonly NativeConfigDiagnostic[];
};

function source(input: Uint8Array): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input)
    );
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Original presence requires negotiation before any authored bytes reach a compiler. */
export function authoredFilePlanningRequired(input: Uint8Array): boolean {
  const project = source(input);
  return project !== undefined && nativeFilePlanningRequired(project);
}

export function nativeFilePlanningRequired(
  plan: Readonly<Record<string, unknown>>
): boolean {
  return (
    Object.hasOwn(plan, "configs") ||
    Object.hasOwn(plan, "secrets") ||
    [plan.services, plan.jobs].some(
      (workloads) =>
        isRecord(workloads) &&
        Object.values(workloads).some(
          (workload) =>
            isRecord(workload) &&
            Array.isArray(workload.mounts) &&
            workload.mounts.some(
              (mount) =>
                isRecord(mount) &&
                (Object.hasOwn(mount, "config") ||
                  Object.hasOwn(mount, "secret"))
            )
        )
    )
  );
}

function only(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function relative(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value ||
    value.startsWith("/") ||
    RELATIVE_FORBIDDEN.test(value) ||
    value.split("/").includes("..")
  ) {
    return undefined;
  }
  const normalized = value
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/");
  return normalized || undefined;
}

function absolute(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    ABSOLUTE_FORBIDDEN.test(value) ||
    value.split("/").includes("..")
  ) {
    return undefined;
  }
  return `/${value
    .split("/")
    .filter((part) => part !== "" && part !== ".")
    .join("/")}`;
}

function definitions(
  value: unknown,
  secret: boolean
): Record<string, unknown> | undefined {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const entries: [string, unknown][] = [];
  for (const [name, definition] of Object.entries(value)) {
    if (!(NAME.test(name) && isRecord(definition))) {
      return undefined;
    }
    if (only(definition, ["file"]) && typeof definition.file === "string") {
      const file = relative(definition.file);
      if (!file) {
        return undefined;
      }
      entries.push([name, { file }]);
    } else if (
      secret &&
      only(definition, ["env_ref"]) &&
      typeof definition.env_ref === "string" &&
      MANAGED_KEY.test(definition.env_ref)
    ) {
      entries.push([name, { env_ref: definition.env_ref }]);
    } else {
      return undefined;
    }
  }
  return Object.fromEntries(entries);
}

function equal(first: unknown, second: unknown): boolean {
  if (Array.isArray(first) && Array.isArray(second)) {
    return (
      first.length === second.length &&
      first.every((value, index) => equal(value, second[index]))
    );
  }
  if (isRecord(first) && isRecord(second)) {
    return (
      Object.keys(first).length === Object.keys(second).length &&
      Object.entries(first).every(
        ([key, value]) =>
          Object.hasOwn(second, key) && equal(value, second[key])
      )
    );
  }
  return first === second;
}

type Grant = {
  readonly kind: "config" | "secret";
  readonly name: string;
  readonly target: string;
  readonly access: "read-only" | "read-write";
  readonly mode: string;
  readonly uid?: number;
  readonly gid?: number;
};

function id(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 0xff_ff_ff_ff
  );
}

function grant(value: unknown): Grant | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const config = Object.hasOwn(value, "config");
  const secret = Object.hasOwn(value, "secret");
  if (
    config === secret ||
    !only(value, [
      config ? "config" : "secret",
      "target",
      "access",
      "mode",
      "uid",
      "gid",
    ])
  ) {
    return undefined;
  }
  const name = config ? value.config : value.secret;
  const target = absolute(value.target);
  const mode = Object.hasOwn(value, "mode") ? value.mode : "0444";
  if (
    !(
      typeof name === "string" &&
      NAME.test(name) &&
      target &&
      target !== "/" &&
      (value.access === "read-only" || value.access === "read-write") &&
      typeof mode === "string" &&
      MODE.test(mode)
    ) ||
    (Object.hasOwn(value, "uid") && !id(value.uid)) ||
    (Object.hasOwn(value, "gid") && !id(value.gid))
  ) {
    return undefined;
  }
  return {
    kind: config ? "config" : "secret",
    name,
    target,
    access: value.access,
    mode,
    ...(id(value.uid) ? { uid: value.uid } : {}),
    ...(id(value.gid) ? { gid: value.gid } : {}),
  };
}

function contains(parent: string, child: string): boolean {
  return parent === "/" || child.startsWith(`${parent}/`);
}

function grants(workload: Record<string, unknown>): Grant[] | undefined {
  if (workload.mounts === undefined) {
    return [];
  }
  if (!Array.isArray(workload.mounts)) {
    return undefined;
  }
  const targets: string[] = [];
  const output: Grant[] = [];
  for (const mount of workload.mounts) {
    if (!isRecord(mount)) {
      return undefined;
    }
    const target = absolute(mount.target);
    if (!target || targets.includes(target)) {
      return undefined;
    }
    targets.push(target);
    if (Object.hasOwn(mount, "config") || Object.hasOwn(mount, "secret")) {
      const parsed = grant(mount);
      if (!parsed) {
        return undefined;
      }
      output.push(parsed);
    }
  }
  return output.some((file) =>
    targets.some(
      (target) => contains(target, file.target) || contains(file.target, target)
    )
  )
    ? undefined
    : output;
}

/** Check canonical compiler output, without acquiring any material or env values. */
export function nativeFilePlanIsValid(opts: {
  readonly plan: Readonly<Record<string, unknown>>;
  readonly declared?: NativeDeclaredWorkloads;
}): boolean {
  if (!nativeFilePlanningRequired(opts.plan)) {
    return true;
  }
  const configs = definitions(opts.plan.configs, false);
  const secrets = definitions(opts.plan.secrets, true);
  if (
    !(
      configs &&
      secrets &&
      opts.declared &&
      equal(configs, opts.plan.configs ?? {}) &&
      equal(secrets, opts.plan.secrets ?? {})
    )
  ) {
    return false;
  }
  for (const [namespace, kind] of [
    ["services", "service"],
    ["jobs", "job"],
  ] as const) {
    const workloads = opts.plan[namespace];
    if (!isRecord(workloads)) {
      return false;
    }
    for (const [name, workload] of Object.entries(workloads)) {
      if (!isRecord(workload)) {
        return false;
      }
      const files = grants(workload);
      if (
        !files ||
        opts.declared[name] !== kind ||
        files.some(
          (file) =>
            !Object.hasOwn(
              file.kind === "config" ? configs : secrets,
              file.name
            )
        )
      ) {
        return false;
      }
      if (
        files.some(
          (file) =>
            !(
              Array.isArray(workload.mounts) &&
              workload.mounts.some(
                (mount) =>
                  isRecord(mount) &&
                  mount[file.kind] === file.name &&
                  mount.target === file.target &&
                  mount.mode === file.mode
              )
            )
        )
      ) {
        return false;
      }
    }
  }
  return true;
}

function active(
  workload: Record<string, unknown>,
  profiles: readonly string[]
): boolean | undefined {
  if (workload.profiles === undefined) {
    return true;
  }
  if (
    !(
      Array.isArray(workload.profiles) &&
      workload.profiles.every((profile) => typeof profile === "string")
    )
  ) {
    return undefined;
  }
  return (
    workload.profiles.length === 0 ||
    workload.profiles.some((profile) => profiles.includes(profile))
  );
}

function sourceNamespaceMatches(opts: {
  readonly authored: Record<string, unknown>;
  readonly planned: Record<string, unknown>;
  readonly declared: NativeDeclaredWorkloads;
  readonly kind: "service" | "job";
  readonly profiles: readonly string[];
  readonly seen: Set<string>;
  readonly configs: Record<string, unknown>;
  readonly secrets: Record<string, unknown>;
}): boolean {
  for (const [name, workload] of Object.entries(opts.authored)) {
    if (
      !isRecord(workload) ||
      opts.seen.has(name) ||
      opts.declared[name] !== opts.kind
    ) {
      return false;
    }
    opts.seen.add(name);
    const selected = active(workload, opts.profiles);
    const files = grants(workload);
    if (
      selected === undefined ||
      !files ||
      files.some(
        (file) =>
          !Object.hasOwn(
            file.kind === "config" ? opts.configs : opts.secrets,
            file.name
          )
      ) ||
      selected !== Object.hasOwn(opts.planned, name)
    ) {
      return false;
    }
    const planned = opts.planned[name];
    if (selected && !(isRecord(planned) && equal(files, grants(planned)))) {
      return false;
    }
  }
  return Object.keys(opts.planned).every((name) =>
    Object.hasOwn(opts.authored, name)
  );
}

/** Reject missing, added or changed sources/grants, including omitted inactive declarations. */
export function nativeFileSourceMatches(opts: {
  readonly input: Uint8Array;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly declared?: NativeDeclaredWorkloads;
  readonly profiles?: readonly string[];
}): boolean {
  const project = source(opts.input);
  if (
    !(
      nativeFilePlanningRequired(opts.plan) ||
      (project && nativeFilePlanningRequired(project))
    )
  ) {
    return true;
  }
  if (!(project && opts.declared && nativeFilePlanIsValid(opts))) {
    return false;
  }
  if (!equal([...(opts.profiles ?? [])].sort(), opts.plan.selected_profiles)) {
    return false;
  }
  const configs = definitions(project.configs, false);
  const secrets = definitions(project.secrets, true);
  if (
    !(
      configs &&
      secrets &&
      equal(configs, definitions(opts.plan.configs, false)) &&
      equal(secrets, definitions(opts.plan.secrets, true))
    )
  ) {
    return false;
  }
  const seen = new Set<string>();
  for (const [namespace, kind] of [
    ["services", "service"],
    ["jobs", "job"],
  ] as const) {
    const authored = project[namespace] ?? {};
    const planned = opts.plan[namespace];
    if (!(isRecord(authored) && isRecord(planned))) {
      return false;
    }
    if (
      !sourceNamespaceMatches({
        authored,
        planned,
        declared: opts.declared,
        kind,
        profiles: opts.profiles ?? [],
        seen,
        configs,
        secrets,
      })
    ) {
      return false;
    }
  }
  return seen.size === Object.keys(opts.declared).length;
}

function bindingSource(
  file: Grant,
  plan: Readonly<Record<string, unknown>>,
  baseline: NativeEnvMetadata["workloads"][string]
): FileBinding["source"] | undefined {
  const definitions = file.kind === "config" ? plan.configs : plan.secrets;
  const definition = isRecord(definitions) ? definitions[file.name] : undefined;
  if (!isRecord(definition)) {
    return undefined;
  }
  if (typeof definition.file === "string") {
    return { kind: "file", file: definition.file };
  }
  const key = definition.env_ref;
  const metadata = typeof key === "string" ? baseline[key] : undefined;
  return metadata && typeof key === "string"
    ? { kind: "managed", key, scope: metadata.scope, secret: metadata.secret }
    : undefined;
}

type ExpectedFiles = {
  readonly workloads: Record<string, FileBinding[]>;
  readonly missing: string[];
};

function workloadFiles(opts: {
  readonly workload: Record<string, unknown>;
  readonly baseline: NativeEnvMetadata["workloads"][string];
  readonly plan: Readonly<Record<string, unknown>>;
  readonly pointer: string;
}): { readonly bindings: FileBinding[]; readonly missing: string[] } | null {
  const mounts = opts.workload.mounts ?? [];
  if (!Array.isArray(mounts)) {
    return null;
  }
  const bindings: FileBinding[] = [];
  const missing: string[] = [];
  for (const [index, mount] of mounts.entries()) {
    if (
      !(
        isRecord(mount) &&
        (Object.hasOwn(mount, "config") || Object.hasOwn(mount, "secret"))
      )
    ) {
      continue;
    }
    const file = grant(mount);
    if (!file) {
      return null;
    }
    const source = bindingSource(file, opts.plan, opts.baseline);
    if (!source) {
      missing.push(`${opts.pointer}/mounts/${index}/secret`);
      continue;
    }
    const { kind, name, ...permissions } = file;
    bindings.push({ kind, name, source, ...permissions });
  }
  return { bindings, missing };
}

function expectedFiles(
  plan: Readonly<Record<string, unknown>>,
  metadata: NativeEnvMetadata
): ExpectedFiles | null {
  const expected: ExpectedFiles = { workloads: {}, missing: [] };
  for (const namespace of ["services", "jobs"]) {
    const workloads = plan[namespace];
    if (!isRecord(workloads)) {
      return null;
    }
    for (const [name, workload] of Object.entries(workloads)) {
      const baseline = metadata.workloads[name];
      if (!(isRecord(workload) && baseline)) {
        return null;
      }
      const files = workloadFiles({
        workload,
        baseline,
        plan,
        pointer: `/${namespace}/${name}`,
      });
      if (!files) {
        return null;
      }
      if (files.bindings.length > 0) {
        expected.workloads[name] = files.bindings;
      }
      expected.missing.push(...files.missing);
    }
  }
  return expected;
}

/** Reconcile the separate file authority against captured owner metadata, never env delivery. */
export function parseNativeFilePlan(opts: {
  readonly value: unknown;
  readonly plan: Readonly<Record<string, unknown>>;
  readonly metadata: NativeEnvMetadata;
  readonly parseDiagnostic: (value: unknown) => NativeConfigDiagnostic;
}): NativeFilePlan | undefined | null {
  if (!nativeFilePlanningRequired(opts.plan)) {
    return opts.value === undefined ? undefined : null;
  }
  const captured = expectedFiles(opts.plan, opts.metadata);
  if (!captured) {
    return null;
  }
  const { workloads: expected, missing } = captured;
  const value = opts.value;
  if (
    !(
      isRecord(value) &&
      only(value, ["plan_version", "complete", "workloads", "diagnostics"]) &&
      value.plan_version === 1 &&
      value.complete === (missing.length === 0) &&
      equal(value.workloads, expected) &&
      Array.isArray(value.diagnostics)
    )
  ) {
    return null;
  }
  const diagnostics = value.diagnostics.map(opts.parseDiagnostic);
  if (
    diagnostics.length !== missing.length ||
    diagnostics.some(
      (diagnostic, index) =>
        diagnostic.code !== "missing_env_reference" ||
        diagnostic.pointer !== missing[index] ||
        diagnostic.document !== "project"
    )
  ) {
    return null;
  }
  return {
    plan_version: 1,
    complete: missing.length === 0,
    workloads: expected,
    diagnostics,
  };
}
