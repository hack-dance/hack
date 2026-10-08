import { chmod, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../../../src/lib/guards.ts";
import { openNativeComposeGenerationStore } from "../../../src/lib/native-compose-generation.ts";
import { assertNativeComposeProxyRoutes } from "../../../src/lib/native-compose-proxy-routes.ts";
import { readNativeComposeRouteMetadata } from "../../../src/lib/native-compose-route-owner.ts";
import { type CliResult, expect, expectExit } from "../harness.ts";

const OWNER = "io.hack.native-config.owner";
const GENERATION = "io.hack.native-config.generation";
const PROJECT = "com.docker.compose.project";
const ID = /^[a-f0-9]{64}$/;
export const ROUTED_RUN_LITERAL = "$literal-${NOT_INTERPOLATED}-$$";
const MARKER = "/state/routed-run-marker";
type Checkout = { readonly root: string; readonly marker: string };
type Docker = (args: readonly string[]) => Promise<string>;
type Raw = (
  root: string,
  args: readonly string[],
  extra?: Readonly<Record<string, string>>
) => Promise<CliResult>;
type Acceptance = {
  readonly root: string;
  readonly siblings: readonly Checkout[];
  readonly tempRoot: string;
  readonly claims: () => Promise<string>;
  readonly check: (checkout: Checkout) => Promise<unknown>;
  readonly primary: Checkout;
  readonly docker: Docker;
  readonly raw: Raw;
};

function object(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error("Expected a complete owned fixture object; values omitted");
  }
  return parsed;
}
function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function saved(root: string) {
  const store = await openNativeComposeGenerationStore({
    projectRoot: root,
    instance: null,
    mode: "saved",
  });
  try {
    const state = await store.loadCurrent();
    if (!state.generation) {
      throw new Error("Warm routed run requires a saved fixture generation");
    }
    const generation = state.generation;
    const document = await store.withLease({
      generation,
      run: async () => await store.readGenerationDocument(generation),
    });
    return {
      owner: store.identity,
      generationId: generation.generationId,
      document,
      pending: state.pending,
      stopped: state.stopped,
    };
  } finally {
    await store.close();
  }
}

async function containers(
  docker: Docker,
  source: Awaited<ReturnType<typeof saved>>
) {
  const ids = (
    await docker([
      "ps",
      "--no-trunc",
      "-aq",
      "--filter",
      `label=${PROJECT}=${source.owner.composeProject}`,
    ])
  )
    .split(/\s+/)
    .filter(Boolean)
    .sort();
  const values = await Promise.all(
    ids.map(async (id) => {
      expect({
        that: ID.test(id),
        message: "Fixture containers must have complete immutable IDs",
      });
      const value = object(
        await docker([
          "container",
          "inspect",
          "--format",
          '{"id":{{json .Id}},"labels":{{json .Config.Labels}},"state":{{json .State.Status}},"health":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}}}',
          id,
        ])
      );
      expect({
        that:
          value.id === id &&
          isRecord(value.labels) &&
          value.labels[PROJECT] === source.owner.composeProject &&
          value.labels[OWNER] === source.owner.ownerToken &&
          value.labels[GENERATION] === source.generationId,
        message:
          "Routed run observation requires exact fixture generation ownership",
      });
      return value;
    })
  );
  return values;
}

function oneOff(value: Record<string, unknown>): boolean {
  return (
    isRecord(value.labels) &&
    value.labels["com.docker.compose.oneoff"] === "True"
  );
}

async function assertRoutes(
  opts: Acceptance,
  source: Awaited<ReturnType<typeof saved>>
) {
  const metadata = readNativeComposeRouteMetadata({
    generationId: source.generationId,
    document: source.document,
  });
  if (!metadata) {
    throw new Error("Warm routed fixture must retain its saved proof targets");
  }
  await assertNativeComposeProxyRoutes({
    binding: metadata.binding,
    composeProject: source.owner.composeProject,
    ownerToken: source.owner.ownerToken,
    generationId: source.generationId,
    routes: metadata.routes,
    deadline: Date.now() + 30_000,
  });
  await opts.check(opts.primary);
  for (const sibling of opts.siblings) {
    await opts.check(sibling);
  }
}

/** Record/block only the exact owned removal chosen by the CLI; forward all other operations. */
async function removalShim(
  opts: Acceptance,
  source: Awaited<ReturnType<typeof saved>>,
  block: boolean
) {
  const engine = Bun.which("docker");
  if (!engine?.startsWith("/")) {
    throw new Error("Absolute fixture Docker forwarding target is unavailable");
  }
  const root = join(
    opts.tempRoot,
    block ? "warm-run-failed-removal" : "warm-run-removal"
  );
  await mkdir(root, { mode: 0o700 });
  const receipt = join(root, "owned-id");
  const script = [
    "#!/bin/sh",
    'if [ "$1" = container ] && [ "$2" = rm ] && [ "$#" = 3 ]; then',
    `  owner=$(${quote(engine)} container inspect --format '{{index .Config.Labels "${OWNER}"}}' "$3") || exit 98`,
    `  project=$(${quote(engine)} container inspect --format '{{index .Config.Labels "${PROJECT}"}}' "$3") || exit 98`,
    `  [ "$owner" = ${quote(source.owner.ownerToken)} ] && [ "$project" = ${quote(source.owner.composeProject)} ] || exit 98`,
    `  printf '%s\\n' "$3" > ${quote(receipt)}`,
    ...(block ? ["  exit 71"] : []),
    "fi",
    `exec ${quote(engine)} "$@"`,
    "",
  ].join("\n");
  await Bun.write(join(root, "docker"), script);
  await chmod(join(root, "docker"), 0o700);
  return {
    receipt,
    env: { PATH: `${root}:${process.env.PATH ?? "/usr/bin:/bin"}` },
  };
}

async function checkMarker(
  docker: Docker,
  source: Awaited<ReturnType<typeof saved>>,
  marker: string
) {
  const current = (await containers(docker, source)).filter(
    (value) => !oneOff(value)
  );
  const id = current[0]?.id;
  expect({
    that: current.length === 1 && typeof id === "string" && ID.test(id),
    message: "Marker read requires the one retained owned web container",
  });
  if (typeof id !== "string") {
    throw new Error("Missing exact marker reader");
  }
  await docker([
    "exec",
    id,
    "bun",
    "-e",
    `if(await Bun.file(${JSON.stringify(MARKER)}).text()!==${JSON.stringify(marker)}) process.exit(23)`,
  ]);
}

function snapshot(values: readonly Record<string, unknown>[]): string {
  const retained = values.filter((value) => !oneOff(value));
  expect({
    that:
      retained.length === 1 &&
      retained.every(
        (value) => value.state === "running" && value.health === "healthy"
      ),
    message:
      "Retained routed workload must remain healthy with its exact container",
  });
  return JSON.stringify(retained);
}

async function heldRun(
  opts: Acceptance,
  source: Awaited<ReturnType<typeof saved>>
) {
  const shim = await removalShim(opts, source, false);
  const before = snapshot(await containers(opts.docker, source));
  const claims = await opts.claims();
  const marker = `warm-${source.generationId}`;
  const release = `/state/release-${source.generationId}`;
  const script = [
    `if(process.env.RUN_LITERAL!==${JSON.stringify(ROUTED_RUN_LITERAL)} || JSON.stringify(process.argv.slice(-2))!==JSON.stringify(["space arg", "$HOME"])) process.exit(23);`,
    `await Bun.write(${JSON.stringify(MARKER)},${JSON.stringify(marker)});`,
    `const deadline=Date.now()+90000;while(!(await Bun.file(${JSON.stringify(release)}).exists())) { if(Date.now()>deadline) process.exit(24); await Bun.sleep(100); }`,
    'console.log("routed one-off verified");process.exit(17);',
  ].join("\n");
  const running = opts.raw(
    opts.root,
    ["run", "web", "--", "bun", "-e", script, "--", "space arg", "$HOME"],
    shim.env
  );
  let observed: Record<string, unknown> | null = null;
  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const active = await containers(opts.docker, source);
      expect({
        that: snapshot(active) === before,
        message:
          "Warm run may not replace or stop the retained routed container",
      });
      const ones = active.filter(oneOff);
      if (ones.length === 1 && ones[0]?.state === "running") {
        observed = ones[0];
        break;
      }
      await Bun.sleep(100);
    }
    if (!(observed && isRecord(observed.labels))) {
      throw new Error("Running owned one-off was not observed");
    }
    expect({
      that: !Object.keys(observed.labels).some((key) =>
        /^(?:caddy(?:\.|$)|caddy_)/.test(key)
      ),
      message: "Actual running one-off must expose no Caddy routing label keys",
    });
    await checkMarker(opts.docker, source, marker);
    // Two proxy polling cycles must not turn this additional container into an upstream.
    await Bun.sleep(2200);
    await assertRoutes(opts, source);
    expect({
      that: (await opts.claims()) === claims,
      message: "Running one-off must leave completed hostname claims unchanged",
    });
  } finally {
    const current = (await containers(opts.docker, source)).filter(
      (value) => !oneOff(value)
    );
    const id = current[0]?.id;
    if (typeof id === "string") {
      await opts.docker([
        "exec",
        id,
        "bun",
        "-e",
        `await Bun.write(${JSON.stringify(release)},"complete")`,
      ]);
    }
    // Always reap the launched CLI before scenario ownership cleanup.
    const result = await running;
    expectExit({
      result,
      codes: [17],
      message:
        "Verified literal argv/environment run must preserve its exact exit17",
    });
  }
  expect({
    that:
      (await Bun.file(shim.receipt).text()).trim() === observed?.id &&
      snapshot(await containers(opts.docker, source)) === before,
    message:
      "CLI must remove only the observed stopped one-off and leave the ready graph intact",
  });
  const after = await saved(opts.root);
  expect({
    that:
      after.pending === null &&
      !after.stopped &&
      after.generationId === source.generationId &&
      JSON.stringify(after.document) === JSON.stringify(source.document) &&
      (await opts.claims()) === claims,
    message:
      "Successful routed run must preserve exact current generation, inputs and completed claims",
  });
  await assertRoutes(opts, after);
}

async function failedRemoval(
  opts: Acceptance,
  source: Awaited<ReturnType<typeof saved>>
) {
  const shim = await removalShim(opts, source, true);
  const marker = `warm-${source.generationId}`;
  const before = snapshot(await containers(opts.docker, source));
  const claims = await opts.claims();
  const result = await opts.raw(
    opts.root,
    ["run", "web", "--", "bun", "-e", "process.exit(0)"],
    shim.env
  );
  expectExit({
    result,
    codes: [1],
    message: "Failed owned one-off removal must report incomplete execution",
  });
  const observed = await containers(opts.docker, source);
  const ones = observed.filter(oneOff);
  expect({
    that:
      ones.length === 1 &&
      ones[0]?.state === "exited" &&
      snapshot(observed) === before &&
      (await Bun.file(shim.receipt).text()).trim() === ones[0]?.id &&
      (await saved(opts.root)).pending?.operation === "run" &&
      (await opts.claims()) === claims,
    message:
      "Failed removal must retain the exact stopped one-off and recoverable run intent without changing claims or ready graph",
  });
  await assertRoutes(opts, source);
  expectExit({
    result: await opts.raw(opts.root, ["up", "--detach", "--json"]),
    codes: [1],
    message: "Pending warm-run cleanup must block automatic startup replay",
  });
  expectExit({
    result: await opts.raw(opts.root, ["down", "--recover", "--json"]),
    codes: [0],
    message:
      "Explicit original-generation stop must recover one-off uncertainty",
  });
  for (const sibling of opts.siblings) {
    await opts.check(sibling);
  }
  expectExit({
    result: await opts.raw(opts.root, ["up", "--detach", "--json"]),
    codes: [0],
    message: "Recovered routed graph must restart against retained data",
  });
  const restored = await saved(opts.root);
  expect({
    that: restored.pending === null && !restored.stopped,
    message: "Owned routed run recovery must clear pending engine intent",
  });
  await checkMarker(opts.docker, restored, marker);
  await assertRoutes(opts, restored);
}

/** Real compiled CLI/engine acceptance. Caller owns isolated ingress and final retained-data cleanup. */
export async function qualifyNativeComposeRoutedRun(
  opts: Acceptance
): Promise<void> {
  const source = await saved(opts.root);
  expect({
    that: source.pending === null && !source.stopped,
    message: "Warm run starts only from a complete saved routed generation",
  });
  await heldRun(opts, source);
  await failedRemoval(opts, source);
}
