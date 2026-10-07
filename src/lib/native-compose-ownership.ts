import { isRecord } from "./guards.ts";
import { findExecutableInPath } from "./shell.ts";

const PROJECT = /^[a-z0-9][a-z0-9_-]*$/;
const SERVICE = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
const GENERATION = /^[a-f0-9]{32}$/;
const ID = /^[a-f0-9]{64}$/;
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const STDERR_LIMIT = 16 * 1024;
const ARGUMENT_LIMIT = 16 * 1024;
const DEFAULT_TIMEOUT_MS = 15_000;
const PROJECT_LABEL = "com.docker.compose.project";
const PREFIX = "io.hack.native-config";

type Kind = "container" | "volume" | "network";
type Inventory = {
  readonly id: string;
  readonly name: string;
  readonly project: string;
};
const FORMATS = {
  container: {
    list: `{"id":{{json .ID}},"name":{{json .Names}},"project":{{json (.Label "${PROJECT_LABEL}")}}}`,
    inspect: `{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Config.Labels "${PROJECT_LABEL}")}},"version":{{json (index .Config.Labels "${PREFIX}.version")}},"instance":{{json (index .Config.Labels "${PREFIX}.instance")}},"owner":{{json (index .Config.Labels "${PREFIX}.owner")}},"generation":{{json (index .Config.Labels "${PREFIX}.generation")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"oneoff":{{json (index .Config.Labels "com.docker.compose.oneoff")}},"state":{{json .State.Status}},"exitCode":{{json .State.ExitCode}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}`,
  },
  volume: {
    // Docker volumes have a name, rather than an immutable engine object ID.
    list: `{"id":{{json .Name}},"name":{{json .Name}},"project":{{json (.Label "${PROJECT_LABEL}")}}}`,
    inspect: `{"id":{{json .Name}},"name":{{json .Name}},"project":{{json (index .Labels "${PROJECT_LABEL}")}},"version":{{json (index .Labels "${PREFIX}.version")}},"instance":{{json (index .Labels "${PREFIX}.instance")}},"owner":{{json (index .Labels "${PREFIX}.owner")}},"storage":{{json (index .Labels "${PREFIX}.storage")}}}`,
  },
  network: {
    list: `{"id":{{json .ID}},"name":{{json .Name}},"project":{{json (.Label "${PROJECT_LABEL}")}}}`,
    inspect: `{"id":{{json .Id}},"name":{{json .Name}},"project":{{json (index .Labels "${PROJECT_LABEL}")}},"version":{{json (index .Labels "${PREFIX}.version")}},"instance":{{json (index .Labels "${PREFIX}.instance")}},"owner":{{json (index .Labels "${PREFIX}.owner")}}}`,
  },
} as const;

export type NativeComposeContainerObservation = {
  readonly id: string;
  readonly service: string;
  readonly state:
    | "created"
    | "restarting"
    | "running"
    | "removing"
    | "paused"
    | "exited"
    | "dead";
  readonly exitCode: number;
  readonly health: "starting" | "healthy" | "unhealthy" | null;
  readonly oneoff: boolean;
};
export type NativeComposeOwnershipObservation = {
  readonly containers: readonly NativeComposeContainerObservation[];
  readonly volumes: readonly {
    readonly name: string;
    readonly storage: string;
  }[];
  readonly networks: readonly { readonly id: string; readonly name: string }[];
};
export type NativeComposeOwnershipOptions = {
  readonly composeProject: string;
  readonly runtimeIdentity: string;
  /** Stable random owner from the verified instance receipt, never authored input. */
  readonly ownerToken: string;
  /** Owner-generated IDs selected from the verified current and pending receipts. */
  readonly generationIds: readonly string[];
  /** Current/pending workload union, including jobs and declared dependencies. */
  readonly expectedServices: readonly string[];
  /** Exact names and logical storage keys from the immutable generated document. */
  readonly expectedVolumes?: readonly {
    readonly name: string;
    readonly storage: string;
  }[];
  readonly expectedNetwork?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
};

type FailureCode =
  | "E_NATIVE_COMPOSE_OWNERSHIP"
  | "E_NATIVE_COMPOSE_PROBE"
  | "E_NATIVE_COMPOSE_PROBE_TIMEOUT"
  | "E_NATIVE_COMPOSE_PROBE_CANCELLED"
  | "E_NATIVE_COMPOSE_PROBE_BUDGET";
/** Never retain command arguments, raw inspect output, labels, or daemon diagnostics. */
export class NativeComposeOwnershipError extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) {
    super(
      {
        E_NATIVE_COMPOSE_OWNERSHIP:
          "Native Compose resource ownership is missing, conflicting or changed; values omitted.",
        E_NATIVE_COMPOSE_PROBE:
          "Native Compose ownership could not be inspected; values omitted.",
        E_NATIVE_COMPOSE_PROBE_TIMEOUT:
          "Native Compose ownership inspection timed out; values omitted.",
        E_NATIVE_COMPOSE_PROBE_CANCELLED:
          "Native Compose ownership inspection was cancelled; values omitted.",
        E_NATIVE_COMPOSE_PROBE_BUDGET:
          "Native Compose ownership inspection exceeded its I/O budget; values omitted.",
      }[code]
    );
    this.name = "NativeComposeOwnershipError";
    this.code = code;
  }
}
function refuse(code: FailureCode = "E_NATIVE_COMPOSE_OWNERSHIP"): never {
  throw new NativeComposeOwnershipError(code);
}
function requireValue(value: unknown): asserts value {
  if (!value) {
    refuse();
  }
}
function hasKeys(
  value: Record<string, unknown>,
  keys: readonly string[]
): boolean {
  return Object.keys(value).sort().join() === [...keys].sort().join();
}
function lines(text: string): Record<string, unknown>[] {
  if (!text.trim()) {
    return [];
  }
  return text
    .trim()
    .split("\n")
    .map((line) => {
      const value: unknown = JSON.parse(line);
      requireValue(isRecord(value));
      return value;
    });
}
function validateOptions(opts: NativeComposeOwnershipOptions): void {
  requireValue(PROJECT.test(opts.composeProject));
  requireValue(PROJECT.test(opts.runtimeIdentity));
  requireValue(GENERATION.test(opts.ownerToken));
  requireValue(opts.generationIds.every((value) => GENERATION.test(value)));
  requireValue(opts.expectedServices.every((value) => SERVICE.test(value)));
  requireValue(
    new Set(opts.expectedServices).size === opts.expectedServices.length
  );
  const names = new Set<string>();
  for (const volume of opts.expectedVolumes ?? []) {
    requireValue(NAME.test(volume.name) && SERVICE.test(volume.storage));
    requireValue(!names.has(volume.name));
    names.add(volume.name);
  }
  requireValue(
    opts.expectedNetwork === undefined || NAME.test(opts.expectedNetwork)
  );
}

/**
 * Read-only preflight under the caller's verified instance lease. Select every
 * project-labelled resource and every expected persistent/replica-one name,
 * inspect immutable container/network IDs, and recheck that selected inventory.
 * Missing resources are allowed for fresh startup. This does not atomically lock
 * Docker: the effect owner must use the same engine/context and recheck at its
 * effect boundary. No engine mutation, repair, admission or lifecycle is performed.
 */
export async function assertNativeComposeOwned(
  opts: NativeComposeOwnershipOptions
): Promise<NativeComposeOwnershipObservation> {
  try {
    validateOptions(opts);
    const probe = createProbe(opts);
    const expected = {
      container: new Set(
        opts.expectedServices.map(
          (service) => `${opts.composeProject}-${service}-1`
        )
      ),
      volume: new Set(
        (opts.expectedVolumes ?? []).map((volume) => volume.name)
      ),
      network: new Set(
        opts.expectedNetwork === undefined ? [] : [opts.expectedNetwork]
      ),
    };
    const inventory = async (kind: Kind): Promise<Inventory[]> => {
      const output = await probe([
        kind,
        "ls",
        ...(kind === "container" ? ["--all"] : []),
        ...(kind === "volume" ? [] : ["--no-trunc"]),
        "--format",
        FORMATS[kind].list,
      ]);
      const selected: Inventory[] = [];
      const ids = new Set<string>();
      for (const row of lines(output)) {
        requireValue(hasKeys(row, ["id", "name", "project"]));
        requireValue(
          typeof row.id === "string" && typeof row.name === "string"
        );
        requireValue(typeof row.project === "string");
        requireValue(kind === "volume" ? row.id === row.name : ID.test(row.id));
        requireValue(!ids.has(row.id));
        ids.add(row.id);
        if (
          row.project === opts.composeProject ||
          expected[kind].has(row.name)
        ) {
          requireValue(NAME.test(row.name));
          selected.push({ id: row.id, name: row.name, project: row.project });
        }
      }
      return selected.sort((left, right) => left.id.localeCompare(right.id));
    };
    const observations: MutableObservation = {
      containers: [],
      volumes: [],
      networks: [],
    };
    const selected = new Map<Kind, Inventory[]>();
    for (const kind of ["container", "volume", "network"] as const) {
      const resources = await inventory(kind);
      selected.set(kind, resources);
      await collectInspections({
        kind,
        resources,
        selection: opts,
        probe,
        observations,
      });
    }
    for (const kind of ["container", "volume", "network"] as const) {
      requireValue(
        JSON.stringify(await inventory(kind)) ===
          JSON.stringify(selected.get(kind))
      );
    }
    return observations;
  } catch (error: unknown) {
    if (error instanceof NativeComposeOwnershipError) {
      throw error;
    }
    refuse("E_NATIVE_COMPOSE_PROBE");
  }
}

type MutableObservation = {
  containers: NativeComposeContainerObservation[];
  volumes: { name: string; storage: string }[];
  networks: { id: string; name: string }[];
};
async function collectInspections(input: {
  readonly kind: Kind;
  readonly resources: readonly Inventory[];
  readonly selection: NativeComposeOwnershipOptions;
  readonly probe: (args: readonly string[]) => Promise<string>;
  readonly observations: MutableObservation;
}): Promise<void> {
  const { kind, resources, selection: opts, probe, observations } = input;
  const { containers, volumes, networks } = observations;
  for (const batch of batches(resources)) {
    const output = await probe([
      kind,
      "inspect",
      "--format",
      FORMATS[kind].inspect,
      ...batch.map((resource) => resource.id),
    ]);
    const rows = lines(output);
    requireValue(rows.length === batch.length);
    const remaining = new Map(batch.map((resource) => [resource.id, resource]));
    for (const row of rows) {
      requireValue(typeof row.id === "string");
      const resource = remaining.get(row.id);
      requireValue(resource !== undefined);
      remaining.delete(row.id);
      requireValue(
        row.name ===
          (kind === "container" ? `/${resource.name}` : resource.name)
      );
      requireValue(
        row.project === opts.composeProject && row.project === resource.project
      );
      requireValue(
        row.version === "1" &&
          row.instance === opts.runtimeIdentity &&
          row.owner === opts.ownerToken
      );
      if (kind === "container") {
        containers.push(containerObservation(row, opts));
      } else if (kind === "volume") {
        requireValue(
          hasKeys(row, [
            "id",
            "name",
            "project",
            "version",
            "instance",
            "owner",
            "storage",
          ])
        );
        requireValue(
          typeof row.storage === "string" && SERVICE.test(row.storage)
        );
        const expectedVolume = opts.expectedVolumes?.find(
          (volume) => volume.name === resource.name
        );
        requireValue(
          expectedVolume !== undefined && expectedVolume.storage === row.storage
        );
        volumes.push({ name: resource.name, storage: row.storage });
      } else {
        requireValue(
          hasKeys(row, [
            "id",
            "name",
            "project",
            "version",
            "instance",
            "owner",
          ])
        );
        requireValue(resource.name === opts.expectedNetwork);
        networks.push({ id: resource.id, name: resource.name });
      }
    }
  }
}

function containerObservation(
  row: Record<string, unknown>,
  opts: NativeComposeOwnershipOptions
): NativeComposeContainerObservation {
  requireValue(
    hasKeys(row, [
      "id",
      "name",
      "project",
      "version",
      "instance",
      "owner",
      "generation",
      "service",
      "oneoff",
      "state",
      "exitCode",
      "health",
    ])
  );
  requireValue(
    typeof row.generation === "string" &&
      opts.generationIds.includes(row.generation)
  );
  requireValue(
    typeof row.service === "string" &&
      opts.expectedServices.includes(row.service)
  );
  requireValue(
    row.oneoff === "True" ||
      row.oneoff === "False" ||
      row.oneoff === "true" ||
      row.oneoff === "false"
  );
  requireValue(
    row.state === "created" ||
      row.state === "restarting" ||
      row.state === "running" ||
      row.state === "removing" ||
      row.state === "paused" ||
      row.state === "exited" ||
      row.state === "dead"
  );
  requireValue(
    typeof row.exitCode === "number" &&
      Number.isSafeInteger(row.exitCode) &&
      row.exitCode >= 0
  );
  requireValue(
    row.health === null ||
      row.health === "starting" ||
      row.health === "healthy" ||
      row.health === "unhealthy"
  );
  requireValue(typeof row.id === "string" && ID.test(row.id));
  return {
    id: row.id,
    service: row.service,
    state: row.state,
    exitCode: row.exitCode,
    health: row.health,
    oneoff: row.oneoff === "True" || row.oneoff === "true",
  };
}

/** Bound command argv, rather than the number of resources in the project. */
function batches(resources: readonly Inventory[]): Inventory[][] {
  const result: Inventory[][] = [];
  let batch: Inventory[] = [];
  let bytes = 0;
  for (const resource of resources) {
    const length = Buffer.byteLength(resource.id) + 1;
    requireValue(length <= ARGUMENT_LIMIT);
    if (bytes + length > ARGUMENT_LIMIT) {
      result.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(resource);
    bytes += length;
  }
  if (batch.length > 0) {
    result.push(batch);
  }
  return result;
}

function createProbe(
  opts: NativeComposeOwnershipOptions
): (args: readonly string[]) => Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  requireValue(
    Number.isSafeInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60_000
  );
  const deadline = Date.now() + timeoutMs;
  let remainingOutput = OUTPUT_LIMIT;
  checkInterruption(opts.signal, false);
  const binary = findExecutableInPath("docker");
  if (!binary) {
    refuse("E_NATIVE_COMPOSE_PROBE");
  }
  const environment = { ...process.env };
  return async (args) => {
    checkInterruption(opts.signal, false);
    const remainingTime = deadline - Date.now();
    if (remainingTime <= 0) {
      refuse("E_NATIVE_COMPOSE_PROBE_TIMEOUT");
    }
    let child: Bun.Subprocess<"ignore", "pipe", "pipe">;
    const ownsProcessGroup = process.platform !== "win32";
    try {
      child = Bun.spawn([binary, ...args], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: ownsProcessGroup,
        env: environment,
      });
    } catch {
      refuse("E_NATIVE_COMPOSE_PROBE");
    }
    const io = new AbortController();
    let settled = false;
    let stopped = false;
    const stop = () => {
      if (!(settled || stopped)) {
        stopped = true;
        killProbe({ child, ownsProcessGroup });
      }
      io.abort();
    };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, remainingTime);
    opts.signal?.addEventListener("abort", stop, { once: true });
    if (opts.signal?.aborted) {
      stop();
    }
    const output = readBounded(child.stdout, remainingOutput, io.signal);
    const diagnostics = readBounded(child.stderr, STDERR_LIMIT, io.signal);
    try {
      const [bytes, , exitCode] = await Promise.all([
        output,
        diagnostics,
        child.exited,
      ]);
      // Exited child and closed streams release the owned group: do not signal
      // its former ID, which may be recycled by an unrelated process group.
      settled = true;
      checkInterruption(opts.signal, timedOut);
      if (exitCode !== 0) {
        refuse("E_NATIVE_COMPOSE_PROBE");
      }
      remainingOutput -= bytes.byteLength;
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error: unknown) {
      checkInterruption(opts.signal, timedOut);
      throw error;
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", stop);
      stop();
      await Promise.allSettled([output, diagnostics, child.exited]);
    }
  };
}

function checkInterruption(
  signal: AbortSignal | undefined,
  timedOut: boolean
): void {
  if (signal?.aborted) {
    refuse("E_NATIVE_COMPOSE_PROBE_CANCELLED");
  }
  if (timedOut) {
    refuse("E_NATIVE_COMPOSE_PROBE_TIMEOUT");
  }
}

function killProbe(opts: {
  readonly child: Bun.Subprocess<"ignore", "pipe", "pipe">;
  readonly ownsProcessGroup: boolean;
}): void {
  if (opts.ownsProcessGroup) {
    try {
      process.kill(-opts.child.pid, "SIGKILL");
    } catch {
      // The owned group may already have exited.
    }
  }
  if (opts.child.exitCode === null) {
    try {
      opts.child.kill("SIGKILL");
    } catch {
      // Exit may race cancellation.
    }
  }
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  limit: number,
  signal: AbortSignal
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) {
    cancel();
  }
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }
      size += chunk.value.byteLength;
      if (size > limit) {
        refuse("E_NATIVE_COMPOSE_PROBE_BUDGET");
      }
      chunks.push(chunk.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}
