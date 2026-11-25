import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beginNativeProjectFinalization } from "../src/backends/native-project-finalization.ts";
import {
  beginNativeProjectStartupObservation,
  loadNativeProjectRun,
  type NativeProjectRun,
  saveNativeProjectRun,
} from "../src/backends/native-project-run.ts";
import { NATIVE_PROVIDER_PIN_MESSAGE } from "../src/backends/native-runtime-client.ts";
import { NATIVE_HOOK_OUTPUT_TERMINAL_ONLY } from "../src/lib/native-detached-up.ts";
import { installNext13Frontend } from "./helpers/native-next13-state.ts";
import { nativeSetupShellReply } from "./helpers/native-setup-inspection.ts";
import { nativeSourceSizeReceipt } from "./helpers/native-source-size.ts";
import { mkdirOwnedFixture } from "./helpers/owned-fixture.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";
import { waitForFileContent } from "./helpers/wait-for-file-content.ts";

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
  await mkdirOwnedFixture(projectDir, true);
  await mkdir(nativeHome, { mode: 0o700 });
  await mkdir(runtimeDir);
  await mkdir(stub);
  await writeFile(join(projectDir, "docker-compose.yml"), compose);
  await writeFile(
    join(stub, "project-source-size.out"),
    JSON.stringify(nativeSourceSizeReceipt())
  );
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
case "$1" in --internal-timings=*) shift;; esac
${nativeSetupShellReply()}
if [ "$3-$4" = runtime-build-image ] && [ -f '${stub}/runtime-build-image.hold' ]; then
  request="${"$"}{6##*/}"
  trap '' INT
  trap 'printf settled > "$request.settled"; exit 1' TERM
  printf '%s' ready > "$request.ready"
  for i in $(seq 1 400); do sleep 0.05; done
  exit 99
fi
if [ -f '${stub}/'"$3-$4"'.hold' ]; then
  printf '%s' ready > './interrupt-ready'
  exec sleep 20
fi
printf '%s\\n' "$*" >> '${stub}/calls'
if [ "$3-$4" = project-plan ] && [ -f '${stub}/normalized-plan.ts' ]; then
  previous=
  for flag in "$@"; do
    if [ "$previous" = --normalized-file ]; then
      exec '${process.execPath}' '${stub}/normalized-plan.ts' "$flag"
    fi
    previous="$flag"
  done
fi
if [ -f '${stub}/'"$3-$4"'.out' ]; then
  if [ -f '${stub}/'"$3-$4"'.after-inspect' ]; then cp '${stub}/'"$3-$4"'.after-inspect' '${stub}/graph-inspect.out'; fi
  cat '${stub}/'"$3-$4"'.out'; exit 0
fi
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
  const argv = async () =>
    (await readFile(join(stub, "calls"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);
  const calls = async () =>
    (await argv()).map((line) => line.split(" ").slice(2, 4).join(" "));
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
  const finishOn = async (request: string, value: unknown) =>
    await writeFile(
      join(stub, `${request.replace(" ", "-")}.after-inspect`),
      JSON.stringify(value)
    );
  const hold = async (request: string) =>
    await writeFile(join(stub, `${request.replace(" ", "-")}.hold`), "");
  return {
    root,
    project,
    hold,
    projectDir,
    scope,
    binary,
    compose,
    argv,
    reply,
    fail,
    finishOn,
    calls,
    env,
  };
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
    start_refusals: [],
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

test(
  "a second targeted up asks the busy graph's owner before waiting for the provider",
  async () => {
    const f = await fixture();
    await saveNativeProjectRun({ ...f.scope, run });
    await f.fail("graph inspect", { code: "provider_busy" });
    await f.reply("graph owner-status", {
      ok: true,
      run: run.run,
      plan: run.planId,
      phase: "ready-observed",
      foreground_alive: true,
      runtime_verified: false,
      runtime_error: "graph_starting",
    });
    const result = await cli({
      fixture: f,
      args: ["up", "web", "--detach", "--json"],
      env: SHARED,
    });
    expect(result.code, result.output).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "E_NATIVE_STILL_STARTING" },
    });
    expect(await f.calls()).toEqual(["graph inspect", "graph owner-status"]);
  },
  SPAWN_TIMEOUT_MS
);

test.each([false, true])(
  "Ctrl-C reports an uncertain targeted start and leaves the project mapping (JSON: %s)",
  async (json) => {
    const image = `sha256:${"e".repeat(64)}`;
    const f = await fixture(
      JSON.stringify({ services: { web: { image }, slow: { image } } })
    );
    await saveNativeProjectRun({ ...f.scope, run });
    await f.reply("graph inspect", {
      journal_incomplete: false,
      receipt: {
        run: run.run,
        owner: run.owner,
        namespace: run.namespace,
        plan_id: run.planId,
        phase: "ready-observed",
        readiness: { web: "started" },
      },
    });
    await f.reply("graph owner-status", {
      ok: true,
      run: run.run,
      plan: run.planId,
      phase: "ready-observed",
      foreground_alive: true,
      runtime_verified: true,
      generation: "1".repeat(64),
      service_images: { web: image },
    });
    await f.reply("runtime status", { phase: "running", process_alive: true });
    await scriptUpThroughReview(f, { services: { slow: { active: true } } });
    await f.hold("graph extend");
    const child = Bun.spawn(
      [
        process.execPath,
        entrypoint,
        "--path",
        f.project,
        "up",
        "slow",
        ...(json ? ["--json"] : []),
      ],
      {
        cwd: f.project,
        env: f.env(SHARED),
        detached: true,
        stdout: "pipe",
        stderr: "pipe",
        timeout: SPAWN_TIMEOUT_MS - 5000,
      }
    );
    const stderr = new Response(child.stderr).text();
    const stdout = new Response(child.stdout).text();
    try {
      await waitForFileContent({
        path: join(f.project, "interrupt-ready"),
        complete: (value) => (value === "ready" ? value : undefined),
        what: "targeted owner request",
        budgetMs: 10_000,
      });
      child.kill("SIGINT");
      const code = await child.exited;
      expect(code, await stderr).toBe(1);
      if (json) {
        expect(JSON.parse(await stdout)).toMatchObject({
          ok: false,
          error: {
            code: "E_NATIVE_START_OUTCOME_UNKNOWN",
            message: "The start may have completed; check hack ps",
          },
        });
      } else {
        expect(await stderr).toContain(
          "The start may have completed; check hack ps"
        );
      }
      expect(await loadNativeProjectRun(f.scope)).toEqual(run);
      expect(await f.calls()).not.toContain("graph cleanup");
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
      await child.exited;
    }
  },
  SPAWN_TIMEOUT_MS
);

test.each(["missing", "exited"] as const)(
  "plain native up reaches the owner extension for %s services",
  async (state) => {
    const image = `sha256:${"e".repeat(64)}`;
    // Bun accepts the authored tag and delivers tag-free normalized JSON.
    const f = await fixture(
      `x-example: !override fixture\nservices:\n  web: {init: true, image: ${image}}\n  redis: {init: true, image: ${image}}\n`
    );
    const services = state === "missing" ? ["web"] : ["web", "redis"];
    const receipt = {
      run: run.run,
      owner: run.owner,
      namespace: run.namespace,
      plan_id: run.planId,
      phase: "ready-observed",
      relay_startup: {},
      readiness: Object.fromEntries(services.map((name) => [name, "started"])),
      resources: Object.fromEntries(
        services.map((name) => [
          `container:${name}`,
          {
            kind: "container",
            key: name,
            phase: "started",
            id: "9".repeat(64),
          },
        ])
      ),
    };
    await saveNativeProjectRun({ ...f.scope, run });
    const snapshot = {
      journal_incomplete: false,
      receipt,
      observations: Object.fromEntries(
        services.map((name) => [
          `container:${name}`,
          state === "exited"
            ? { state: "exited", code: 0 }
            : { state: "running", health: "none" },
        ])
      ),
    };
    await f.reply("graph inspect", snapshot);
    await f.reply("graph status", snapshot);
    await f.fail("graph retained-preflight", {
      code: "graph_foreground_owner_running",
    });
    await f.reply("graph owner-status", {
      ok: true,
      run: run.run,
      plan: run.planId,
      phase: receipt.phase,
      foreground_alive: true,
      runtime_verified: true,
      generation: "1".repeat(64),
      service_images: Object.fromEntries(services.map((name) => [name, image])),
    });
    await f.reply("runtime status", { phase: "running", process_alive: true });
    await scriptUpThroughReview(f, {
      services: { web: { active: true }, redis: { active: true } },
    });
    await writeFile(
      join(f.root, "stub", "normalized-plan.ts"),
      `const content = await Bun.file(Bun.argv[2]).text();
const hash = new Bun.CryptoHasher("sha256").update(content).digest("hex");
const { services } = JSON.parse(content);
await Bun.write(new URL("./normalized-" + hash + ".json", import.meta.url), content);
console.log(JSON.stringify({
  plan_id: hash,
  start_refusals: [],
  plan: {
    namespace: "${run.namespace}",
    compose_sha256: hash,
    enrollment_compatible: true,
    services: Object.fromEntries(Object.keys(services).map(name => [name, {active: true}]))
  }
}));`
    );
    const started = state === "exited" ? ["redis", "web"] : ["redis"];
    await f.reply("graph extend", {
      ok: true,
      phase: receipt.phase,
      started,
      changed: [],
      receipt,
    });
    const result = await cli({
      fixture: f,
      args: ["up", "-d", "--json"],
      env: SHARED,
    });
    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      data: { services: { started } },
    });
    const calls = await f.calls();
    expect(calls.filter((call) => call === "graph extend")).toHaveLength(1);
    const append = (await f.argv()).find((line) =>
      line.includes(" graph extend ")
    );
    const fullHash = append?.match(
      /--combined-plan ([a-f0-9]{64}) --combined-normalized-sha256 \1/
    )?.[1];
    if (!fullHash) {
      throw new Error(
        "Expected the full normalized review in the append request"
      );
    }
    const normalized = await readFile(
      join(f.root, "stub", `normalized-${fullHash}.json`),
      "utf8"
    );
    const full = JSON.parse(normalized);
    expect(full).toMatchObject({
      "x-example": "fixture",
      services: { web: { init: true, image }, redis: { init: true, image } },
    });
    expect(Object.keys(full.services)).toEqual(["web", "redis"]);
    expect(createHash("sha256").update(normalized).digest("hex")).toBe(
      fullHash
    );
    expect(calls).not.toContain("graph serve");
    expect(calls).not.toContain("runtime up");
  },
  SPAWN_TIMEOUT_MS
);

test(
  "targeted native up refuses an unknown service before any graph request",
  async () => {
    const f = await fixture();
    const result = await cli({
      fixture: f,
      args: ["up", "missing", "--json"],
      env: SHARED,
    });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "E_SERVICE_NOT_FOUND",
        message: "Unknown Compose service: missing.",
      },
    });
    expect(await f.calls()).toEqual([]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "targeted native up uses the mapped owner and emits the Compose lifecycle shape",
  async () => {
    const image = `sha256:${"e".repeat(64)}`;
    const f = await fixture(
      JSON.stringify({
        services: {
          web: { image },
          redis: { image, depends_on: ["cache"] },
          cache: { image },
          unused: { image, ports: ["18080:80/udp"] },
        },
      })
    );
    await saveNativeProjectRun({ ...f.scope, run });
    const receipt = {
      run: run.run,
      owner: run.owner,
      namespace: run.namespace,
      plan_id: run.planId,
      phase: "ready-observed",
      readiness: { web: "started" },
    };
    const generation = "1".repeat(64);
    await f.reply("graph inspect", { journal_incomplete: false, receipt });
    await f.reply("graph owner-status", {
      ok: true,
      run: run.run,
      plan: run.planId,
      phase: "ready-observed",
      foreground_alive: true,
      runtime_verified: true,
      generation,
      service_images: { web: image },
    });
    await f.reply("runtime status", { phase: "running", process_alive: true });
    await scriptUpThroughReview(f, {
      services: { cache: { active: true }, redis: { active: true } },
    });
    await f.reply("graph extend", {
      ok: true,
      phase: "ready-observed",
      started: ["cache", "redis"],
      changed: [],
      receipt: {
        ...receipt,
        readiness: { ...receipt.readiness, cache: "started", redis: "started" },
      },
    });

    const result = await cli({
      fixture: f,
      args: ["up", "redis", "--json"],
      env: SHARED,
    });
    expect(result.code, result.output).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      data: {
        action: "up",
        project: "refusal-fixture",
        branch: null,
        composeProject: "refusal-fixture",
        services: {
          started: ["cache", "redis"],
          completed: [],
          stopped: [],
          failed: [],
        },
        durationMs: expect.any(Number),
      },
    });
    const calls = await f.calls();
    expect(calls.filter((request) => request === "graph extend")).toHaveLength(
      1
    );
    expect(calls).not.toContain("runtime up");
    expect(calls).not.toContain("graph serve");
    expect(calls).not.toContain("graph cleanup");
    expect(await loadNativeProjectRun(f.scope)).toEqual(run);

    await rm(join(f.root, "stub", "graph-extend.out"));
    const message = "The running pool has insufficient free bridge sockets.";
    await f.fail("graph extend", {
      code: "graph_owner_recovery",
      cause_code: "bridge_capacity_exhausted",
      message,
      message_fixed: true,
    });
    const refused = await cli({
      fixture: f,
      args: ["up", "redis", "--json"],
      env: SHARED,
    });
    expect(refused.code).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "E_STARTUP_INCOMPLETE",
        detail: {
          nativeCode: "graph_owner_recovery",
          causeCode: "bridge_capacity_exhausted",
          message,
        },
      },
    });
  },
  SPAWN_TIMEOUT_MS
);

test(
  "detached static UDP refusal names its fix and reports no start through the source CLI",
  async () => {
    const f = await fixture(
      JSON.stringify({
        services: {
          web: { image: `sha256:${"e".repeat(64)}`, ports: ["18080:80/udp"] },
        },
      })
    );
    const reason =
      "Native publishes only TCP ports; keep UDP publication on the Compose backend.";
    await f.reply("runtime check-project-share", {
      source_admitted: true,
      pool_initialized: false,
    });
    await f.reply("project plan", {
      plan_id: "f".repeat(64),
      plan: {
        namespace: run.namespace,
        compose_sha256: createHash("sha256").update(f.compose).digest("hex"),
        enrollment_compatible: false,
        services: { web: { active: true } },
      },
      start_refusals: [
        {
          code: "graph_port_publication",
          message: reason,
          message_fixed: true,
          service: "web",
        },
      ],
    });
    const result = await cli({
      fixture: f,
      args: ["up", "-d", "--json"],
      env: SHARED,
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("graph_port_publication");
    expect(result.output).toContain("nothing was started");
    expect(result.output).toContain(reason);
    expect(result.output).not.toContain(
      "retained owners and recovery evidence"
    );
    const calls = await f.calls();
    expect(calls.filter((call) => call === "project plan")).toHaveLength(2);
    expect(
      calls.every((call) =>
        [
          "project source-size",
          "project plan",
          "runtime check-project-share",
        ].includes(call)
      )
    ).toBe(true);
  },
  SPAWN_TIMEOUT_MS
);

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
  "provider version refusal survives ps JSON, detached up and exec through the source CLI",
  async () => {
    const f = await fixture();
    const pin = {
      code: "provider_pin_changed",
      message: "synthetic-private-provider-path",
    };
    await scriptUpThroughReview(f);
    await unlink(join(f.root, "stub/runtime-up.out"));
    await f.fail("runtime up", pin);
    const detached = await cli({
      fixture: f,
      args: ["up", "-d", "--json"],
      env: SHARED,
    });
    expect(detached.code).toBe(1);
    expect(detached.output).toContain("provider_pin_changed");
    expect(detached.output).toContain(NATIVE_PROVIDER_PIN_MESSAGE);
    expect(detached.output).not.toContain("synthetic-private");
    await savedRun(f);
    await f.fail("graph status", pin);
    const ps = await cli({ fixture: f, args: ["ps", "--json"] });
    expect(ps.code).toBe(0);
    expect(JSON.parse(ps.stdout)).toMatchObject({
      ok: true,
      data: { status: "provider_pin_changed", run: run.run, items: [] },
    });
    await f.fail("graph refresh-dependencies", pin);
    const exec = await cli({ fixture: f, args: ["exec", "web", "--", "true"] });
    expect(exec.code).toBe(1);
    expect(exec.output).toContain("provider_pin_changed");
    expect(exec.output).toContain(NATIVE_PROVIDER_PIN_MESSAGE);
    expect(exec.output).not.toContain("identity or outcome is unconfirmed");
    expect(exec.output).not.toContain("synthetic-private");
    expect(await f.calls()).not.toContain("graph exec");
  },
  SPAWN_TIMEOUT_MS
);

test(
  "publisher identity refusal explains waiting, then the named retaining recovery works",
  async () => {
    const f = await fixture();
    await savedRun(f);
    await (
      await beginNativeProjectFinalization({ scope: f.scope, run })
    ).complete();
    await f.reply("graph inspect", {
      ...stoppedGraph,
      receipt: { ...stoppedGraph.receipt, phase: "ready-observed" },
      observations: { "container:web": { state: "running" } },
    });
    await f.reply("graph foreground-owner", {
      version: 1,
      run: run.run,
      owner: run.owner,
      phase: "ready-observed",
      receipt_sha256: "7".repeat(64),
      foreground: "exited",
      live_owner_recovery: null,
    });
    await f.fail("graph recover-live-owner", {
      code: "publisher_identity_unconfirmed",
      message: "private process metadata",
    });
    const refused = await cli({ fixture: f, args: ["down", "--recover"] });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain(
      "process holding the recorded publisher PID to exit"
    );
    expect(refused.output).toContain("rerun hack down --recover");
    expect(refused.output).not.toContain("private process metadata");
    await f.reply("graph recover-live-owner", {
      run: run.run,
      recovered: true,
      data_retained: true,
      publisher_retired: true,
    });
    await f.finishOn("graph recover-live-owner", stoppedGraph);
    const rerun = await cli({ fixture: f, args: ["down", "--recover"] });
    expect(rerun.code).toBe(0);
    expect(rerun.output).toContain("stopped");
  },
  SPAWN_TIMEOUT_MS
);

test(
  "config adopt --dry-run on the native backend names the exact Compose rerun before any request",
  async () => {
    const f = await fixture();
    const before = await readdir(f.projectDir);
    for (const [args, command] of [
      [["config", "adopt", "--dry-run"], "hack config adopt --dry-run"],
      [["config", "adopt"], "hack config adopt"],
      [["config", "adopt", "--rollback"], "hack config adopt --rollback"],
      [["config", "adopt", "--recover"], "hack config adopt --recover"],
      [["config", "adopt", "--stop"], "hack config adopt --stop"],
      [
        ["config", "adopt", "--recover", "--rollback"],
        "hack config adopt --rollback --recover",
      ],
    ] as const) {
      const result = await cli({ fixture: f, args });
      expectOneClosedLine(
        result,
        `E_NATIVE_PROJECT_UNSUPPORTED: Native project configuration currently requires the Compose backend. The selected runtime was not changed. Rerun with HACK_RUNTIME_BACKEND=compose, for example: HACK_RUNTIME_BACKEND=compose ${command}`
      );
    }
    expect(await f.calls()).toEqual([]);
    expect(await readdir(f.projectDir)).toEqual(before);
  },
  SPAWN_TIMEOUT_MS
);

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
    await f.reply("graph status", "not-json");
    const result = await cli({ fixture: f, args: ["ps"] });
    expectOneClosedLine(
      result,
      "Native runtime returned an invalid control response."
    );
    expect(await f.calls()).toEqual(["graph status"]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native-project-source-size: oversized captured source is one coded line before any runtime work",
  async () => {
    // A bind mount captures source; image-only graphs (the other fixtures) are
    // never measured, so their calls below carry no `project source-size`.
    const f = await fixture(
      JSON.stringify({
        services: {
          web: {
            image: `sha256:${"e".repeat(64)}`,
            volumes: ["./src:/app:ro"],
          },
        },
      })
    );
    await scriptUpThroughReview(f);
    await f.reply(
      "project source-size",
      nativeSourceSizeReceipt({ totalBytes: 140 * 1024 * 1024 })
    );
    const result = await cli({ fixture: f, args: ["up"], env: SHARED });
    expectOneClosedLine(
      result,
      "E_NATIVE_PROJECT_UNSUPPORTED: Selected (non-ignored) source is 140 MiB in 3 files; the native source limit is 128 MiB (default). Native up refuses source over the limit; no runtime, image or build work was started. Largest directories: assets (140 MiB), assets/video (140 MiB). Largest files: assets/video/intro.bin (140 MiB). Exclude paths the containers do not need in the project's .gitignore or .ignore file (for example a line such as `assets/video/`) or raise native.sourceLimitMiB in .hack/hack.config.json (maximum 512)."
    );
    expect(await f.calls()).toEqual([
      "project plan",
      "project plan",
      "runtime check-project-share",
      "project source-size",
    ]);
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
      "E_CONFIG_INVALID: Native host dependencies refused: the selection must be {version: 1, dependencies: [1..128 entries]} with no other fields; listener values omitted."
    );
    expect(await f.calls()).toEqual([
      "project plan",
      "project plan",
      "runtime check-project-share",
    ]);
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
    expect(await f.calls()).toEqual(["project plan"]);
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
    const f = await fixture(
      JSON.stringify({
        services: {
          web: {
            image: `sha256:${"e".repeat(64)}`,
            extra_hosts: ["search.example.com:host-gateway"],
          },
        },
      })
    );
    await scriptUpThroughReview(f);
    // Only a graph with a host dependency asks the runtime for this plan.
    const dependencies = join(f.scope.projectRoot, "host-dependencies.json");
    await writeFile(
      dependencies,
      JSON.stringify({
        version: 1,
        dependencies: [
          {
            service: "web",
            binding: "search",
            guest_port: 443,
            host_pid: 999,
            host_port: 8443,
            aliases: ["search.example.com"],
          },
        ],
      })
    );
    await f.reply("graph dependency-check", { listener_confirmed: true });
    await f.reply("graph dependency-plan", { dependency_plan_id: "x" });
    const result = await cli({
      fixture: f,
      args: ["up"],
      env: { ...SHARED, HACK_NATIVE_DEPENDENCIES: dependencies },
    });
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
      "Native restore selection changed; retained data was not adopted. Revert the change to keep that data, or run `hack down --remove-data` to discard it and start fresh."
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
      "Native foreground exit cleanup is unconfirmed; runtime and bridge state may be retained. Run hack down --recover to resume this run's confirmed cleanup with data retained. Startup diagnostic: Native graph startup was interrupted or failed (runtime_not_running). Native exit diagnostic: runtime_not_running."
    );
    expect((await f.calls()).slice(-2)).toEqual([
      "graph serve",
      "graph inspect",
    ]);
    const next = await cli({ fixture: f, args: ["down", "--recover"] });
    expect(next.code).toBe(0);
  },
  SPAWN_TIMEOUT_MS
);

test.each([
  "graph_cleanup_enrollment",
  "graph_publisher_running",
  "publisher_stop_uncertain",
  "graph_dead_owner_recovery",
])(
  "recovery refusal %s names a ps command that succeeds on the retained run",
  async (code) => {
    const f = await fixture();
    await savedRun(f);
    const observed = {
      ...stoppedGraph,
      receipt: { ...stoppedGraph.receipt, phase: "ready-observed" },
      observations: { "container:web": { state: "running" } },
    };
    await f.reply("graph inspect", observed);
    await f.reply("graph status", observed);
    await (
      await beginNativeProjectFinalization({ scope: f.scope, run })
    ).complete();
    await f.reply("graph foreground-owner", {
      version: 1,
      run: run.run,
      owner: run.owner,
      phase: "ready-observed",
      receipt_sha256: "7".repeat(64),
      foreground: "exited",
      live_owner_recovery: null,
    });
    await f.fail("graph recover-live-owner", { code });
    const refused = await cli({ fixture: f, args: ["down", "--recover"] });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("Run hack ps --json");
    const next = await cli({ fixture: f, args: ["ps", "--json"] });
    expect(next.code).toBe(0);
    expect(JSON.parse(next.stdout).data.status).toBe("observed");
    expect((await f.calls()).at(-1)).toBe("graph status");
  },
  SPAWN_TIMEOUT_MS
);

test.each(["provider_busy", "native_request_timeout"])(
  "transient recovery refusal %s names a down retry that succeeds",
  async (code) => {
    const f = await fixture();
    await savedRun(f);
    await (
      await beginNativeProjectFinalization({ scope: f.scope, run })
    ).complete();
    await f.reply("graph inspect", {
      ...stoppedGraph,
      receipt: { ...stoppedGraph.receipt, phase: "ready-observed" },
      observations: { "container:web": { state: "running" } },
    });
    await f.reply("graph foreground-owner", {
      version: 1,
      run: run.run,
      owner: run.owner,
      phase: "ready-observed",
      receipt_sha256: "7".repeat(64),
      foreground: "exited",
      live_owner_recovery: null,
    });
    await f.fail("graph recover-live-owner", { code });
    const refused = await cli({ fixture: f, args: ["down", "--recover"] });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("Run hack down --recover");
    await f.reply("graph recover-live-owner", {
      run: run.run,
      recovered: true,
      data_retained: true,
      publisher_retired: true,
    });
    await f.finishOn("graph recover-live-owner", stoppedGraph);
    const next = await cli({ fixture: f, args: ["down", "--recover"] });
    expect(next.code).toBe(0);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "stopped-runtime recovery refusal names ps, which confirms the stopped runtime",
  async () => {
    const f = await fixture();
    await savedRun(f);
    await f.fail("graph inspect", { code: "runtime_not_running" });
    const refused = await cli({ fixture: f, args: ["down", "--recover"] });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain(
      "Run hack ps --json to see whether the native runtime is stopped"
    );
    expect(refused.output).not.toContain("containers are running");
    // No readable owner selection: nothing starts the pool (HACK-2456).
    expect(await f.calls()).not.toContain("runtime up");
    const next = await cli({ fixture: f, args: ["ps", "--json"] });
    expect(next.code).toBe(0);
    expect(JSON.parse(next.stdout).data.status).toBe("runtime_not_running");
  },
  SPAWN_TIMEOUT_MS
);

test(
  "predecessor hint failure keeps its diagnostic and names a working inspection command",
  async () => {
    const f = await fixture();
    await savedRun(f);
    await (
      await beginNativeProjectFinalization({ scope: f.scope, run })
    ).complete();
    await f.reply("graph inspect", stoppedGraph);
    await f.reply("graph status", stoppedGraph);
    await f.reply("graph foreground-owner", {
      version: 1,
      run: run.run,
      owner: run.owner,
      phase: "stopped-data-retained",
      receipt_sha256: "7".repeat(64),
      foreground: "exited",
      live_owner_recovery: null,
      dead_owner_recovery: null,
      dead_owner_recovery_error: "invalid_receipt",
    });
    const refused = await cli({ fixture: f, args: ["down", "--recover"] });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain(
      "predecessor recovery selection failed (invalid_receipt)"
    );
    expect(refused.output).toContain("Run hack ps --json");
    expect(await f.calls()).not.toContain("graph recover-live-owner");
    const next = await cli({ fixture: f, args: ["ps", "--json"] });
    expect(next.code).toBe(0);
  },
  SPAWN_TIMEOUT_MS
);

/** A project whose only service names a local registry the candidate refuses without an opt-in. */
const REGISTRY_COMPOSE = JSON.stringify({
  services: { web: { image: "localhost:5000/example/app:1" } },
});
const BUILD_COMPOSE = JSON.stringify({
  services: {
    web: { build: { context: "..", target: "web" } },
    worker: { build: { context: "..", target: "worker" } },
    tools: { build: { context: "..", target: "tools" } },
  },
});
test.each(["fetch", "graph", "hook", "build"] as const)(
  "Ctrl-C during native startup %s reports one interruption and exits 130",
  async (stage) => {
    const f = await fixture(
      stage === "fetch"
        ? REGISTRY_COMPOSE
        : stage === "build"
          ? BUILD_COMPOSE
          : COMPOSE
    );
    await scriptUpThroughReview(f);
    if (stage === "fetch") {
      await f.reply("runtime admit-image", {
        reference: "localhost:5000/example/app:1",
        kind: "registry",
      });
      await f.hold("runtime ensure-image");
    } else if (stage === "graph") {
      await f.hold("graph serve");
      await f.fail("graph inspect", { code: "graph_unreserved" });
    } else if (stage === "build") {
      await f.reply("runtime up", { profile: "development" });
      await f.hold("runtime build-image");
    } else {
      await Bun.write(
        join(f.projectDir, "hack.config.json"),
        JSON.stringify({
          name: "refusal-fixture",
          lifecycle: {
            up: {
              before: [
                { command: "printf ready > interrupt-ready; exec sleep 20" },
                { command: "touch unexpected-hook" },
              ],
            },
          },
        })
      );
    }
    const child = Bun.spawn(
      [process.execPath, entrypoint, "--path", f.project, "up"],
      {
        cwd: f.project,
        env: f.env({ ...SHARED, HACK_NATIVE_BUILDS: "1" }),
        detached: true,
        stdout: "pipe",
        stderr: "pipe",
        timeout: SPAWN_TIMEOUT_MS - 5000,
      }
    );
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    try {
      const barriers =
        stage === "build"
          ? ["request-0.json", "request-1.json", "request-2.json"]
          : [];
      await Promise.all(
        (barriers.length > 0
          ? barriers.map((request) => `${request}.ready`)
          : ["interrupt-ready"]
        ).map((barrier) =>
          waitForFileContent({
            path: join(f.project, barrier),
            complete: (value) => (value === "ready" ? value : undefined),
            what: stage,
            budgetMs: 10_000,
          })
        )
      );
      process.kill(-child.pid, "SIGINT");
      const exitCode = await child.exited;
      expect(exitCode, await stderr).toBe(130);
      for (const request of barriers) {
        expect(
          await Bun.file(join(f.project, `${request}.settled`)).text()
        ).toBe("settled");
      }
      const output = (await stdout) + (await stderr);
      expect(
        output.split("\n").filter((line) => /interrupted/i.test(line))
      ).toEqual(["Native project startup interrupted."]);
      expect(output).not.toMatch(/failed/i);
      const calls = await f.calls();
      if (stage === "graph") {
        expect(calls.at(-1)).toBe("graph inspect");
      } else {
        expect(calls).not.toContain("graph inspect");
      }
      expect(calls.includes("runtime up")).toBe(stage !== "hook");
      expect(await loadNativeProjectRun(f.scope)).toBeNull();
      expect(await Bun.file(join(f.project, "unexpected-hook")).exists()).toBe(
        false
      );
    } finally {
      if (child.exitCode === null) {
        process.kill(-child.pid, "SIGKILL");
        await child.exited;
      }
    }
  },
  SPAWN_TIMEOUT_MS
);

const IMAGE_REFUSAL =
  "Native project image reference refused before runtime startup: use a Docker Hub or OCI registry reference (shorthand such as alpine:3.21 is accepted; local registries need HACK_NATIVE_LOCAL_REGISTRIES) or a sha256 image ID; no VM, provider or image acquisition was started.";

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
    expect(result.output).not.toContain("localhost:5000");
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
    expect(result.output).not.toContain("localhost:5000");
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
    expect(await f.calls()).toEqual([]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native-admission-reuse: a bound the runtime would refuse is one coded line before any request, for up and restart",
  async () => {
    const f = await fixture();
    const refusal =
      "HACK_NATIVE_ADMISSION_REUSE_SECONDS must be a whole number of seconds from 0 to 600; 0 turns reuse off. A larger value is refused, not reduced to 600.";
    const env = { ...SHARED, HACK_NATIVE_ADMISSION_REUSE_SECONDS: "601" };
    for (const args of [["up"], ["up", "--detach"], ["restart"]]) {
      expectOneClosedLine(
        await cli({ fixture: f, args, env }),
        `E_CONFIG_INVALID: ${refusal}`
      );
    }
    // The detached JSON restart refuses in the launcher, where the owner's
    // own refusal would not be seen.
    for (const args of [
      ["up", "--json"],
      ["up", "--detach", "--json"],
      ["restart", "--json"],
    ]) {
      const result = await cli({ fixture: f, args, env });
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: "E_CONFIG_INVALID", message: refusal },
      });
    }
    expect(await f.calls()).toEqual([]);
  },
  SPAWN_TIMEOUT_MS * 3
);

/** HACK-1952: home A stopped the run cleanly; home B is another launcher version's home. */
async function stoppedInAnotherHome(f: Fixture, stop = true) {
  const homeB = join(f.root, "native-home-b");
  await mkdir(homeB, { mode: 0o700 });
  await savedRun(f);
  const lifetime = await beginNativeProjectFinalization({
    scope: f.scope,
    run,
    httpsPort: null,
  });
  if (stop) {
    await lifetime.complete();
  }
  return { HACK_NATIVE_HOME: homeB, ...SHARED };
}

test(
  "native-project-run: another home's stopped mapping names the release, which then frees this home",
  async () => {
    const f = await fixture();
    const homeB = await stoppedInAnotherHome(f);
    const inspected = await cli({
      fixture: f,
      args: ["doctor", "--native-run-mapping", "inspect", "--json"],
      env: homeB,
    });
    expect(inspected.code).toBe(0);
    const inspection = JSON.parse(inspected.stdout).data;
    expect(inspection).toMatchObject({
      state: "foreign-home",
      owner: "stopped",
      ownerHome: f.scope.nativeHome,
    });
    const selection: string = inspection.selectionSha256;
    expect(selection).toMatch(/^[a-f0-9]{64}$/);
    const refusal = `Native project run mapping belongs to run ${run.run} in another native home (${f.scope.nativeHome}), which stopped it cleanly; its retained data stays in that home. To start this instance from this native home, release the mapping with hack doctor --native-run-mapping release --expect-selection ${selection}, or run hack down with the Hack version that owns that home.`;
    // HACK-2339: up, foreground and detached, refuses like ps and down.
    for (const args of [
      ["ps"],
      ["up"],
      ["up", "--detach"],
      ["down"],
      ["doctor", "--native-cleanup", "inspect"],
    ]) {
      expectOneClosedLine(
        await cli({ fixture: f, args, env: homeB }),
        `E_NATIVE_RUN_MAPPING_FOREIGN_HOME: ${refusal}`
      );
    }
    for (const args of [
      ["up", "--json"],
      ["up", "--detach", "--json"],
      // HACK-2338 item 2: the detached JSON restart keeps the refusal too.
      ["restart", "--json"],
    ]) {
      const result = await cli({ fixture: f, args, env: homeB });
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: false,
        error: {
          code: "E_NATIVE_RUN_MAPPING_FOREIGN_HOME",
          message: refusal,
          detail: expect.objectContaining({
            owner: "stopped",
            selectionSha256: selection,
            releaseCommand: `hack doctor --native-run-mapping release --expect-selection ${selection}`,
          }),
        },
      });
      expect(result.stdout).not.toContain("E_STARTUP_INCOMPLETE");
    }
    const released = await cli({
      fixture: f,
      args: [
        "doctor",
        "--native-run-mapping",
        "release",
        "--expect-selection",
        selection,
      ],
      env: homeB,
    });
    expect(released.code).toBe(0);
    expect(released.stdout).toContain(
      "Native run mapping released from another native home"
    );
    const down = await cli({ fixture: f, args: ["down"], env: homeB });
    expect(down.output).not.toContain("run mapping");
    expect(down.code).toBe(0);
  },
  SPAWN_TIMEOUT_MS * 2
);

test(
  "native-project-run: another home's live owner is one closed line naming it",
  async () => {
    const f = await fixture();
    const homeB = await stoppedInAnotherHome(f, false);
    for (const args of [["ps"], ["up"], ["up", "--detach"], ["down"]]) {
      expectOneClosedLine(
        await cli({ fixture: f, args, env: homeB }),
        `E_NATIVE_RUN_MAPPING_FOREIGN_HOME: Native project run mapping is owned by live run ${run.run} in another native home (${f.scope.nativeHome}), frontend pid ${process.pid}. Stop it first: press Ctrl-C in that hack up, or run hack down with the Hack version that owns that home; then retry here.`
      );
    }
    expect(await f.calls()).toEqual([]);
  },
  SPAWN_TIMEOUT_MS * 2
);

test(
  "ps renders pending startup without a misleading not-started line or empty service table",
  async () => {
    const f = await fixture();
    const finish = await beginNativeProjectStartupObservation(f.scope);
    try {
      const text = await cli({ fixture: f, args: ["ps"] });
      expect(text.code).toBe(0);
      expect(text.output).toContain("Native project startup is pending");
      expect(text.output).not.toContain("has not been started");
      expect(text.output).not.toContain("NATIVE SERVICE");
      const json = await cli({ fixture: f, args: ["ps", "--json"] });
      expect(json.code).toBe(0);
      expect(JSON.parse(json.stdout).data).toMatchObject({
        status: "pending",
        run: null,
        items: [],
      });
      expect(await f.calls()).toEqual([]);
    } finally {
      await finish();
    }
  },
  SPAWN_TIMEOUT_MS
);

test(
  "next.13 frontend: down --recover exits zero and plain up reaches a new ready lifetime",
  async () => {
    const f = await fixture();
    const exited = Bun.spawn([process.execPath, "-e", ""], {
      env: privateCliEnv({ root: f.root }),
      stdout: "ignore",
      stderr: "pipe",
    });
    expect(await exited.exited).toBe(0);
    await installNext13Frontend({ scope: f.scope, exitedPid: exited.pid });
    await f.reply("graph inspect", stoppedGraph);
    // The run mapping at started is read lease-free.
    await f.reply("graph status", stoppedGraph);
    await f.reply("graph foreground-owner", {
      version: 1,
      run: run.run,
      owner: run.owner,
      phase: "stopped-data-retained",
      receipt_sha256: "7".repeat(64),
      foreground: "absent",
      live_owner_recovery: null,
    });
    await f.reply("runtime managed-hostname-authority", {
      authority: { present: false },
    });
    const stopped = await cli({
      fixture: f,
      args: ["down", "--recover"],
      env: SHARED,
    });
    expect(stopped.code).toBe(0);
    await scriptUpThroughReview(f);
    const sha = createHash("sha256").update(f.compose).digest("hex");
    await f.reply("project plan", {
      plan_id: run.planId,
      start_refusals: [],
      plan: {
        namespace: run.namespace,
        compose_sha256: sha,
        enrollment_compatible: true,
        services: { web: { active: true } },
      },
    });
    await f.reply("graph retained-preflight", {
      version: 1,
      run: run.run,
      owner: run.owner,
      namespace: run.namespace,
      plan: run.planId,
      live_resources_verified: false,
      runtime_phase: "stopped",
      selection: "8".repeat(64),
    });
    await f.reply("graph restore-selection", {
      ...run,
      plan: run.planId,
      generation: "9".repeat(64),
    });
    await f.reply("graph dependency-plan", {
      dependency_plan_id: "1".repeat(64),
    });
    await f.reply(
      "graph serve-restore",
      // The owner reports every service started, then ready.
      `${JSON.stringify({ kind: "graph_foreground_started", phase: "started-observed", run: run.run })}\n${JSON.stringify({ kind: "graph_foreground_ready", run: run.run })}\n`
    );
    // This fake owner immediately finishes a retaining stop after its ready event.
    // The frontend still checks its exact stopped graph and finalizes independently.
    const started = await cli({ fixture: f, args: ["up"], env: SHARED });
    expect(started).toMatchObject({ code: 0 });
    // Foreground up announces started, then ready once the owner reports it.
    expect(started.output).toContain("Project started");
    expect(started.output).toContain("All services ready");
    expect(started.output).toContain("owned cleanup confirmed");
    expect(await f.calls()).toContain("graph serve-restore");
  },
  SPAWN_TIMEOUT_MS
);

test(
  "provider-version recovery refusal names the original release, whose down command works on the same home",
  async () => {
    const f = await fixture();
    await savedRun(f);
    await (
      await beginNativeProjectFinalization({ scope: f.scope, run })
    ).complete();
    await f.fail("graph inspect", {
      code: "provider_pin_changed",
      message: "Provider PID file changed",
    });
    const refused = await cli({ fixture: f, args: ["down", "--recover"] });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("different provider version");
    expect(refused.output).toContain("release that started its pool");
    expect(refused.output).toContain("runtime down --json");
    expect(refused.output).not.toContain("PID file changed");
    // Select the matching release's stub against the unchanged home. This is a
    // CLI guidance check, not qualification of a cross-version provider migration.
    await f.reply("graph inspect", {
      ...stoppedGraph,
      receipt: { ...stoppedGraph.receipt, phase: "ready-observed" },
      observations: { "container:web": { state: "running" } },
    });
    await f.reply("graph foreground-owner", {
      version: 1,
      run: run.run,
      owner: run.owner,
      phase: "ready-observed",
      receipt_sha256: "7".repeat(64),
      foreground: "running",
      live_owner_recovery: null,
    });
    await f.reply("graph cleanup", {});
    await f.finishOn("graph cleanup", stoppedGraph);
    const recovered = await cli({ fixture: f, args: ["down", "--recover"] });
    expect(recovered.code).toBe(0);
    await f.reply("runtime down", { phase: "stopped" });
    const stopped = Bun.spawn(
      [
        f.binary,
        "--candidate-root",
        f.scope.nativeHome,
        "runtime",
        "down",
        "--json",
      ],
      {
        cwd: f.root,
        env: f.env(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: SPAWN_TIMEOUT_MS - 5000,
      }
    );
    expect(await stopped.exited).toBe(0);
    expect(JSON.parse(await new Response(stopped.stdout).text())).toEqual({
      phase: "stopped",
    });
  },
  SPAWN_TIMEOUT_MS
);

/**
 * HACK-2339: a refusal before any VM work reaches a detached `up` as the
 * foreground prints it. Without --json both print one coded line; with it the
 * envelope carries the same code and message. No case reaches `runtime up`.
 */
async function expectSameRefusalDetachedAndForeground(opts: {
  readonly f: Fixture;
  readonly line: string;
  readonly code: string;
  readonly message: string;
  /**
   * A failed hook's lines. Foreground `up` prints them as the hook runs; a
   * detached launcher whose stderr is not a terminal (as here) prints one
   * fixed line instead and never these (HACK-2339 security review).
   */
  readonly hookLines?: readonly string[];
}): Promise<void> {
  for (const args of [["up"], ["up", "--detach"]]) {
    const result = await cli({ fixture: opts.f, args, env: SHARED });
    expect(result.code).toBe(1);
    expect(result.output).toContain(opts.line);
    expect(result.output).not.toContain("E_STARTUP_INCOMPLETE");
    expect(result.output).not.toMatch(STACK_FRAME);
    expectHookLines(result, opts.hookLines, {
      detached: args.includes("--detach"),
      json: false,
    });
  }
  for (const args of [
    ["up", "--json"],
    ["up", "--detach", "--json"],
  ]) {
    const result = await cli({ fixture: opts.f, args, env: SHARED });
    expect(result.code).toBe(1);
    // stdout is exactly the envelope.
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: opts.code, message: opts.message },
    });
    // On native, `up --json` is always detached.
    expectHookLines(result, opts.hookLines, { detached: true, json: true });
  }
  expect(await opts.f.calls()).not.toContain("runtime up");
}

function expectHookLines(
  result: Awaited<ReturnType<typeof cli>>,
  lines: readonly string[] | undefined,
  mode: { readonly detached: boolean; readonly json: boolean }
): void {
  if (!lines) {
    expect(result.output).not.toContain(NATIVE_HOOK_OUTPUT_TERMINAL_ONLY);
    return;
  }
  for (const line of lines) {
    // Foreground `up` prints the hook as it runs (its stdout to stdout); a
    // detached launcher with a non-terminal stderr prints none of it.
    if (mode.detached) {
      expect(result.output).not.toContain(line);
    } else {
      expect(result.output).toContain(line);
    }
  }
  if (mode.detached) {
    expect(result.stderr).toContain(NATIVE_HOOK_OUTPUT_TERMINAL_ONLY);
  }
  if (mode.json) {
    expect(result.stdout).not.toContain(NATIVE_HOOK_OUTPUT_TERMINAL_ONLY);
  }
}

test(
  "HACK-2339: a failing up.before hook reports its code, name and output the same detached and in the foreground",
  async () => {
    const f = await fixture();
    await writeFile(
      join(f.projectDir, "hack.config.json"),
      JSON.stringify({
        name: "refusal-fixture",
        dev_host: "refusal-fixture.hack.local",
        lifecycle: {
          up: {
            before: [
              {
                name: "seed-check",
                command:
                  "printf 'hook stdout line\\n'; printf 'hook stderr line\\n' >&2; exit 3",
              },
            ],
          },
        },
      })
    );
    await scriptUpThroughReview(f);
    const message =
      "Lifecycle (native up before) failed (exit 3); values omitted.";
    await expectSameRefusalDetachedAndForeground({
      f,
      line: `E_LIFECYCLE_FAILED: ${message}`,
      code: "E_LIFECYCLE_FAILED",
      message,
      hookLines: [
        "hook stdout line",
        "hook stderr line",
        "Lifecycle (native up before) failed (exit 3): seed-check",
      ],
    });
    // Compose reports the same hook failure with the same code and exit
    // status, the hook's output on stderr (HACK-2311).
    const bin = join(f.root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "docker"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    const compose = await cli({
      fixture: f,
      args: ["up", "--detach", "--json"],
      env: {
        HACK_RUNTIME_BACKEND: "compose",
        PATH: `${bin}:/usr/bin:/bin`,
      },
    });
    // Compose exits with the hook's own status; native, like every native
    // refusal, exits 1. Code, message form and output placement match.
    expect(compose.code).toBe(3);
    expect(JSON.parse(compose.stdout)).toMatchObject({
      ok: false,
      error: {
        code: "E_LIFECYCLE_FAILED",
        message: "Lifecycle (up before) failed (exit 3)",
      },
    });
    expect(compose.stderr).toContain("hook stdout line");
    expect(compose.stderr).toContain("hook stderr line");
  },
  SPAWN_TIMEOUT_MS * 2
);

test(
  "HACK-2339: a source-size refusal reaches a detached up with its code and paths",
  async () => {
    // A bind mount captures source, so `up` measures it before hooks or VM work.
    const f = await fixture(
      JSON.stringify({
        services: {
          web: {
            image: `sha256:${"e".repeat(64)}`,
            volumes: ["./src:/app/src"],
          },
        },
      })
    );
    await scriptUpThroughReview(f);
    await f.reply(
      "project source-size",
      nativeSourceSizeReceipt({ totalBytes: 600 * 1024 * 1024 })
    );
    const foreground = await cli({ fixture: f, args: ["up"], env: SHARED });
    const line = foreground.output
      .split("\n")
      .find((text) => text.includes("E_NATIVE_PROJECT_UNSUPPORTED"));
    expect(line).toBeDefined();
    expect(foreground.output).toContain("assets/video/intro.bin");
    const detached = await cli({
      fixture: f,
      args: ["up", "--detach", "--json"],
      env: SHARED,
    });
    expect(detached.code).toBe(1);
    const envelope = JSON.parse(detached.stdout);
    expect(envelope.error.code).toBe("E_NATIVE_PROJECT_UNSUPPORTED");
    expect(line).toContain(envelope.error.message.split("\n")[0]);
    expect(envelope.error.message).toContain("assets/video/intro.bin");
    expect(await f.calls()).not.toContain("runtime up");
  },
  SPAWN_TIMEOUT_MS * 2
);

test(
  "HACK-2339: a closed pre-VM refusal without a code reaches a detached up as the foreground prints it",
  async () => {
    const f = await fixture();
    await scriptUpThroughReview(f);
    // `up` refuses before hooks or VM work without its bundled relay artifact.
    await unlink(join(f.binary, "..", "hack-relay-guest"));
    const message =
      "Native foreground up requires the bundled hack-relay-guest artifact.";
    await expectSameRefusalDetachedAndForeground({
      f,
      line: message,
      code: "E_UNEXPECTED",
      message,
    });
  },
  SPAWN_TIMEOUT_MS * 2
);

test(
  "down --recover on a stopped pool under a dead owner starts it, recovers with data retained and says it is still running",
  async () => {
    const f = await fixture();
    await savedRun(f);
    await (
      await beginNativeProjectFinalization({ scope: f.scope, run })
    ).complete();
    // No graph-inspect reply: the stub reports runtime_not_running until
    // `runtime up` installs the ready graph.
    await f.reply("graph foreground-owner", {
      version: 1,
      run: run.run,
      owner: run.owner,
      phase: "ready-observed",
      receipt_sha256: "7".repeat(64),
      foreground: "exited",
      live_owner_recovery: null,
      dead_owner_recovery: "8".repeat(64),
    });
    await f.reply("runtime up", { phase: "running" });
    await f.finishOn("runtime up", {
      ...stoppedGraph,
      receipt: { ...stoppedGraph.receipt, phase: "ready-observed" },
      observations: { "container:web": { state: "running" } },
    });
    await f.reply("graph recover-cleanup", {
      run: run.run,
      recovered: true,
      data_retained: true,
    });
    await f.finishOn("graph recover-cleanup", stoppedGraph);
    await f.reply("graph retire-recovered-publisher", {
      run: run.run,
      publisher_retired: true,
      data_retained: true,
    });
    const result = await cli({ fixture: f, args: ["down", "--recover"] });
    expect(result.code).toBe(0);
    expect(result.output).toMatch(
      /✓ services {2}stopped · data retained · \d+\.\ds/
    );
    expect(result.output).toContain(
      "The native runtime was started to recover this run and is still running; run `runtime down` to stop it."
    );
    const calls = await f.calls();
    expect(calls.filter((call) => call === "runtime up")).toHaveLength(1);
    expect(calls.indexOf("runtime up")).toBeLessThan(
      calls.indexOf("graph recover-cleanup")
    );
    expect(calls.indexOf("graph recover-cleanup")).toBeLessThan(
      calls.indexOf("graph retire-recovered-publisher")
    );
    expect(calls).not.toContain("graph cleanup");
  },
  SPAWN_TIMEOUT_MS
);

test(
  "up on a stopped pool under a dead owner runs down --recover once, then retries its retained start",
  async () => {
    const f = await fixture();
    await savedRun(f);
    await (
      await beginNativeProjectFinalization({ scope: f.scope, run })
    ).complete();
    // The stub keeps refusing the preflight, so the retried start refuses too;
    // this proves the CLI wiring and that recovery runs once.
    await f.fail("graph retained-preflight", {
      code: "graph_foreground_owner_exited",
      message: "The run's foreground owner exited.",
    });
    await f.reply("runtime status", { phase: "stopped", process_alive: false });
    await f.reply("graph foreground-owner", {
      version: 1,
      run: run.run,
      owner: run.owner,
      phase: "ready-observed",
      receipt_sha256: "7".repeat(64),
      foreground: "exited",
      live_owner_recovery: null,
      dead_owner_recovery: "8".repeat(64),
    });
    await f.reply("runtime up", { phase: "running" });
    await f.finishOn("runtime up", {
      ...stoppedGraph,
      receipt: { ...stoppedGraph.receipt, phase: "ready-observed" },
      observations: { "container:web": { state: "running" } },
    });
    await f.reply("graph recover-cleanup", {
      run: run.run,
      recovered: true,
      data_retained: true,
    });
    await f.finishOn("graph recover-cleanup", stoppedGraph);
    await f.reply("graph retire-recovered-publisher", {
      run: run.run,
      publisher_retired: true,
      data_retained: true,
    });
    const result = await cli({ fixture: f, args: ["up"], env: SHARED });
    expect(result.code).toBe(1);
    expect(result.output).toContain("graph_foreground_owner_exited");
    const calls = await f.calls();
    expect(calls.slice(0, 5)).toEqual([
      "graph retained-preflight",
      "runtime status",
      "graph inspect",
      "graph foreground-owner",
      "runtime up",
    ]);
    expect(calls.filter((call) => call === "runtime up")).toHaveLength(1);
    expect(calls).toContain("graph recover-cleanup");
    expect(calls.indexOf("graph retire-recovered-publisher")).toBeLessThan(
      calls.lastIndexOf("graph retained-preflight")
    );
    expect(
      calls.filter((call) => call === "graph retained-preflight")
    ).toHaveLength(2);
  },
  SPAWN_TIMEOUT_MS
);
