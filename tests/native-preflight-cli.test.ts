import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { NativePreflightReport } from "../src/backends/native-preflight.ts";
import { nativeSourceSizeReceipt } from "./helpers/native-source-size.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * `hack doctor --native-preflight` through the source CLI.
 *
 * `hack up` under native selection checks a Compose project in two places, the
 * CLI's own admission and the runtime review, and stops at the first refusal
 * of each. The preflight lists every finding from both at once. The runtime
 * here is a stub that answers `project plan` from a scripted reply, so no VM,
 * Docker engine or real runtime is involved.
 */

const roots: string[] = [];
const entrypoint = resolve("index.ts");
const SPAWN_TIMEOUT_MS = 60_000;
const IMAGE = `sha256:${"e".repeat(64)}`;
/** Appears only in authored values; it must never reach any output. */
const PRIVATE = "synthetic-private-sentinel";

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(compose: Record<string, unknown>) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-preflight-cli-"))
  );
  roots.push(root);
  const project = join(root, "project");
  const projectDir = join(project, ".hack");
  const nativeHome = join(root, "native-home");
  const stub = join(root, "stub");
  await mkdir(projectDir, { recursive: true });
  await mkdir(nativeHome, { mode: 0o700 });
  await mkdir(stub);
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    JSON.stringify(compose)
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({ name: "preflight-fixture" })
  );
  // Native `up` requires the bundled relay artifact next to the runtime binary.
  await writeFile(join(root, "hack-relay-guest"), "synthetic relay");
  const binary = join(root, "native-runtime");
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
  const write = async (name: string, value: unknown) =>
    await writeFile(join(stub, name), JSON.stringify(value));
  return {
    root,
    project,
    projectDir,
    /** Script one stub reply file, for example `runtime-up.out`. */
    reply: write,
    /** Script the runtime review's reply. */
    review: async (diagnostics: unknown[]) =>
      await write("project-plan.out", {
        plan_id: "f".repeat(64),
        plan: {
          enrollment_compatible: !diagnostics.some(
            (entry) =>
              typeof entry === "object" &&
              entry !== null &&
              "severity" in entry &&
              entry.severity === "error"
          ),
          services: {},
          diagnostics,
        },
      }),
    /** Make the runtime review stop with one closed code. */
    reviewStops: async (code: string) =>
      await write("project-plan.err", { code }),
    calls: async () =>
      (await readFile(join(stub, "calls"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((line) => line.split(" ").slice(2, 4).join(" ")),
    native: {
      HACK_RUNTIME_BACKEND: "native",
      HACK_NATIVE_BINARY: binary,
      HACK_NATIVE_HOME: nativeHome,
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function cli(
  f: Fixture,
  args: readonly string[],
  env: Record<string, string> = {}
) {
  const child = Bun.spawn(
    [process.execPath, entrypoint, "--path", f.project, ...args],
    {
      cwd: f.root,
      env: privateCliEnv({
        root: f.root,
        env: { HACK_NO_INTERACTIVE: "1", HACK_LOGGER: "console", ...env },
      }),
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

async function preflight(f: Fixture, env: Record<string, string> = {}) {
  const result = await cli(f, ["doctor", "--native-preflight", "--json"], env);
  const parsed = JSON.parse(result.stdout) as {
    ok: boolean;
    data: NativePreflightReport;
  };
  expect(parsed.ok).toBe(true);
  return { ...result, report: parsed.data };
}

function codes(report: NativePreflightReport, gate: "cli" | "runtime") {
  return report.blockers
    .filter((found) => found.gate === gate)
    .map((found) => `${found.code}${found.service ? `:${found.service}` : ""}`)
    .sort();
}

const GRANT = { HACK_NATIVE_SHARED_SOURCE: "1" };

/** Replies that carry native `up` past its source checks to service admission. */
async function scriptSourceShare(f: Fixture): Promise<void> {
  await f.reply("runtime-check-project-share.out", {
    source_admitted: true,
    pool_initialized: true,
  });
  await f.reply("project-source-size.out", nativeSourceSizeReceipt());
}

/** One project with a problem at every CLI check and several review findings. */
const MANY_PROBLEMS = {
  services: {
    api: {
      image: IMAGE,
      env_file: ".env",
      labels: { "traefik.enable": PRIVATE },
      environment: { TOKEN: PRIVATE },
    },
    db: { image: IMAGE, logging: { driver: "syslog" }, networks: ["shared"] },
    jobs: { env_file: [".env"], restart: { policy: PRIVATE } },
    web: { build: { context: "." }, extra_hosts: [`${PRIVATE}:host-gateway`] },
  },
  networks: { shared: { external: true } },
};

test(
  "one run lists every blocker from the CLI's checks and the runtime review, with stable codes",
  async () => {
    const f = await fixture(MANY_PROBLEMS);
    await writeFile(join(f.project, ".env"), `TOKEN=${PRIVATE}\n`);
    await f.review([
      {
        severity: "error",
        code: "privileged_service",
        field: "services.api.privileged",
        message: `runtime text ${PRIVATE}`,
      },
      {
        severity: "error",
        code: "some_future_code",
        field: "services.db.shm_size",
        message: "runtime text",
      },
      // Reported by the CLI already for this service: listed once.
      {
        severity: "error",
        code: "external_network",
        field: "networks.shared",
        message: "runtime text",
      },
      {
        severity: "warning",
        code: "proposed_loopback_binding",
        field: "services.api.ports",
        message: "runtime text",
      },
      // Malformed entries are dropped, never echoed.
      { severity: "error", code: `Bad Code ${PRIVATE}`, field: "x" },
      { severity: "fatal", code: "ignored_severity", field: "x" },
      null,
    ]);
    const { report, code, output } = await preflight(f, f.native);
    expect(code).toBe(1);
    expect(report.report_version).toBe(1);
    expect(report.backend).toBe("native");
    expect(report.compose_file).toBe(".hack/docker-compose.yml");
    expect(report.ready).toBe(false);
    expect(report.runtime_review).toEqual({ status: "completed" });
    expect(codes(report, "cli")).toEqual([
      "build_requires_opt_in:web",
      "dotenv_without_managed_env",
      "env_file:api",
      "env_file:jobs",
      "external_network",
      "extra_hosts_without_dependencies:web",
      "invalid_restart:jobs",
      "missing_image:jobs",
      "shared_source_grant_required",
      "unsupported_label:api",
      "unsupported_logging:db",
    ]);
    expect(codes(report, "runtime")).toEqual([
      "privileged_service:api",
      "some_future_code:db",
    ]);
    expect(report.warnings.map((found) => found.code)).toEqual([
      "proposed_loopback_binding",
    ]);
    // Every finding says what is wrong and what to do, in fixed words.
    for (const found of [...report.blockers, ...report.warnings]) {
      expect(found.message.length).toBeGreaterThan(10);
      expect(found.fix.length).toBeGreaterThan(5);
    }
    const unknown = report.blockers.find(
      (found) => found.code === "some_future_code"
    );
    expect(unknown).toMatchObject({
      service: "db",
      field: "services.db.shm_size",
      message: "The native review reported some_future_code.",
    });
    // Authored values and the runtime's own text never reach the output.
    expect(output).not.toContain(PRIVATE);
    expect(output).not.toContain("runtime text");
    // The only runtime request is the review: nothing is started.
    expect(await f.calls()).toEqual(["project plan"]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "a project with nothing to fix is ready, exits 0, and reports notes separately",
  async () => {
    const f = await fixture({ services: { web: { image: IMAGE } } });
    await f.review([
      {
        severity: "warning",
        code: "terminal_not_allocated",
        field: "services.web.tty",
        message: "runtime text",
      },
    ]);
    const json = await preflight(f, { ...f.native, ...GRANT });
    expect(json.code).toBe(0);
    expect(json.report).toMatchObject({
      ready: true,
      blockers: [],
      runtime_review: { status: "completed" },
    });
    expect(json.report.warnings).toEqual([
      {
        severity: "warning",
        gate: "runtime",
        code: "terminal_not_allocated",
        service: "web",
        field: "services.web.tty",
        message: "tty: true gets no terminal on native.",
        fix: "A program that needs a real terminal must run on the Compose backend.",
      },
    ]);
    const human = await cli(f, ["doctor", "--native-preflight"], {
      ...f.native,
      ...GRANT,
    });
    expect(human.code).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toBe(
      [
        "Native preflight for .hack/docker-compose.yml",
        "Runtime review: completed.",
        "",
        "No blockers. Native up should admit this project.",
        "",
        "1 note: native starts, with these differences from Compose.",
        "- tty: true gets no terminal on native. (service web, services.web.tty) [terminal_not_allocated]",
        "  Fix: A program that needs a real terminal must run on the Compose backend.",
        "",
      ].join("\n")
    );
  },
  SPAWN_TIMEOUT_MS
);

test(
  "without a native runtime the CLI's checks still run and the report says the review was skipped",
  async () => {
    const f = await fixture({
      services: { web: { image: IMAGE, env_file: ".env" } },
    });
    const { report, code } = await preflight(f, GRANT);
    expect(code).toBe(1);
    expect(report.runtime_review).toEqual({ status: "skipped" });
    expect(report.ready).toBe(false);
    expect(codes(report, "cli")).toEqual(["env_file:web"]);
    expect(await f.calls()).toEqual([]);
    // No blocker is still not "ready" when half the checks did not run.
    const clean = await fixture({ services: { web: { image: IMAGE } } });
    const skipped = await preflight(clean, GRANT);
    expect(skipped.code).toBe(0);
    expect(skipped.report).toMatchObject({
      ready: false,
      blockers: [],
      runtime_review: { status: "skipped" },
    });
    const human = await cli(clean, ["doctor", "--native-preflight"], GRANT);
    expect(human.stdout).toContain(
      "Runtime review: skipped, because no native runtime is selected."
    );
    expect(human.stdout).toContain("No blockers found by the checks that ran.");
    // Native selected without a candidate degrades the same way.
    const incomplete = await preflight(clean, {
      ...GRANT,
      HACK_RUNTIME_BACKEND: "native",
    });
    expect(incomplete.report.runtime_review).toEqual({ status: "skipped" });
  },
  SPAWN_TIMEOUT_MS
);

test(
  "a review that stops early is reported as a blocker, and one that fails is reported as unavailable",
  async () => {
    const stopped = await fixture({ services: { web: { image: IMAGE } } });
    await stopped.reviewStops("invalid_mount");
    const first = await preflight(stopped, { ...stopped.native, ...GRANT });
    expect(first.code).toBe(1);
    expect(first.report.runtime_review).toEqual({
      status: "stopped",
      code: "invalid_mount",
    });
    expect(first.report.blockers).toHaveLength(1);
    expect(first.report.blockers[0]).toMatchObject({
      gate: "runtime",
      code: "invalid_mount",
    });
    expect(first.report.blockers[0]?.message).toContain("Anonymous volumes");
    expect(first.report.blockers[0]?.fix).toContain(
      "run the preflight again after fixing it"
    );
    // The stub's default reply is a transport-level failure, not a review verdict.
    const down = await fixture({ services: { web: { image: IMAGE } } });
    const second = await preflight(down, { ...down.native, ...GRANT });
    expect(second.code).toBe(0);
    expect(second.report).toMatchObject({
      ready: false,
      blockers: [],
      runtime_review: { status: "unavailable", code: "runtime_not_running" },
    });
  },
  SPAWN_TIMEOUT_MS
);

test(
  "preflight agrees with native up: each CLI blocker is a refusal, and a clean project passes the gate",
  async () => {
    for (const [service, extra, expected] of [
      [{ image: IMAGE, env_file: ".env" }, {}, "env_file:web"],
      [
        { image: IMAGE, logging: { driver: "syslog" } },
        {},
        "unsupported_logging:web",
      ],
      [
        { image: IMAGE, labels: { "traefik.enable": "true" } },
        {},
        "unsupported_label:web",
      ],
      [{ image: IMAGE, restart: 1 }, {}, "invalid_restart:web"],
      [
        { image: IMAGE, extra_hosts: ["a:host-gateway"] },
        {},
        "extra_hosts_without_dependencies:web",
      ],
      [{ build: ".." }, {}, "build_requires_opt_in:web"],
      [{ command: ["true"] }, {}, "missing_image:web"],
      [
        { image: IMAGE, networks: ["shared"] },
        { networks: { shared: { external: true } } },
        "external_network",
      ],
    ] as const) {
      const f = await fixture({ services: { web: service }, ...extra });
      const env = { ...f.native, ...GRANT };
      const { report } = await preflight(f, env);
      expect(codes(report, "cli")).toEqual([expected]);
      await scriptSourceShare(f);
      const up = await cli(f, ["up"], env);
      expect(up.code).toBe(1);
      // Refused by the CLI's own admission, not by the stub runtime, and
      // before the runtime was started.
      expect(up.output).toContain("ERROR: E_NATIVE_PROJECT_UNSUPPORTED:");
      expect(up.output).not.toContain("runtime_not_running");
      expect(await f.calls()).not.toContain("runtime up");
    }
    // Without the grant, both name the grant.
    const ungranted = await fixture({ services: { web: { image: IMAGE } } });
    const report = (await preflight(ungranted, ungranted.native)).report;
    expect(codes(report, "cli")).toEqual(["shared_source_grant_required"]);
    const refused = await cli(ungranted, ["up"], ungranted.native);
    expect(refused.output).toContain("E_PERMISSION");
    // A clean project has no CLI blocker and native up goes on to the runtime.
    const clean = await fixture({ services: { web: { image: IMAGE } } });
    const env = { ...clean.native, ...GRANT };
    expect(codes((await preflight(clean, env)).report, "cli")).toEqual([]);
    await scriptSourceShare(clean);
    const started = await cli(clean, ["up"], env);
    expect(started.output).not.toContain("E_NATIVE_PROJECT_UNSUPPORTED");
    expect(started.output).not.toContain("E_PERMISSION");
    expect(await clean.calls()).toContain("runtime up");
  },
  SPAWN_TIMEOUT_MS * 3
);

test(
  "the general native up refusal points at the preflight",
  async () => {
    const f = await fixture({
      services: { web: { image: IMAGE, logging: { driver: "syslog" } } },
    });
    await scriptSourceShare(f);
    const up = await cli(f, ["up"], { ...f.native, ...GRANT });
    expect(up.code).toBe(1);
    expect(up.output).toContain(
      "Run `hack doctor --native-preflight` to list every blocker with its fix."
    );
    expect(await f.calls()).toEqual(["runtime check-project-share"]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "preflight is its own mode: other doctor options and a missing project refuse",
  async () => {
    const f = await fixture({ services: { web: { image: IMAGE } } });
    const mixed = await cli(f, ["doctor", "--native-preflight", "--fix"]);
    expect(mixed.code).toBe(1);
    expect(mixed.output).toContain(
      "--native-preflight accepts only --path and --json"
    );
    const outside = join(f.root, "outside");
    await mkdir(outside);
    const child = Bun.spawn(
      [process.execPath, entrypoint, "doctor", "--native-preflight"],
      {
        cwd: outside,
        env: privateCliEnv({ root: f.root, env: { HACK_LOGGER: "console" } }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stderr, code] = await Promise.all([
      new Response(child.stderr).text(),
      child.exited,
      new Response(child.stdout).text(),
    ]);
    expect(code).toBe(1);
    expect(stderr).toContain("Native preflight checks one project.");
  },
  SPAWN_TIMEOUT_MS
);
