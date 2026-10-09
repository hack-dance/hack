/** Closed value-free graph4 storage assertions. Parsing grants no data effect authority. */
export type NativePersistentReference = {
  readonly binding: {
    readonly scope: {
      readonly namespace: string;
      readonly storage: string;
      readonly owner: string;
    };
    readonly guest: {
      readonly owner: string;
      readonly boot_id: string;
      readonly storage: {
        readonly device: number;
        readonly inode: number;
        readonly bytes: number;
        readonly uuid: string;
      };
    };
    readonly policy: {
      readonly driver: "local";
      readonly scope: "local";
      readonly options: Readonly<Record<string, never>>;
    };
  };
  readonly state:
    | { readonly status: "reserved"; readonly intent: string }
    | {
        readonly status: "enrolled";
        readonly volume: {
          readonly name: string;
          readonly created_at: string;
          readonly directory: {
            readonly device: number;
            readonly inode: number;
          };
        };
      };
};
export type NativePersistentMount = {
  readonly storage: string;
  readonly target: string;
  readonly read_only: boolean;
};
const HEX32 = /^[0-9a-f]{32}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z0-9][a-z0-9._-]*$/;
const BIRTH = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const NONZERO_DIGIT = /[1-9]/;
function refused(): never {
  throw new Error(
    "Native persistent data response is invalid or changed; values omitted."
  );
}
function record(value: unknown, expected?: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return refused();
  }
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return refused();
  }
  const keys = Object.keys(descriptors);
  if (Reflect.ownKeys(descriptors).length !== keys.length) {
    return refused();
  }
  if (
    expected !== undefined &&
    keys.sort().join(",") !== expected.split(",").sort().join(",")
  ) {
    return refused();
  }
  for (const descriptor of Object.values(descriptors)) {
    if (!(Object.hasOwn(descriptor, "value") && descriptor.enumerable)) {
      return refused();
    }
  }
  return Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value]));
}
function array(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    return refused();
  }
  let descriptors: Record<string, PropertyDescriptor>;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return refused();
  }
  const length: unknown = descriptors.length?.value;
  if (
    typeof length !== "number" ||
    !Number.isSafeInteger(length) ||
    length <= 0 ||
    Reflect.ownKeys(descriptors).length !== length + 1
  ) {
    return refused();
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const item = descriptors[String(index)];
    if (!(item && Object.hasOwn(item, "value") && item.enumerable)) {
      return refused();
    }
    result.push(item.value);
  }
  return result;
}
function hex(value: unknown, length: 32 | 64): string {
  if (
    typeof value !== "string" ||
    value.length !== length ||
    !(length === 32 ? HEX32 : HEX64).test(value)
  ) {
    return refused();
  }
  return value;
}
function uuid(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length !== 36 ||
    !UUID.test(value) ||
    value === "00000000-0000-0000-0000-000000000000"
  ) {
    return refused();
  }
  return value;
}
function integer(value: unknown, nonzero = false): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < (nonzero ? 1 : 0)
  ) {
    return refused();
  }
  return value;
}
function name(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 63 ||
    !NAME.test(value) ||
    value.endsWith("\n")
  ) {
    return refused();
  }
  return value;
}
function birth(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 20 ||
    value.length > 30 ||
    !BIRTH.test(value) ||
    value.endsWith("\n")
  ) {
    return refused();
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  let days = 31;
  if (month === 2) {
    days = leap ? 29 : 28;
  } else if ([4, 6, 9, 11].includes(month)) {
    days = 30;
  }
  if (
    year === 0 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > days ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    (year === 1 &&
      month === 1 &&
      day === 1 &&
      hour === 0 &&
      minute === 0 &&
      second === 0 &&
      !NONZERO_DIGIT.test(value.slice(20, -1)))
  ) {
    return refused();
  }
  return value;
}
type ParseOptions = {
  readonly data: unknown;
  readonly mounts: unknown;
  readonly namespace: string;
  readonly owner: string;
  readonly boot: string;
  readonly workloads: readonly string[];
  readonly enrolled: boolean;
};
function parseReference({
  logical,
  unknownReference,
  opts,
}: {
  readonly logical: string;
  readonly unknownReference: unknown;
  readonly opts: ParseOptions;
}): NativePersistentReference {
  name(logical);
  const item = record(unknownReference, "binding,state");
  const header = record(item.state);
  if (header.status !== "reserved" && header.status !== "enrolled") {
    return refused();
  }
  const state = record(
    item.state,
    header.status === "reserved" ? "status,intent" : "status,volume"
  );
  const binding = record(item.binding, "scope,guest,policy");
  const scope = record(binding.scope, "namespace,storage,owner");
  const guest = record(binding.guest, "owner,boot_id,storage");
  const disk = record(guest.storage, "device,inode,bytes,uuid");
  const policy = record(binding.policy, "driver,scope,options");
  record(policy.options, "");
  if (
    scope.namespace !== opts.namespace ||
    scope.storage !== logical ||
    guest.owner !== opts.owner ||
    guest.boot_id !== opts.boot ||
    policy.driver !== "local" ||
    policy.scope !== "local"
  ) {
    return refused();
  }
  const parsedBinding = Object.freeze({
    scope: Object.freeze({
      namespace: hex(scope.namespace, 64),
      storage: logical,
      owner: hex(scope.owner, 32),
    }),
    guest: Object.freeze({
      owner: hex(guest.owner, 32),
      boot_id: uuid(guest.boot_id),
      storage: Object.freeze({
        device: integer(disk.device),
        inode: integer(disk.inode, true),
        bytes: integer(disk.bytes, true),
        uuid: uuid(disk.uuid),
      }),
    }),
    policy: Object.freeze({
      driver: "local" as const,
      scope: "local" as const,
      options: Object.freeze({}),
    }),
  });
  let parsed: NativePersistentReference;
  if (state.status === "reserved") {
    if (opts.enrolled) {
      return refused();
    }
    parsed = Object.freeze({
      binding: parsedBinding,
      state: Object.freeze({
        status: "reserved",
        intent: hex(state.intent, 32),
      }),
    });
  } else {
    const volume = record(state.volume, "name,created_at,directory");
    const directory = record(volume.directory, "device,inode");
    const expected = `hkp-${parsedBinding.scope.namespace}-${parsedBinding.scope.owner}-${logical}`;
    if (volume.name !== expected) {
      return refused();
    }
    parsed = Object.freeze({
      binding: parsedBinding,
      state: Object.freeze({
        status: "enrolled",
        volume: Object.freeze({
          name: expected,
          created_at: birth(volume.created_at),
          directory: Object.freeze({
            device: integer(directory.device),
            inode: integer(directory.inode, true),
          }),
        }),
      }),
    });
  }
  return parsed;
}
export function parseNativePersistentData(opts: ParseOptions): {
  readonly data: Readonly<Record<string, NativePersistentReference>>;
  readonly data_mounts: Readonly<
    Record<string, readonly NativePersistentMount[]>
  >;
} {
  const declared = record(opts.data);
  const data: Record<string, NativePersistentReference> = {};
  for (const [logical, unknownReference] of Object.entries(declared).sort(
    ([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right))
  )) {
    const parsed = parseReference({ logical, unknownReference, opts });
    Object.defineProperty(data, logical, { value: parsed, enumerable: true });
  }
  const declaredMounts = record(opts.mounts);
  const mounts: Record<string, readonly NativePersistentMount[]> = {};
  const used = new Set<string>();
  for (const [workload, value] of Object.entries(declaredMounts).sort(
    ([left], [right]) => Buffer.compare(Buffer.from(left), Buffer.from(right))
  )) {
    if (!opts.workloads.includes(workload)) {
      return refused();
    }
    const targets = new Set<string>();
    const parsed = array(value).map((mount: unknown) => {
      const item = record(mount, "storage,target,read_only");
      const storage = name(item.storage);
      if (
        !Object.hasOwn(data, storage) ||
        typeof item.target !== "string" ||
        !item.target.startsWith("/") ||
        item.target.includes("\0") ||
        item.target.includes("\\") ||
        item.target
          .slice(1)
          .split("/")
          .some((part) => part === "" || part === "." || part === "..") ||
        targets.has(item.target) ||
        typeof item.read_only !== "boolean"
      ) {
        return refused();
      }
      targets.add(item.target);
      used.add(storage);
      return Object.freeze({
        storage,
        target: item.target,
        read_only: item.read_only,
      });
    });
    Object.defineProperty(mounts, workload, {
      value: Object.freeze(parsed),
      enumerable: true,
    });
  }
  if (
    Object.keys(data).length === 0 ||
    Object.keys(mounts).length === 0 ||
    used.size !== Object.keys(data).length
  ) {
    return refused();
  }
  return { data: Object.freeze(data), data_mounts: Object.freeze(mounts) };
}

/** Inactive graph4 tool assertion; parsing cannot install or invoke this artifact. */
export type NativePersistentTool = {
  readonly version: 1;
  readonly artifact: string;
  readonly bytes: number;
  readonly root: { readonly device: number; readonly inode: number } | null;
  readonly helper: { readonly device: number; readonly inode: number } | null;
};
export function parseNativePersistentTool(
  value: unknown
): NativePersistentTool {
  const tool = record(value, "version,artifact,bytes,root,helper");
  if (
    tool.version !== 1 ||
    typeof tool.artifact !== "string" ||
    tool.artifact.length !== 64 ||
    !HEX64.test(tool.artifact) ||
    typeof tool.bytes !== "number" ||
    !Number.isSafeInteger(tool.bytes) ||
    tool.bytes <= 0 ||
    tool.bytes > 2 * 1024 * 1024
  ) {
    return refused();
  }
  function identity(
    value: unknown
  ): { readonly device: number; readonly inode: number } | null {
    if (value === null) {
      return null;
    }
    const id = record(value, "device,inode");
    if (
      typeof id.device !== "number" ||
      !Number.isSafeInteger(id.device) ||
      id.device < 0 ||
      typeof id.inode !== "number" ||
      !Number.isSafeInteger(id.inode) ||
      id.inode <= 0
    ) {
      return refused();
    }
    return Object.freeze({ device: id.device, inode: id.inode });
  }
  const root = identity(tool.root);
  const helper = identity(tool.helper);
  if (helper !== null && root === null) {
    return refused();
  }
  return Object.freeze({
    version: 1,
    artifact: tool.artifact,
    bytes: tool.bytes,
    root,
    helper,
  });
}
