import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beginNativeProjectFinalization } from "../src/backends/native-project-finalization.ts";
import {
  type NativeProjectRun,
  saveNativeProjectRun,
} from "../src/backends/native-project-run.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * Known native refusals reachable from image-project `up`, `restart` and `ps`
 * print one closed line through the real CLI: no `Error:` prefix and no stack.
 *
 * The stub runtime answers `<word> <word>` requests (for example
 * `project plan`) from `<root>/stub/<word>-<word>.out` and otherwise reports a
 * stopped runtime, so each case scripts exactly the replies that reach the
 * refusal it names. Nothing here starts a real runtime, Docker or a VM.
 */

const roots: string[] = [];
const entrypoint = resolve("index.ts");
/** A JavaScript stack frame as Bun prints it. */
const STACK_FRAME = /^\s+at /m;
/** A source CLI spawn can take several seconds on a loaded runner. */
const SPAWN_TIMEOUT_MS = 60_000;
const COMPOSE = JSON.stringify({
  services: { web: { image: `sha256:${"e".repeat(64)}` } },
});
const run: NativeProjectRun = {
  run: "a".repeat(32),
  owner: "b".repeat(32),
  namespace: "c".repeat(64),
  planId: "d".repeat(64),
  profiles: [],
  effectiveEnvName: null,
  aws: null,
};

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(compose = COMPOSE) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-refusal-cli-"))
  );
  roots.push(root);
  const project = join(root, "project");
  const projectDir = join(project, ".hack");
  const nativeHome = join(root, "native-home");
  const runtimeDir = join(root, "runtime");
  const stub = join(root, "stub");
  await mkdir(projectDir, { recursive: true });
  await mkdir(nativeHome, { mode: 0o700 });
  await mkdir(runtimeDir);
  await mkdir(stub);
  await writeFile(join(projectDir, "docker-compose.yml"), compose);
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({
      name: "refusal-fixture",
      dev_host: "refusal-fixture.hack.local",
    })
  );
  // `up` requires the bundled relay artifact next to the runtime binary.
  await writeFile(join(runtimeDir, "hack-relay-guest"), "synthetic relay");
  const binary = join(runtimeDir, "native-runtime");
  await writeFile(
    binary,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${stub}/calls'
if [ -f '${stub}/'"$3-$4"'.out' ]; then cat '${stub}/'"$3-$4"'.out'; exit 0; fi
if [ -f '${stub}/'"$3-$4"'.err' ]; then cat '${stub}/'"$3-$4"'.err' >&2; exit 1; fi
printf '%s' '{"code":"runtime_not_running"}' >&2
exit 1
`,
    { mode: 0o700 }
  );
  const scope = { projectRoot: project, projectDir, nativeHome, branch: null };
  const reply = async (request: string, value: unknown) =>
    await writeFile(
      join(stub, `${request.replace(" ", "-")}.out`),
      typeof value === "string" ? value : JSON.stringify(value)
    );
  /** Make `request` fail with this closed native failure on stderr. */
  const fail = async (request: string, failure: Record<string, unknown>) =>
    await writeFile(
      join(stub, `${request.replace(" ", "-")}.err`),
      JSON.stringify(failure)
    );
  const calls = async () =>
    (await readFile(join(stub, "calls"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ").slice(2, 4).join(" "));
  const env = (extra: Record<string, string> = {}) =>
    privateCliEnv({
      root,
      env: {
        HACK_RUNTIME_BACKEND: "native",
        HACK_NATIVE_BINARY: binary,
        HACK_NATIVE_HOME: nativeHome,
        HACK_NO_INTERACTIVE: "1",
        HACK_LOGGER: "console",
        ...extra,
      },
    });
  return { root, project, projectDir, scope, compose, reply, fail, calls, env };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function cli(opts: {
  readonly fixture: Fixture;
  readonly args: readonly string[];
  readonly env?: Record<string, string>;
}) {
  const child = Bun.spawn(
    [
      process.execPath,
      entrypoint,
      "--path",
      opts.fixture.project,
      ...opts.args,
    ],
    {
      cwd: opts.fixture.root,
      env: opts.fixture.env(opts.env),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: SPAWN_TIMEOUT_MS - 5000,
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code, output: stdout + stderr };
}

/** The refusal is the whole report: one `ERROR:` line, no stack, no help. */
function expectOneClosedLine(
  result: Awaited<ReturnType<typeof cli>>,
  line: string
): void {
  expect(result.code).toBe(1);
  const errors = result.output
    .split("\n")
    .filter((text) => text.startsWith("ERROR:"));
  expect(errors).toEqual([`ERROR: ${line}`]);
  expect(result.output).not.toMatch(STACK_FRAME);
  expect(result.output).not.toContain("Error: ");
  expect(result.output).not.toContain("hack <command> [options]");
}

/** Replies that carry an image-project `up` through review. */
async function scriptUpThroughReview(
  f: Fixture,
  plan: Record<string, unknown> = {}
) {
  const sha = createHash("sha256").update(f.compose).digest("hex");
  await f.reply("runtime check-project-share", {
    source_admitted: true,
    pool_initialized: true,
  });
  await f.reply("runtime up", {});
  await f.reply("project plan", {
    plan_id: "f".repeat(64),
    plan: {
      namespace: run.namespace,
      compose_sha256: sha,
      enrollment_compatible: true,
      services: { web: { active: true } },
      ...plan,
    },
  });
}

const SHARED = { HACK_NATIVE_SHARED_SOURCE: "1" };

/** A mapping saved by a prior start, as `ps`, `up` and `restart` find it. */
async function savedRun(f: Fixture) {
  await saveNativeProjectRun({ ...f.scope, run });
}

/** The stopped retained graph the runtime reports for {@link run}. */
const stoppedGraph = {
  journal_incomplete: false,
  receipt: {
    run: run.run,
    owner: run.owner,
    namespace: run.namespace,
    plan_id: run.planId,
    phase: "stopped-data-retained",
    resources: {
      "container:web": {
        kind: "container",
        key: "web",
        id: "f".repeat(64),
        phase: "started",
      },
    },
  },
  observations: { "container:web": { state: "absent" } },
};

test(
  "native-project-run: an unbounded profile is one coded line before any request",
  async () => {
    const f = await fixture();
    const result = await cli({
      fixture: f,
      args: ["up", "--profile", "p".repeat(300)],
      env: SHARED,
    });
    expectOneClosedLine(
      result,
      "E_CONFIG_INVALID: Native profiles require at most 64 bounded nonempty names."
    );
    expect(await f.calls()).toEqual([]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native-project-run: an unsafe saved mapping is one closed line",
  async () => {
    const f = await fixture();
    await savedRun(f);
    const dir = join(f.projectDir, ".internal", "native-runs");
    const name = (await readdir(dir)).find((entry) => entry.endsWith(".json"));
    await writeFile(join(dir, name ?? "absent.json"), "{}");
    const result = await cli({ fixture: f, args: ["ps"] });
    expectOneClosedLine(
      result,
      "Native project run mapping is unsafe, changed, or owned by another run; inspect native state before recovery."
    );
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native-runtime-client: an unparseable runtime reply is one closed line",
  async () => {
    const f = await fixture();
    await savedRun(f);
    await f.reply("graph inspect", "not-json");
    const result = await cli({ fixture: f, args: ["ps"] });
    expectOneClosedLine(
      result,
      "Native runtime returned an invalid control response."
    );
    expect(await f.calls()).toEqual(["graph inspect"]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native-project-dependencies: an invalid listener selection is one coded line",
  async () => {
    const f = await fixture();
    await scriptUpThroughReview(f);
    const selection = join(f.root, "dependencies.json");
    await writeFile(selection, "{}", { mode: 0o600 });
    const result = await cli({
      fixture: f,
      args: ["up"],
      env: { ...SHARED, HACK_NATIVE_DEPENDENCIES: selection },
    });
    expectOneClosedLine(
      result,
      "E_CONFIG_INVALID: Native host dependencies require a bounded explicit listener selection; values omitted."
    );
    expect(await f.calls()).toEqual(["runtime check-project-share"]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native-project-review: changed project input is one closed line",
  async () => {
    const f = await fixture();
    await scriptUpThroughReview(f);
    await f.reply("project plan", {});
    const result = await cli({ fixture: f, args: ["up"], env: SHARED });
    expectOneClosedLine(
      result,
      "Native project input changed before review; prepare it again."
    );
    expect(await f.calls()).toEqual([
      "runtime check-project-share",
      "runtime up",
      "project plan",
    ]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native-project-cache: an unverified source publication is one closed line",
  async () => {
    const f = await fixture();
    await scriptUpThroughReview(f, {
      services: { web: { active: true, dependency_cache: {} } },
    });
    await f.reply("project publish-source", {});
    const result = await cli({ fixture: f, args: ["up"], env: SHARED });
    expectOneClosedLine(
      result,
      "Native cache source publication did not return a verified revision."
    );
    expect((await f.calls()).at(-1)).toBe("project publish-source");
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native-project-start: an unconfirmed dependency plan is one closed integrity line",
  async () => {
    const f = await fixture();
    await scriptUpThroughReview(f);
    await f.reply("graph dependency-plan", { dependency_plan_id: "x" });
    const result = await cli({ fixture: f, args: ["up"], env: SHARED });
    expectOneClosedLine(
      result,
      "Native foreground up could not confirm the host dependency plan; inspect owned state before retrying."
    );
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native-project-retained-startup: changed retained eligibility is one closed line",
  async () => {
    const f = await fixture();
    await savedRun(f);
    await f.reply("graph retained-preflight", {});
    const result = await cli({ fixture: f, args: ["up"], env: SHARED });
    expectOneClosedLine(
      result,
      "Native retained startup eligibility changed; no hooks or runtime start were requested."
    );
    expect(await f.calls()).toEqual(["graph retained-preflight"]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native-project-restore: a changed restore selection is one closed line",
  async () => {
    const f = await fixture();
    await savedRun(f);
    // The retained frontend finished; restore may proceed to review.
    await (
      await beginNativeProjectFinalization({ scope: f.scope, run })
    ).complete();
    await scriptUpThroughReview(f);
    await f.reply("graph retained-preflight", {
      version: 1,
      run: run.run,
      owner: run.owner,
      namespace: run.namespace,
      plan: run.planId,
      live_resources_verified: false,
      runtime_phase: "stopped",
      selection: "7".repeat(64),
    });
    await f.reply("graph inspect", stoppedGraph);
    await f.reply("graph restore-selection", {});
    const result = await cli({ fixture: f, args: ["up"], env: SHARED });
    expectOneClosedLine(
      result,
      "Native restore selection changed; retained data was not adopted."
    );
    expect((await f.calls()).at(-1)).toBe("graph restore-selection");
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native-project-retained-images: a changed active image selection is one closed restart line",
  async () => {
    const f = await fixture();
    await savedRun(f);
    await f.reply("runtime check-project-share", {
      source_admitted: true,
      pool_initialized: true,
    });
    await f.reply("runtime status", { network: "internet" });
    await f.reply("runtime probe", { admitted: true });
    await f.reply("graph inspect", {});
    const result = await cli({ fixture: f, args: ["restart"], env: SHARED });
    expectOneClosedLine(
      result,
      "Native active image selection changed; the current graph was not stopped."
    );
    expect(await f.calls()).toEqual([
      "runtime check-project-share",
      "runtime status",
      "runtime probe",
      "graph inspect",
    ]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native-project-network: an invalid allowed-host selection is one coded line before any request",
  async () => {
    const f = await fixture();
    const result = await cli({
      fixture: f,
      args: ["up"],
      env: { ...SHARED, HACK_NATIVE_ALLOW_HOSTS: "localhost" },
    });
    expectOneClosedLine(
      result,
      "E_CONFIG_INVALID: HACK_NATIVE_ALLOW_HOSTS requires at most 32 unique canonical public DNS names; wildcards, IP addresses, local names and empty entries are refused. Values omitted."
    );
    expect(await f.calls()).toEqual([]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native-project-process: a failed serve with unconfirmed cleanup is one closed line",
  async () => {
    const f = await fixture();
    await scriptUpThroughReview(f);
    await f.reply("graph dependency-plan", {
      dependency_plan_id: "1".repeat(64),
    });
    const result = await cli({ fixture: f, args: ["up"], env: SHARED });
    expectOneClosedLine(
      result,
      "Native foreground exit cleanup is unconfirmed; runtime and bridge state may be retained. Any published run mapping is retained; inspect owned state before retrying. Startup diagnostic: Native graph startup was interrupted or failed (runtime_not_running). Native exit diagnostic: runtime_not_running."
    );
    expect((await f.calls()).slice(-2)).toEqual([
      "graph serve",
      "graph inspect",
    ]);
  },
  SPAWN_TIMEOUT_MS
);

/** A project whose only service names a registry image the candidate refuses. */
const REGISTRY_COMPOSE = JSON.stringify({
  services: { web: { image: "ghcr.io/example/app:1" } },
});
const IMAGE_REFUSAL =
  "Native project image reference refused before runtime startup: use a public Docker Hub reference (shorthand such as alpine:3.21 is accepted) or a sha256 image ID; no VM, provider or image acquisition was started.";

test(
  "native-project-image-admission: a refused image reference is one coded line",
  async () => {
    const f = await fixture(REGISTRY_COMPOSE);
    await scriptUpThroughReview(f);
    await f.fail("runtime admit-image", { code: "registry_image" });
    const result = await cli({ fixture: f, args: ["up"], env: SHARED });
    expectOneClosedLine(
      result,
      `E_NATIVE_PROJECT_UNSUPPORTED: ${IMAGE_REFUSAL}`
    );
    expect(result.output).not.toContain("ghcr.io");
    expect((await f.calls()).at(-1)).toBe("runtime admit-image");
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native-project-image-admission: a malformed admission reply is one closed integrity line",
  async () => {
    const f = await fixture(REGISTRY_COMPOSE);
    await scriptUpThroughReview(f);
    await f.reply("runtime admit-image", {});
    const result = await cli({ fixture: f, args: ["up"], env: SHARED });
    expectOneClosedLine(
      result,
      "Native runtime returned an invalid image admission response; no VM, provider or image acquisition was started."
    );
    expect(result.output).not.toContain("ghcr.io");
    expect((await f.calls()).at(-1)).toBe("runtime admit-image");
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native-prepared-base: an invalid prepared-base mode is one coded line before any request",
  async () => {
    const f = await fixture();
    const result = await cli({
      fixture: f,
      args: ["up"],
      env: { ...SHARED, HACK_NATIVE_PREPARED_BASE: "bogus" },
    });
    expectOneClosedLine(
      result,
      "E_CONFIG_INVALID: HACK_NATIVE_PREPARED_BASE must be prefer, require or off."
    );
    expect(await f.calls()).toEqual([]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native-workspace-cache: an invalid cache layout is one coded line",
  async () => {
    const f = await fixture();
    await scriptUpThroughReview(f);
    const adaptation = join(f.root, "adaptation.json");
    await writeFile(
      adaptation,
      JSON.stringify({ version: 1, workspaceCache: { bogus: 1 } }),
      { mode: 0o600 }
    );
    const result = await cli({
      fixture: f,
      args: ["up"],
      env: { ...SHARED, HACK_NATIVE_ADAPTATION: adaptation },
    });
    expectOneClosedLine(
      result,
      "E_CONFIG_INVALID: Native workspace cache layout conflicts with declared mounts or is invalid; values omitted."
    );
    expect(await f.calls()).toEqual(["runtime check-project-share"]);
  },
  SPAWN_TIMEOUT_MS
);
