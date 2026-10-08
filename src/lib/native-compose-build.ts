import { isAbsolute, join, normalize, relative } from "node:path";
import { isRecord } from "./guards.ts";
import { createNativeComposeProbe } from "./native-compose-ownership.ts";
import { run } from "./shell.ts";

const NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const TOKEN = /^[a-f0-9]{32}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const ENGINE = /^[A-Za-z0-9:-]{1,128}$/;
const UNSAFE_PATH = /[\0\r\n]/;
const IMAGE_FORMAT =
  '{"id":{{json .Id}},"version":{{json (index .Config.Labels "io.hack.native-config.version")}},"instance":{{json (index .Config.Labels "io.hack.native-config.instance")}},"owner":{{json (index .Config.Labels "io.hack.native-config.owner")}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"kind":{{json (index .Config.Labels "io.hack.native-config.workload")}}}';

export class NativeComposeBuildError extends Error {
  readonly code = "E_NATIVE_COMPOSE_BUILD";
  constructor() {
    super(
      "Native build admission or verification failed; owned state and data are retained. Values omitted."
    );
    this.name = "NativeComposeBuildError";
  }
}
function requireValue(value: unknown): asserts value {
  if (!value) {
    throw new NativeComposeBuildError();
  }
}
function record(value: unknown): Record<string, unknown> {
  requireValue(isRecord(value));
  return value;
}

/** Decode the renderer's single Compose interpolation escape, never evaluate it. */
function literal(value: unknown): string {
  requireValue(typeof value === "string" && !UNSAFE_PATH.test(value));
  let result = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (char === "$") {
      requireValue(value[index + 1] === "$");
      index++;
    }
    result += char;
  }
  return result;
}
function within(root: string, path: string): boolean {
  const selected = relative(root, path);
  return (
    !isAbsolute(selected) && selected !== ".." && !selected.startsWith("../")
  );
}

export type NativeComposeBuildIntent = {
  readonly service: string;
  readonly tag: string;
  readonly rebuild: boolean;
  readonly ownerToken: string;
  readonly composeProject: string;
  readonly kind: "service" | "job";
  readonly args: readonly string[];
};

type BuildPlanOptions = {
  readonly document: unknown;
  readonly projectRoot: string;
  readonly composeProject: string;
  readonly ownerToken: string;
  readonly service?: string;
  /** Only a qualified saved routed run skips dependency startup/builds. */
  readonly includeDependencies?: boolean;
};
const BUILD_SOURCE = "x-hack-native-build";

/** Pure selected basic-build lowering. Unsupported keys have no executable representation. */
export function planNativeComposeBuilds(
  opts: BuildPlanOptions
): readonly NativeComposeBuildIntent[] {
  requireValue(
    isAbsolute(opts.projectRoot) &&
      normalize(opts.projectRoot) === opts.projectRoot &&
      !UNSAFE_PATH.test(opts.projectRoot) &&
      NAME.test(opts.composeProject) &&
      TOKEN.test(opts.ownerToken) &&
      (opts.includeDependencies === undefined ||
        typeof opts.includeDependencies === "boolean")
  );
  const services = record(record(opts.document).services);
  const selected = new Set<string>();
  const visit = (name: string): void => {
    requireValue(NAME.test(name) && Object.hasOwn(services, name));
    if (selected.has(name)) {
      return;
    }
    selected.add(name);
    const workload = record(services[name]);
    if (
      opts.includeDependencies !== false &&
      Object.hasOwn(workload, "depends_on")
    ) {
      for (const dependency of Object.keys(record(workload.depends_on))) {
        visit(dependency);
      }
    }
  };
  if (opts.service !== undefined) {
    visit(opts.service);
  } else {
    for (const name of Object.keys(services)) {
      visit(name);
    }
  }
  const intents: NativeComposeBuildIntent[] = [];
  for (const service of [...selected].sort()) {
    const workload = record(services[service]);
    if (!Object.hasOwn(workload, "build")) {
      continue;
    }
    requireValue(!Object.hasOwn(workload, "image"));
    const build = record(workload.build);
    requireValue(
      Object.keys(build).every((key) =>
        ["context", "dockerfile", "target"].includes(key)
      ) &&
        Object.hasOwn(build, "context") &&
        Object.hasOwn(build, "dockerfile") &&
        (!Object.hasOwn(workload, "pull_policy") ||
          workload.pull_policy === "build")
    );
    const context = literal(build.context);
    const dockerfile = literal(build.dockerfile);
    requireValue(
      isAbsolute(context) &&
        normalize(context) === context &&
        within(opts.projectRoot, context) &&
        dockerfile !== "" &&
        dockerfile !== "." &&
        !isAbsolute(dockerfile) &&
        normalize(dockerfile) === dockerfile &&
        within(context, join(context, dockerfile))
    );
    const labels = record(workload.labels);
    const kind = labels["io.hack.native-config.workload"];
    requireValue(
      labels["io.hack.native-config.version"] === "1" &&
        labels["io.hack.native-config.instance"] === opts.composeProject &&
        labels["io.hack.native-config.owner"] === opts.ownerToken &&
        (kind === "service" || kind === "job")
    );
    const tag = `${opts.composeProject}-${service}:latest`;
    const args = [
      "docker",
      "buildx",
      "build",
      "--load",
      "--tag",
      tag,
      "--file",
      join(context, dockerfile),
    ];
    if (Object.hasOwn(build, "target")) {
      requireValue(typeof build.target === "string" && NAME.test(build.target));
      args.push("--target", build.target);
    }
    for (const [key, value] of Object.entries({
      "io.hack.native-config.version": "1",
      "io.hack.native-config.instance": opts.composeProject,
      "io.hack.native-config.owner": opts.ownerToken,
      "io.hack.native-config.workload": kind,
      "com.docker.compose.project": opts.composeProject,
      "com.docker.compose.service": service,
    })) {
      args.push("--label", `${key}=${value}`);
    }
    args.push(context);
    intents.push(
      Object.freeze({
        service,
        tag,
        rebuild: workload.pull_policy === "build",
        ownerToken: opts.ownerToken,
        composeProject: opts.composeProject,
        kind,
        args: Object.freeze(args),
      })
    );
  }
  return Object.freeze(intents);
}

/**
 * One execution document consumes prebuilt owned images. The private extension
 * retains escaped source declarations in the generation hash; Compose ignores it.
 * All selected build declarations are validated, even when run builds fewer peers.
 */
export function prepareNativeComposeBuildExecution(opts: BuildPlanOptions): {
  readonly document: Readonly<Record<string, unknown>>;
  readonly intents: readonly NativeComposeBuildIntent[];
} {
  const source = record(opts.document);
  requireValue(!Object.hasOwn(source, BUILD_SOURCE));
  const all = planNativeComposeBuilds({
    ...opts,
    service: undefined,
    includeDependencies: true,
  });
  const intents =
    opts.service === undefined ? all : planNativeComposeBuilds(opts);
  if (all.length === 0) {
    return Object.freeze({ document: source, intents });
  }
  const services = { ...record(source.services) };
  const workloads: Record<string, unknown> = {};
  for (const intent of all) {
    const workload = record(services[intent.service]);
    workloads[intent.service] = Object.freeze({
      build: Object.freeze({ ...record(workload.build) }),
      ...(Object.hasOwn(workload, "pull_policy")
        ? { pull_policy: workload.pull_policy }
        : {}),
    });
    const { build: _build, ...selected } = workload;
    selected.image = intent.tag;
    selected.pull_policy = "never";
    services[intent.service] = Object.freeze(selected);
  }
  return Object.freeze({
    document: Object.freeze({
      ...source,
      services: Object.freeze(services),
      [BUILD_SOURCE]: Object.freeze({
        version: 1,
        workloads: Object.freeze(workloads),
      }),
    }),
    intents,
  });
}

/** Recheck projection/intents against the immutable source at each build boundary. */
export function assertNativeComposeBuildExecution(
  opts: BuildPlanOptions & {
    readonly executionDocument: unknown;
    readonly intents: readonly NativeComposeBuildIntent[];
  }
): void {
  const expected = prepareNativeComposeBuildExecution(opts);
  const observed = record(opts.executionDocument);
  requireValue(
    JSON.stringify(expected.intents) === JSON.stringify(opts.intents) &&
      Object.hasOwn(expected.document, BUILD_SOURCE) ===
        Object.hasOwn(observed, BUILD_SOURCE) &&
      JSON.stringify(expected.document[BUILD_SOURCE]) ===
        JSON.stringify(observed[BUILD_SOURCE])
  );
  const services = record(observed.services);
  for (const intent of planNativeComposeBuilds({
    ...opts,
    service: undefined,
    includeDependencies: true,
  })) {
    requireValue(Object.hasOwn(services, intent.service));
    const workload = record(services[intent.service]);
    requireValue(
      !Object.hasOwn(workload, "build") &&
        workload.image === intent.tag &&
        workload.pull_policy === "never"
    );
  }
}

type BuildIo = {
  readonly engine: () => Promise<unknown>;
  readonly probe: (args: readonly string[]) => Promise<string>;
  readonly execute: (
    args: readonly string[],
    timeoutMs: number | undefined
  ) => Promise<number>;
};

async function image(
  intent: NativeComposeBuildIntent,
  probe: BuildIo["probe"]
): Promise<string | null> {
  const rows = (
    await probe([
      "image",
      "ls",
      "--no-trunc",
      "--filter",
      `reference=${intent.tag}`,
      "--format",
      "{{.ID}}",
    ])
  )
    .trim()
    .split("\n")
    .filter(Boolean);
  if (rows.length === 0) {
    return null;
  }
  requireValue(rows.length === 1 && IMAGE.test(rows[0] ?? ""));
  let value: unknown;
  try {
    value = JSON.parse(
      await probe(["image", "inspect", intent.tag, "--format", IMAGE_FORMAT])
    );
  } catch {
    throw new NativeComposeBuildError();
  }
  const observed = record(value);
  requireValue(
    Object.keys(observed).sort().join(",") ===
      "id,instance,kind,owner,service,version" &&
      observed.id === rows[0] &&
      observed.version === "1" &&
      observed.instance === intent.composeProject &&
      observed.owner === intent.ownerToken &&
      observed.service === intent.service &&
      observed.kind === intent.kind
  );
  return rows[0] ?? null;
}

/** Invoke only inside the existing generation's journaled mutation/effect. */
export async function buildNativeComposeImages(opts: {
  readonly intents: readonly NativeComposeBuildIntent[];
  readonly projectRoot: string;
  readonly deadline?: number;
  readonly signal: AbortSignal;
  readonly env: Record<string, string> | undefined;
  readonly json: boolean;
  readonly assertFresh: () => Promise<void>;
  readonly assertOwned: () => Promise<void>;
  readonly io?: BuildIo;
}): Promise<number> {
  const probe = (args: readonly string[]) => {
    const remaining =
      opts.deadline === undefined ? 15_000 : opts.deadline - Date.now();
    requireValue(remaining > 0);
    return createNativeComposeProbe({
      signal: opts.signal,
      timeoutMs: Math.min(15_000, remaining),
    })(args);
  };
  const io = opts.io ?? {
    probe,
    engine: async () => {
      try {
        return JSON.parse(
          await probe(["info", "--format", "{{json .ID}}"])
        ) as unknown;
      } catch {
        throw new NativeComposeBuildError();
      }
    },
    execute: (args, timeoutMs) =>
      run(args, {
        cwd: opts.projectRoot,
        env: opts.env,
        timeoutMs,
        stdin: "ignore",
        stdout: opts.json ? "stderr" : "inherit",
        forwardSignals: true,
      }),
  };
  let engine: string | null = null;
  const fresh = async () => {
    requireValue(
      !opts.signal.aborted &&
        (opts.deadline === undefined || Date.now() < opts.deadline)
    );
    await opts.assertFresh();
    await opts.assertOwned();
    const observed = await io.engine();
    requireValue(
      typeof observed === "string" &&
        ENGINE.test(observed) &&
        (engine === null || engine === observed)
    );
    engine = observed;
    requireValue(
      !opts.signal.aborted &&
        (opts.deadline === undefined || Date.now() < opts.deadline)
    );
  };
  const admitted: { intent: NativeComposeBuildIntent; id: string }[] = [];
  // Admit every selected cached tag before any builder is invoked.
  const cached = new Map<NativeComposeBuildIntent, string | null>();
  for (const intent of opts.intents) {
    await fresh();
    cached.set(intent, await image(intent, io.probe));
  }
  for (const intent of opts.intents) {
    await fresh();
    const prior = await image(intent, io.probe);
    requireValue(prior === cached.get(intent));
    if (intent.rebuild || prior === null) {
      await fresh();
      requireValue((await image(intent, io.probe)) === prior);
      // The final image read can outlive or invalidate prior admission.
      // Recheck after it, then admit spawn synchronously with the remaining budget.
      await fresh();
      const timeoutMs =
        opts.deadline === undefined ? undefined : opts.deadline - Date.now();
      requireValue(
        !opts.signal.aborted && (timeoutMs === undefined || timeoutMs > 0)
      );
      const code = await io.execute(intent.args, timeoutMs);
      if (code !== 0 || opts.signal.aborted) {
        return code || 1;
      }
      await fresh();
    }
    const id = await image(intent, io.probe);
    requireValue(id !== null);
    admitted.push({ intent, id });
  }
  await fresh();
  for (const { intent, id } of admitted) {
    requireValue((await image(intent, io.probe)) === id);
  }
  return 0;
}
