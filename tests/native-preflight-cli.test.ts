import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
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
const NAMESPACE = "c".repeat(64);

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
reply="$3-$4"
# The second review names the adapted document: keep a copy and, when the
# test scripted one, answer it separately from the review of the original.
previous=""
for argument in "$@"; do
  if [ "$previous" = "--normalized-file" ]; then
    cp "$argument" '${stub}/normalized.json'
    if [ -f '${stub}/'"$reply"'-normalized.out' ]; then reply="$reply-normalized"; fi
  fi
  previous="$argument"
done
if [ -f '${stub}/'"$reply"'.out' ]; then cat '${stub}/'"$reply"'.out'; exit 0; fi
if [ -f '${stub}/'"$reply"'.err' ]; then cat '${stub}/'"$reply"'.err' >&2; exit 1; fi
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
    review: async (
      diagnostics: unknown[],
      plan: Record<string, unknown> = {},
      /** `"normalized"` scripts only the review of the adapted document. */
      which: "both" | "normalized" = "both",
      startRefusals: unknown = []
    ) =>
      await write(
        which === "both" ? "project-plan.out" : "project-plan-normalized.out",
        {
          plan_id: "f".repeat(64),
          start_refusals: startRefusals,
          plan: {
            namespace: NAMESPACE,
            compose_sha256: createHash("sha256")
              .update(JSON.stringify(compose))
              .digest("hex"),
            services: {},
            ...plan,
            enrollment_compatible: !diagnostics.some(
              (entry) =>
                typeof entry === "object" &&
                entry !== null &&
                "severity" in entry &&
                entry.severity === "error"
            ),
            diagnostics,
          },
        }
      ),
    /** Make the runtime review stop with one closed code. */
    reviewStops: async (code: string) =>
      await write("project-plan.err", { code }),
    /** The adapted document the runtime was last asked to review. */
    normalized: async () =>
      JSON.parse(await readFile(join(stub, "normalized.json"), "utf8")) as {
        networks?: Record<string, Record<string, unknown>>;
      },
    /** Every stub invocation's full argument line. */
    argv: async () =>
      (await readFile(join(stub, "calls"), "utf8").catch(() => ""))
        .split("\n")
        .filter(Boolean),
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
  env: Record<string, string> = {},
  timeoutMs = SPAWN_TIMEOUT_MS - 5000
) {
  const child = Bun.spawn(
    [process.execPath, entrypoint, "--path", f.project, ...args],
    {
      cwd: f.root,
      env: privateCliEnv({
        root: f.root,
        env: {
          HACK_NO_INTERACTIVE: "1",
          HACK_LOGGER: "console",
          XDG_CONFIG_HOME: join(f.root, "user-home", ".config"),
          XDG_STATE_HOME: join(f.root, "xdg-state"),
          XDG_CACHE_HOME: join(f.root, "xdg-cache"),
          XDG_DATA_HOME: join(f.root, "xdg-data"),
          ...env,
        },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: timeoutMs,
    }
  );
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code, output: stdout + stderr };
}

async function preflight(
  f: Fixture,
  env: Record<string, string> = {},
  extra: readonly string[] = []
) {
  const result = await cli(
    f,
    ["doctor", "--native-preflight", "--json", ...extra],
    env
  );
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

test(
  "an unreportable service name retains the foreign-platform refusal",
  async () => {
    const f = await fixture({
      services: {
        ["s".repeat(129)]: { image: IMAGE, platform: "linux/amd64" },
      },
    });
    await f.review([]);
    const { report, code } = await preflight(f, { ...f.native, ...GRANT });
    expect(code).toBe(1);
    expect(report.ready).toBe(false);
    expect(
      report.blockers.some(
        (item) => item.code === "foreign_platform" && item.service === undefined
      )
    ).toBe(true);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "consent never hides per-service configuration findings in text or JSON",
  async () => {
    const f = await fixture({
      services: {
        api: { image: IMAGE, environment: { PRIVATE } },
        worker: { image: IMAGE },
      },
    });
    const detail = (service: string, field: string) => ({
      text_fixed: true,
      service,
      field,
      message: "This service configuration is not supported.",
      fix: "Remove this field or use a supported declaration.",
      value: PRIVATE,
    });
    await f.review(
      [
        {
          severity: "error",
          code: "privileged_service",
          field: "services.api",
          message: PRIVATE,
        },
      ],
      {},
      "both",
      [
        {
          code: "graph_incompatible",
          message_fixed: true,
          message: "The reviewed graph contains blocking diagnostics.",
        },
        {
          code: "graph_subset",
          configuration_refusals: [
            detail("api", "labels"),
            detail("worker", "platform"),
          ],
        },
        {
          code: "graph_route_binding",
          configuration_refusals: [detail("api", "healthcheck.x-hack-http")],
        },
      ]
    );
    const ungranted = await preflight(f, f.native);
    const granted = await preflight(f, { ...f.native, ...GRANT });
    expect(ungranted.code).toBe(1);
    expect(ungranted.report.blockers).toEqual(granted.report.blockers);
    expect(ungranted.report.consent_needed.map((item) => item.code)).toEqual([
      "shared_source_grant_required",
    ]);
    expect(granted.report.consent_needed).toEqual([]);
    expect(
      ungranted.report.blockers.map((item) => [
        item.code,
        item.service,
        item.field,
      ])
    ).toEqual([
      ["privileged_service", "api", "services.api.privileged"],
      ["graph_subset", "api", "labels"],
      ["graph_subset", "worker", "platform"],
      ["graph_route_binding", "api", "healthcheck.x-hack-http"],
    ]);
    const text = await cli(f, ["doctor", "--native-preflight"], f.native);
    expect(text.output).toContain("Consent needed before native start:");
    expect(text.output).toContain("4 blockers:");
    expect(text.output).toContain("healthcheck.x-hack-http");
    expect(text.output + ungranted.output + granted.output).not.toContain(
      PRIVATE
    );
    expect(
      (await f.calls()).every((line) => line.includes("project plan"))
    ).toBe(true);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "cache review errors carry every service and field across the error pipe",
  async () => {
    const services = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [`s${index}`, { image: IMAGE }])
    );
    const f = await fixture({ services });
    const configuration_refusals = Object.keys(services).flatMap((service) =>
      [
        "labels.hack.dependencies.lockfiles",
        "labels.hack.dependencies.runtime-files",
      ].map((field) => ({
        text_fixed: true,
        service,
        field,
        message:
          "The dependency-cache file list is not a bounded list of relative paths.",
        fix: "Use relative paths without interpolation or parent components.",
      }))
    );
    await f.reply("project-plan.err", {
      code: "invalid_dependency_cache",
      message: PRIVATE,
      configuration_refusals,
    });
    const { report, output } = await preflight(f, f.native);
    expect(report.runtime_review).toEqual({
      status: "stopped",
      code: "invalid_dependency_cache",
    });
    expect(report.blockers).toHaveLength(128);
    expect(new Set(report.blockers.map((item) => item.service)).size).toBe(64);
    expect(report.consent_needed).toHaveLength(1);
    expect(output).not.toContain(PRIVATE);
    await f.reply("project-plan.err", {
      code: "invalid_dependency_cache",
      configuration_refusals: [
        { ...configuration_refusals[0], text_fixed: false, message: PRIVATE },
      ],
    });
    const malformed = await preflight(f, f.native);
    expect(malformed.report.blockers).toHaveLength(1);
    expect(malformed.output).not.toContain(PRIVATE);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "foreign platform findings name all offending services without platform values",
  async () => {
    const f = await fixture({
      services: {
        api: { image: IMAGE, platform: `linux/${PRIVATE}` },
        worker: { image: IMAGE, platform: "linux/amd64" },
        native: { image: IMAGE, platform: "linux/arm64" },
      },
    });
    await f.review([]);
    const { report, output } = await preflight(f, { ...f.native, ...GRANT });
    expect(
      report.blockers
        .filter((item) => item.code === "foreign_platform")
        .map((item) => [item.service, item.field])
    ).toEqual([
      ["api", "platform"],
      ["worker", "platform"],
    ]);
    expect(output).not.toContain(PRIVATE);
  },
  SPAWN_TIMEOUT_MS
);

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
    expect(report.report_version).toBe(2);
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
    // The only runtime requests are the two reviews: nothing is started.
    expect(await f.calls()).toEqual(["project plan", "project plan"]);
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
    // Native selected without a candidate is named as that, not as "not selected".
    const incompleteEnv = { ...GRANT, HACK_RUNTIME_BACKEND: "native" };
    const incomplete = await preflight(clean, incompleteEnv);
    expect(incomplete.report.runtime_review).toEqual({
      status: "skipped",
      code: "native_selection_incomplete",
    });
    expect(
      (await cli(clean, ["doctor", "--native-preflight"], incompleteEnv)).stdout
    ).toContain("native is selected without a candidate");
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
    // Malformed routing label values pass the CLI's key check; the review
    // stops on them, and that is a project blocker, not a missing runtime.
    const labels = await fixture({ services: { web: { image: IMAGE } } });
    await labels.reviewStops("invalid_routing_labels");
    const routing = await preflight(labels, { ...labels.native, ...GRANT });
    expect(routing.code).toBe(1);
    expect(routing.report.runtime_review).toEqual({
      status: "stopped",
      code: "invalid_routing_labels",
    });
    expect(codes(routing.report, "runtime")).toEqual([
      "invalid_routing_labels",
    ]);
    // So is a project file the review reads for a dependency cache.
    const registry = await fixture({ services: { web: { image: IMAGE } } });
    await registry.reviewStops("registry_template_invalid");
    const refused = await preflight(registry, { ...registry.native, ...GRANT });
    expect(refused.code).toBe(1);
    expect(codes(refused.report, "runtime")).toEqual([
      "registry_template_invalid",
    ]);
    // A failure of the runtime itself is not a verdict on the project. That
    // covers the stub's default "not running" and any code this version does
    // not know as a project problem.
    for (const code of [null, "source_changed", "serialization_failed"]) {
      const down = await fixture({ services: { web: { image: IMAGE } } });
      if (code) {
        await down.reviewStops(code);
      }
      const result = await preflight(down, { ...down.native, ...GRANT });
      expect(result.code).toBe(0);
      expect(result.report).toMatchObject({
        ready: false,
        blockers: [],
        runtime_review: {
          status: "unavailable",
          code: code ?? "runtime_not_running",
        },
      });
    }
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
    expect(codes(report, "cli")).toEqual([]);
    expect(report.consent_needed.map((item) => item.code)).toEqual([
      "shared_source_grant_required",
    ]);
    const refused = await cli(ungranted, ["up"], ungranted.native);
    expect(refused.output).toContain("E_PERMISSION");
    // A clean project has no CLI blocker and native up goes on to the runtime.
    const clean = await fixture({ services: { web: { image: IMAGE } } });
    await clean.review([], { services: { web: { active: true } } });
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
      "--native-preflight accepts only --path, --profile and --json"
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

test(
  "the review covers what native up reviews: the adapted document, with the selected profiles",
  async () => {
    const f = await fixture({
      services: { web: { image: IMAGE, networks: ["shared"] } },
      networks: { shared: { external: true } },
    });
    await mkdir(join(f.projectDir, "native"));
    await writeFile(
      join(f.projectDir, "native", "adaptation.json"),
      JSON.stringify({ version: 1, isolatedNetworks: ["shared"] })
    );
    // The original file still has the external network; only the adapted
    // document does not. The findings must come from the second review.
    await f.review([
      {
        severity: "error",
        code: "external_network",
        field: "networks.shared",
        message: "runtime text",
      },
    ]);
    await f.review(
      [
        {
          severity: "warning",
          code: "isolated_network_replacement",
          field: "networks.shared",
          message: "runtime text",
        },
      ],
      {},
      "normalized"
    );
    const { report, code } = await preflight(f, { ...f.native, ...GRANT }, [
      "--profile",
      "dev, ops,dev",
    ]);
    // The adaptation isolates the network, so it is not a blocker at either gate.
    expect(code).toBe(0);
    expect(report).toMatchObject({ ready: true, blockers: [] });
    expect(report.warnings.map((found) => found.code)).toEqual([
      "isolated_network_replacement",
    ]);
    // The reviewed document carries the adaptation.
    expect((await f.normalized()).networks?.shared).toMatchObject({
      "x-hack-isolated": true,
    });
    const [original, normalized] = await f.argv();
    expect(original).toContain("project plan --project ");
    expect(original).toContain("--profile dev --profile ops --json");
    expect(original).not.toContain("--normalized-file");
    // The second review is of the adapted document, bound to the original file.
    const sha = createHash("sha256")
      .update(await readFile(join(f.projectDir, "docker-compose.yml")))
      .digest("hex");
    expect(normalized).toContain("--normalized-file ");
    expect(normalized).toContain(`--expect-original ${sha}`);
    expect(normalized).toContain(`--expect-namespace ${NAMESPACE}`);
    expect(normalized).toContain("--profile dev --profile ops");
    // The private review directory is gone afterwards.
    const reviewed = normalized?.split("--normalized-file ")[1]?.split(" ")[0];
    expect(reviewed).toBeDefined();
    expect(await Bun.file(reviewed ?? "").exists()).toBe(false);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "an invalid adaptation, project configuration or native setting is a blocker of its own",
  async () => {
    const adaptation = await fixture({ services: { web: { image: IMAGE } } });
    await mkdir(join(adaptation.projectDir, "native"));
    await writeFile(
      join(adaptation.projectDir, "native", "adaptation.json"),
      JSON.stringify({ version: 1, httpProbes: { missing: {} } })
    );
    await adaptation.review([
      { severity: "error", code: "privileged_service", field: "services.web" },
    ]);
    const invalidAdaptation = await preflight(adaptation, {
      ...adaptation.native,
      ...GRANT,
    });
    expect(codes(invalidAdaptation.report, "cli")).toEqual([
      "native_adaptation_invalid",
    ]);
    // The unadapted document is not reviewed: its findings would mislead.
    expect(invalidAdaptation.report.runtime_review).toEqual({
      status: "skipped",
      code: "native_adaptation_invalid",
    });
    expect(codes(invalidAdaptation.report, "runtime")).toEqual([]);
    expect(await adaptation.calls()).toEqual([]);

    const config = await fixture({ services: { web: { image: IMAGE } } });
    await writeFile(join(config.projectDir, "hack.config.json"), "{ not json");
    expect(codes((await preflight(config, GRANT)).report, "cli")).toEqual([
      "project_config_invalid",
    ]);

    const settings = await fixture({ services: { web: { image: IMAGE } } });
    const invalid = await preflight(settings, {
      HACK_NATIVE_AWS_PROFILE: "not a profile!",
    });
    // Unreadable settings do not also ask for the source-share grant.
    expect(codes(invalid.report, "cli")).toEqual(["native_settings_invalid"]);

    const unreadable = await fixture({ services: { web: { image: IMAGE } } });
    await writeFile(
      join(unreadable.projectDir, "docker-compose.yml"),
      "services: [unclosed"
    );
    expect(codes((await preflight(unreadable, GRANT)).report, "cli")).toEqual([
      "compose_file_unreadable",
    ]);
  },
  SPAWN_TIMEOUT_MS * 2
);

test(
  "route preflight gives a separate cause and remedy for each refused probe",
  async () => {
    const probe = {
      port: 3000,
      path: "/health",
      interval_ms: 1000,
      timeout_ms: 1000,
      retries: 3,
      start_period_ms: 0,
    };
    for (const entry of [
      {
        authored: { disable: true },
        reviewed: { healthcheck: { disabled: true } },
        message: "explicitly disables",
        fix: "Replace the disabled healthcheck",
      },
      {
        authored: { test: ["CMD", "true"] },
        reviewed: { healthcheck: { test: ["CMD", "true"] } },
        message: "command-only healthcheck",
        fix: "Replace the command healthcheck",
      },
      {
        authored: { "x-hack-http": probe },
        reviewed: { healthcheck: { native_http: probe }, dependency_cache: {} },
        message: "also declares a dependency cache",
        fix: "Move the dependency cache",
      },
      {
        authored: { "x-hack-http": probe },
        reviewed: { healthcheck: { native_http: { ...probe, port: 3001 } } },
        message: "no valid reviewed HTTP probe matching",
        fix: "Check the route port",
      },
    ]) {
      const project = await fixture({
        services: {
          web: {
            image: IMAGE,
            labels: {
              caddy: "web.example.test",
              "caddy.reverse_proxy": "{{upstreams 3000}}",
              "caddy.tls": "internal",
            },
            healthcheck: entry.authored,
          },
        },
      });
      await project.review([], {
        services: {
          web: { active: true, routing: { port: 3000 }, ...entry.reviewed },
        },
      });
      const result = await preflight(project, { ...project.native, ...GRANT });
      expect(result.code).toBe(1);
      const found = result.report.blockers.find(
        (f) => f.code === "route_probe_required"
      );
      expect(found?.service).toBe("web");
      expect(found?.message).toContain(entry.message);
      expect(found?.fix).toContain(entry.fix);
    }
  },
  SPAWN_TIMEOUT_MS * 2
);

test(
  "route admission, project-wide hosts and per-environment dependency files are checked as native up checks them",
  async () => {
    // A route missing its reviewed probe still refuses; authored labels alone are insufficient.
    const routed = await fixture({
      services: {
        web: {
          image: IMAGE,
          labels: {
            caddy: "web.example.test",
            "caddy.reverse_proxy": "{{upstreams 3000}}",
          },
        },
      },
    });
    await routed.review(
      [
        {
          severity: "warning",
          code: "route_binding_required",
          field: "services.web.labels",
          message: "runtime text",
        },
      ],
      { services: { web: { active: true, routing: { port: 3000 } } } }
    );
    const route = await preflight(routed, { ...routed.native, ...GRANT });
    expect(route.code).toBe(1);
    expect(route.report.ready).toBe(false);
    expect(codes(route.report, "cli")).toEqual(["route_probe_required:web"]);
    await routed.review([], {
      services: {
        web: {
          active: true,
          routing: { port: 3000 },
          healthcheck: {
            disabled: false,
            native_http: {
              policy: "route",
              port: 3000,
              path: "/",
              interval_ms: 30_000,
              timeout_ms: 1000,
              retries: 3,
              start_period_ms: 240_000,
            },
          },
        },
      },
    });
    const inferred = await preflight(routed, { ...routed.native, ...GRANT });
    expect(codes(inferred.report, "cli")).toEqual([]);
    expect(inferred.code).toBe(0);
    expect(inferred.report.ready).toBe(true);

    // Routes plus published ports over the pool's bridge limit: native up
    // refuses before any runtime work, so no review is needed to see it.
    const crowded = await fixture({
      services: Object.fromEntries(
        Array.from({ length: 11 }, (_, index) => [
          `svc${index}`,
          {
            image: IMAGE,
            ports: [0, 1, 2].map((port) => `${4000 + index * 10 + port}:80`),
          },
        ])
      ),
    });
    expect(codes((await preflight(crowded, GRANT)).report, "cli")).toEqual([
      "too_many_bridges",
    ]);

    // Project-wide extra hosts with no dependency selection.
    const hosts = await fixture({ services: { web: { image: IMAGE } } });
    await writeFile(
      join(hosts.projectDir, "hack.config.json"),
      JSON.stringify({
        name: "preflight-fixture",
        internal: { extra_hosts: { "api.internal.test": "host-gateway" } },
      })
    );
    expect(codes((await preflight(hosts, GRANT)).report, "cli")).toEqual([
      "internal_hosts_without_dependencies",
    ]);

    // A dependency file for another environment only does not cover this one.
    const perEnv = await fixture({
      services: {
        web: { image: IMAGE, extra_hosts: ["db.test:host-gateway"] },
      },
    });
    const home = join(perEnv.root, "user-home");
    const directory = join(
      home,
      ".config",
      "hack",
      "native",
      "preflight-fixture"
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(join(home, ".config"), 0o700);
    await chmod(join(home, ".config", "hack"), 0o700);
    await chmod(join(home, ".config", "hack", "native"), 0o700);
    await writeFile(
      join(directory, "settings.json"),
      JSON.stringify({
        version: 1,
        projectRoots: [perEnv.project],
        sharedSource: true,
        // A sibling file name, selected for the `staging` env only.
        dependenciesByEnv: { staging: "dependencies.staging.json" },
      }),
      { mode: 0o600 }
    );
    const other = await preflight(perEnv);
    expect(codes(other.report, "cli")).toEqual([
      "extra_hosts_without_dependencies:web",
    ]);
  },
  SPAWN_TIMEOUT_MS * 2
);

test(
  "builds, probes and service names are judged per service, and a dotted service name is not truncated",
  async () => {
    const BUILDS = { ...GRANT, HACK_NATIVE_BUILDS: "1" };
    const f = await fixture({
      services: {
        api: { image: IMAGE },
        "api.v2": { image: IMAGE },
        built: { build: { context: "." } },
        remote: { build: { context: "https://example.test/repo.git" } },
        probed: {
          image: IMAGE,
          healthcheck: { "x-hack-http": { port: "not-a-port" } },
        },
        ".hidden": { image: IMAGE },
      },
    });
    await f.review([
      {
        severity: "error",
        code: "unsupported_field",
        field: "services.api.v2.shm_size",
        message: "runtime text",
      },
      {
        severity: "error",
        code: "unsupported_field",
        field: "services.api.shm_size",
        message: "runtime text",
      },
      {
        severity: "error",
        code: "unsupported_field",
        field: "services.undeclared.shm_size",
        message: "runtime text",
      },
    ]);
    const { report } = await preflight(f, { ...f.native, ...BUILDS });
    // With builds enabled an admitted build is no blocker and needs no image.
    expect(codes(report, "cli")).toEqual([
      "invalid_http_probe:probed",
      "invalid_service_name",
      "unsupported_build_form:remote",
    ]);
    expect(
      report.blockers
        .filter((found) => found.gate === "runtime")
        .map((found) => [found.service ?? null, found.field])
    ).toEqual([
      ["api.v2", "services.api.v2.shm_size"],
      ["api", "services.api.shm_size"],
      [null, "services.undeclared.shm_size"],
    ]);
    // Without the opt-in, the same admissible build needs it.
    const off = await preflight(f, { ...f.native, ...GRANT });
    expect(codes(off.report, "cli")).toContain("build_requires_opt_in:built");
    expect(codes(off.report, "cli")).not.toContain("missing_image:built");
  },
  SPAWN_TIMEOUT_MS
);

test(
  "a review that does not admit the project is never reported ready, even with no usable finding",
  async () => {
    const f = await fixture({ services: { web: { image: IMAGE } } });
    await f.review([{ severity: "error", code: "Not A Code", field: "x" }]);
    const { report, code } = await preflight(f, { ...f.native, ...GRANT });
    expect(code).toBe(1);
    expect(report.ready).toBe(false);
    expect(codes(report, "runtime")).toEqual(["review_incompatible"]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "a project with a native project file is told the preflight does not apply",
  async () => {
    const f = await fixture({ services: { web: { image: IMAGE } } });
    // Native project inputs only: no Compose file and no legacy configuration.
    await rm(join(f.projectDir, "docker-compose.yml"));
    await rm(join(f.projectDir, "hack.config.json"));
    await writeFile(
      join(f.projectDir, "hack.project.json"),
      JSON.stringify({ schema_version: 1, name: "authored" })
    );
    const result = await cli(f, ["doctor", "--native-preflight"]);
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "Native preflight covers Compose-file projects. This project has native project inputs"
    );
    expect(result.output).not.toMatch(/^\s+at /m);
    const compose = await fixture({ services: { web: { image: IMAGE } } });
    const profile = await cli(compose, ["doctor", "--profile", "dev"]);
    expect(profile.code).toBe(1);
    expect(profile.output).toContain(
      "--profile applies only to --native-preflight."
    );
  },
  SPAWN_TIMEOUT_MS
);

test(
  "a Compose path that is a FIFO, a link, empty or oversized is reported, never read unbounded",
  async () => {
    const replace = async (
      prepare: (path: string, f: Fixture) => Promise<void>
    ) => {
      const f = await fixture({ services: { web: { image: IMAGE } } });
      const path = join(f.projectDir, "docker-compose.yml");
      await rm(path);
      await prepare(path, f);
      const started = Date.now();
      const result = await cli(
        f,
        ["doctor", "--native-preflight", "--json"],
        GRANT,
        5000
      );
      // A blocking read of a FIFO with no writer would never return.
      expect(Date.now() - started).toBeLessThan(5000);
      expect(result.code).toBe(1);
      const { data: report } = JSON.parse(result.stdout) as {
        data: NativePreflightReport;
      };
      expect(codes(report, "cli")).toEqual(["compose_file_unreadable"]);
    };
    await replace(async (path) => {
      const made = Bun.spawnSync(["mkfifo", path]);
      expect(made.exitCode).toBe(0);
    });
    await replace(async (path, f) => {
      const target = join(f.root, "elsewhere.yml");
      await writeFile(
        target,
        JSON.stringify({ services: { web: { image: IMAGE } } })
      );
      await symlink(target, path);
    });
    await replace(async (path) => {
      await writeFile(path, "");
    });
    await replace(async (path) => {
      // One byte over the 256 KiB bound, and valid YAML.
      await writeFile(path, `services: {}\n#${"x".repeat(256 * 1024)}\n`);
    });
  },
  SPAWN_TIMEOUT_MS * 2
);

const UDP_REASON =
  "Native publishes only TCP ports; keep UDP publication on the Compose backend.";

test("preflight shows the start driver's UDP refusal without copying runtime text of unknown provenance", async () => {
  const f = await fixture({
    services: { web: { image: IMAGE, ports: ["8787:3000/udp"] } },
  });
  for (const fixed of [true, false]) {
    await f.review([], { services: { web: { active: true } } }, "both", [
      {
        code: "graph_port_publication",
        service: "web",
        message_fixed: fixed,
        message: fixed ? UDP_REASON : PRIVATE,
      },
    ]);
    const result = await preflight(f, { ...f.native, ...GRANT });
    expect(result.code).toBe(1);
    expect(result.report.ready).toBe(false);
    expect(result.report.blockers).toContainEqual(
      expect.objectContaining({
        code: "graph_port_publication",
        service: "web",
        field: "ports",
        message: fixed
          ? UDP_REASON
          : "Native startup refuses this configuration (graph_port_publication).",
      })
    );
    expect(result.output).not.toContain(PRIVATE);
    expect(await f.calls()).not.toContain("runtime up");
  }
});

test("preflight cannot report ready when a runtime omits or corrupts start-admission review", async () => {
  const f = await fixture({ services: { web: { image: IMAGE } } });
  for (const startRefusals of [undefined, {}, [null]]) {
    await f.reply("project-plan.out", {
      plan_id: "f".repeat(64),
      start_refusals: startRefusals,
      plan: {
        namespace: NAMESPACE,
        enrollment_compatible: true,
        services: { web: { active: true } },
        diagnostics: [],
      },
    });
    const result = await preflight(f, { ...f.native, ...GRANT });
    expect(result.report.ready).toBe(false);
    expect(result.report.runtime_review).toEqual({
      status: "unavailable",
      code: "native_start_review_unavailable",
    });
    const text = await cli(f, ["doctor", "--native-preflight"], {
      ...f.native,
      ...GRANT,
    });
    expect(text.output).toContain("update the selected native runtime");
  }
});

test("preflight supplies names-only private-delivery context without decrypting managed env or reading shell values", async () => {
  const f = await fixture({
    services: {
      managed: { image: IMAGE, restart: "always" },
      shell: {
        image: IMAGE,
        restart: "always",
        environment: ["TOKEN=${SOURCE_TOKEN}"],
      },
      literal: { image: IMAGE, environment: { TOKEN: PRIVATE } },
      excluded: {
        image: IMAGE,
        environment: ["AWS_SECRET_ACCESS_KEY", "COMPOSE_PROJECT_NAME"],
      },
    },
  });
  await writeFile(
    join(f.projectDir, "hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { managed: { TOKEN: { secure: "invalid-ciphertext-sentinel" } } },
    })
  );
  await f.review(
    [],
    {
      services: {
        managed: { active: true },
        shell: { active: true },
        literal: { active: true },
        excluded: { active: true },
      },
    },
    "both",
    [
      {
        code: "graph_restart_policy",
        message_fixed: true,
        message:
          "Automatic restart cannot be combined with managed environment delivery.",
        service: "managed",
      },
    ]
  );
  const result = await preflight(f, { ...f.native, SOURCE_TOKEN: PRIVATE });
  expect(result.code).toBe(1);
  expect(
    result.report.blockers.some(
      (entry) => entry.code === "graph_restart_policy"
    )
  ).toBe(true);
  expect(result.output).not.toContain(PRIVATE);
  expect(result.output).not.toContain("invalid-ciphertext-sentinel");
  const args = (await f.argv()).filter((line) =>
    line.includes("--normalized-file")
  );
  expect(args).toHaveLength(1);
  expect(args[0]).toContain("--start-managed-service managed");
  expect(args[0]).toContain("--start-managed-service shell");
  expect(args[0]).not.toContain("--start-managed-service literal");
  expect(args[0]).not.toContain("--start-managed-service excluded");
  expect(args.join("\n")).not.toContain(PRIVATE);
  const normalized = await readFile(
    join(f.root, "stub", "normalized.json"),
    "utf8"
  );
  const document = JSON.parse(normalized);
  expect(document.services.managed.environment).toEqual({ TOKEN: null });
  expect(document.services.shell.environment).toEqual({ TOKEN: null });
});

test("preflight reports the Compose budget before sending context for more than 128 services", async () => {
  const services = Object.fromEntries(
    Array.from({ length: 130 }, (_, index) => [
      `service-${index}`,
      { image: IMAGE, ...(index === 0 ? {} : { profiles: ["optional"] }) },
    ])
  );
  const f = await fixture({ services });
  await writeFile(
    join(f.projectDir, "hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { global: { TOKEN: PRIVATE } },
    })
  );
  await f.reviewStops("service_budget");
  const result = await preflight(f, f.native);
  expect(result.code).toBe(1);
  expect(
    result.report.blockers.some((entry) => entry.code === "service_budget")
  ).toBe(true);
  const args = await f.argv();
  expect(args).toHaveLength(1);
  expect(args.join("\n")).not.toContain("--start-managed-service");
  expect(args.join("\n")).not.toContain(PRIVATE);
});

test("preflight reports one project-wide managed env metadata error", async () => {
  const f = await fixture({ services: { web: { image: IMAGE } } });
  await writeFile(join(f.projectDir, "hack.env.default.yaml"), "values: [");
  await f.review([]);
  const result = await preflight(f, f.native);
  expect(result.code).toBe(1);
  expect(
    result.report.blockers.filter(
      (entry) => entry.code === "managed_env_unreadable"
    )
  ).toHaveLength(1);
});

for (const syntax of ["JSON null", "commented YAML"] as const) {
  for (const managed of [false, true]) {
    test(`empty service environments: ${syntax}, managed=${managed}`, async () => {
      const f = await fixture({
        services: { web: { image: IMAGE, environment: null } },
      });
      if (syntax === "commented YAML") {
        await writeFile(
          join(f.projectDir, "docker-compose.yml"),
          `services:\n  web:\n    image: ${JSON.stringify(IMAGE)}\n    environment:\n      # TOKEN: commented out\n`
        );
      }
      if (managed) {
        await writeFile(
          join(f.projectDir, "hack.env.default.yaml"),
          JSON.stringify({
            version: 1,
            environment: "default",
            secretsprovider: "project_key",
            values: { web: { TOKEN: PRIVATE } },
          })
        );
      }
      await f.review([], { services: { web: { active: true } } });
      const result = await preflight(f, { ...f.native, ...GRANT });
      expect(result.code).toBe(0);
      expect(result.report.ready).toBe(true);
      expect(result.report.blockers).toEqual([]);
      expect(result.output).not.toContain(PRIVATE);
      const args =
        (await f.argv()).find((line) => line.includes("--normalized-file")) ??
        "";
      expect(args.includes("--start-managed-service web")).toBe(managed);
      const normalized = await readFile(
        join(f.root, "stub", "normalized.json"),
        "utf8"
      );
      expect(JSON.parse(normalized)).toMatchObject({
        services: { web: { environment: managed ? { TOKEN: null } : null } },
      });
      expect(normalized).not.toContain(PRIVATE);
    });
  }
}

test(
  "foreground, detached and JSON native up retain the fixed UDP refusal and omit unrelated runtime text",
  async () => {
    const f = await fixture({
      services: { web: { image: IMAGE, ports: ["8787:3000/udp"] } },
    });
    await scriptSourceShare(f);
    await f.review([], { services: { web: { active: true } } }, "both", [
      {
        code: "graph_port_publication",
        message_fixed: true,
        message: UDP_REASON,
        service: "web",
      },
    ]);
    await f.reply("runtime-up.err", {
      code: "graph_port_publication",
      message_fixed: true,
      message: UDP_REASON,
      service: "web",
      output: PRIVATE,
    });
    for (const flags of [[], ["-d"], ["--json"]]) {
      const result = await cli(f, ["up", ...flags], { ...f.native, ...GRANT });
      expect(result.code).toBe(1);
      expect(result.output).toContain("graph_port_publication");
      expect(result.output).toContain(UDP_REASON);
      expect(result.output).not.toContain(PRIVATE);
      expect(result.output).not.toContain("startup was not confirmed");
      expect(await f.calls()).not.toContain("runtime up");
      if (flags.includes("--json")) {
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false,
          error: { message: expect.stringContaining(UDP_REASON) },
        });
      }
    }
  },
  SPAWN_TIMEOUT_MS
);
