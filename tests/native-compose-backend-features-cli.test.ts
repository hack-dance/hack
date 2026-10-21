import { afterEach, expect, test } from "bun:test";
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
import { join, relative, resolve } from "node:path";
import { NATIVE_CONFIGURATION_REFUSAL } from "../src/backends/native-project-start.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1291: a real Compose project that uses an external network, a reserved
 * ownership label, an advanced build or a non-arm64 platform stays on the
 * Compose backend. Native `up` and `restart` refuse each one through the real
 * CLI with one closed `E_NATIVE_PROJECT_UNSUPPORTED` line that names the
 * feature and the Compose selection, before any runtime request or write.
 *
 * The stub runtime records every request and answers only the scripted
 * `runtime check-project-share` reply, so a refusal that came after a runtime
 * request or a write would show up in `calls` or in the file tree. Nothing
 * here starts a real runtime, Docker or a VM.
 */

const roots: string[] = [];
const entrypoint = resolve("index.ts");
const STACK_FRAME = /^\s+at /m;
const SPAWN_TIMEOUT_MS = 60_000;
const IMAGE = `sha256:${"e".repeat(64)}`;
const SELECTION =
  "this project runs on the Compose backend. Set HACK_RUNTIME_BACKEND=compose (hack-next and hack-v5 accept it too) and run the command again. Nothing was started or stopped.";

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(compose: Record<string, unknown>) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-compose-backend-cli-"))
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
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    JSON.stringify(compose)
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({ name: "backend-fixture" })
  );
  await writeFile(join(runtimeDir, "hack-relay-guest"), "synthetic relay");
  const binary = join(runtimeDir, "native-runtime");
  await writeFile(
    binary,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${stub}/calls'
if [ -f '${stub}/'"$3-$4"'.out' ]; then cat '${stub}/'"$3-$4"'.out'; exit 0; fi
printf '%s' '{"code":"runtime_not_running"}' >&2
exit 1
`,
    { mode: 0o700 }
  );
  await writeFile(
    join(stub, "runtime-check-project-share.out"),
    JSON.stringify({ source_admitted: true, pool_initialized: true })
  );
  const calls = async () =>
    (await readFile(join(stub, "calls"), "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split(" ").slice(2, 4).join(" "));
  const env = (extra: Record<string, string>) =>
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
  return { root, project, calls, env };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function cli(
  f: Fixture,
  args: readonly string[],
  env: Record<string, string> = { HACK_NATIVE_SHARED_SOURCE: "1" }
) {
  const child = Bun.spawn(
    [process.execPath, entrypoint, "--path", f.project, ...args],
    {
      cwd: f.root,
      env: f.env(env),
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
  return { code, output: stdout + stderr };
}

/**
 * Every file under the fixture except the stub's own request log and Bun's
 * transpiler cache, which the spawned source CLI writes under its HOME.
 */
async function tree(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true });
  return entries
    .map((entry) => relative(root, join(root, entry)))
    .filter(
      (entry) =>
        !(
          entry.startsWith("stub") ||
          entry.startsWith(join("user-home", "Library"))
        )
    )
    .sort();
}

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

/** Refused with the Compose-backend line, and nothing was requested or written. */
async function expectComposeBackendRefusal(opts: {
  readonly compose: Record<string, unknown>;
  readonly phrase: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly command?: string;
  /** Authored values that must not appear in the output. */
  readonly secrets?: readonly string[];
}): Promise<void> {
  const f = await fixture(opts.compose);
  // Building the child env creates the private HOME and Docker client config.
  f.env({});
  const before = await tree(f.root);
  const result = await cli(f, opts.args ?? ["up"], opts.env);
  expectOneClosedLine(
    result,
    `E_NATIVE_PROJECT_UNSUPPORTED: Native \`${opts.command ?? "hack up"}\` does not support ${opts.phrase}; ${SELECTION}`
  );
  for (const secret of opts.secrets ?? []) {
    expect(result.output).not.toContain(secret);
  }
  expect(await f.calls()).toEqual([]);
  expect(await tree(f.root)).toEqual(before);
}

test(
  "an external Compose network refuses native up before any request or write",
  async () => {
    await expectComposeBackendRefusal({
      compose: {
        services: { web: { image: IMAGE, networks: ["shared-dev-net"] } },
        networks: { "shared-dev-net": { external: true } },
      },
      phrase: "an external Compose network",
      secrets: ["shared-dev-net"],
    });
  },
  SPAWN_TIMEOUT_MS
);

test(
  "a reserved ownership label refuses native up before any request or write",
  async () => {
    await expectComposeBackendRefusal({
      compose: {
        services: {
          web: {
            image: IMAGE,
            labels: { "io.hack-local.owner": "borrowed-owner-token" },
          },
        },
      },
      phrase:
        "a label in a reserved ownership namespace (com.docker.compose.*, io.hack-local.* or io.hack.native-config.*)",
      secrets: ["borrowed-owner-token", "io.hack-local.owner"],
    });
  },
  SPAWN_TIMEOUT_MS
);

test(
  "a build outside the basic form refuses native up before any request or write",
  async () => {
    await expectComposeBackendRefusal({
      compose: {
        services: {
          web: { build: { context: "..", args: { TOKEN_NAME: "build-arg" } } },
        },
      },
      phrase:
        "a Compose build outside the basic context, dockerfile and target form",
      secrets: ["TOKEN_NAME", "build-arg"],
    });
  },
  SPAWN_TIMEOUT_MS
);

test(
  "a non-arm64 service platform refuses native up before any request or write",
  async () => {
    await expectComposeBackendRefusal({
      compose: {
        services: { web: { image: IMAGE, platform: "linux/amd64" } },
      },
      phrase: "a service platform other than linux/arm64",
      secrets: ["linux/amd64"],
    });
  },
  SPAWN_TIMEOUT_MS
);

test(
  "all features are named in one line, ahead of the shared-source grant",
  async () => {
    await expectComposeBackendRefusal({
      compose: {
        services: {
          web: {
            image: IMAGE,
            platform: "linux/amd64",
            labels: ["com.docker.compose.project=other"],
          },
          api: { image: IMAGE, build: ".." },
        },
        networks: { edge: { external: { name: "edge" } } },
      },
      env: {},
      phrase:
        "an external Compose network, a label in a reserved ownership namespace (com.docker.compose.*, io.hack-local.* or io.hack.native-config.*), a Compose build outside the basic context, dockerfile and target form and a service platform other than linux/arm64",
    });
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native restart refuses the same features before any stop",
  async () => {
    await expectComposeBackendRefusal({
      compose: {
        services: { web: { image: IMAGE, networks: ["edge"] } },
        networks: { edge: { external: true } },
      },
      args: ["restart"],
      command: "hack restart",
      phrase: "an external Compose network",
    });
  },
  SPAWN_TIMEOUT_MS
);

test(
  "control: ordinary labels and a basic build keep today's native refusal",
  async () => {
    for (const service of [
      { image: IMAGE, labels: { "com.example.team": "web" } },
      { build: ".." },
    ]) {
      const f = await fixture({ services: { web: service } });
      const result = await cli(f, ["up"]);
      expectOneClosedLine(
        result,
        `E_NATIVE_PROJECT_UNSUPPORTED: ${NATIVE_CONFIGURATION_REFUSAL}`
      );
      expect(result.output).not.toContain("HACK_RUNTIME_BACKEND=compose");
      // The check passed: native up went on to its own source preflight.
      expect(await f.calls()).toEqual(["runtime check-project-share"]);
    }
  },
  SPAWN_TIMEOUT_MS
);

test(
  "control: a reviewed isolated network replacement and arm64 platform pass the check",
  async () => {
    const f = await fixture({
      services: {
        web: {
          image: IMAGE,
          platform: "linux/arm64",
          labels: { "com.example.team": "web" },
          networks: ["edge"],
        },
      },
      networks: { edge: { external: true, "x-hack-isolated": true } },
    });
    const result = await cli(f, ["up"]);
    expect(result.output).not.toContain("HACK_RUNTIME_BACKEND=compose");
    expect(await f.calls()).toEqual(["runtime check-project-share"]);
  },
  SPAWN_TIMEOUT_MS
);

/** The documented `isolatedNetworks` adaptation for an external `hack-dev`. */
const HACK_DEV_COMPOSE = {
  services: { web: { image: IMAGE, networks: ["hack-dev"] } },
  networks: { "hack-dev": { external: true } },
};

async function adaptation(f: Fixture, selection: unknown): Promise<string> {
  const path = join(f.root, "native-adaptation.json");
  await writeFile(path, JSON.stringify(selection));
  return path;
}

/** A runtime request that the stub refused or that timed out on a loaded host. */
const RUNTIME_REQUEST_LINE =
  /^ERROR: Native runtime request (failed \(runtime_not_running\)|timed out); inspect owned state before retrying\.$/m;

test(
  "the documented isolatedNetworks adaptation keeps an external network on native up",
  async () => {
    const f = await fixture(HACK_DEV_COMPOSE);
    const path = await adaptation(f, {
      version: 1,
      isolatedNetworks: ["hack-dev"],
    });
    const result = await cli(f, ["up"], {
      HACK_NATIVE_SHARED_SOURCE: "1",
      HACK_NATIVE_ADAPTATION: path,
    });
    expect(result.output).not.toContain("E_NATIVE_PROJECT_UNSUPPORTED");
    expect(result.output).not.toContain("HACK_RUNTIME_BACKEND=compose");
    // The check passed: native start went on to its source preflight and,
    // after applying the adaptation in native review, to `runtime up`.
    expect(result.output).toMatch(RUNTIME_REQUEST_LINE);
    const calls = await f.calls();
    expect(calls).toEqual(
      ["runtime check-project-share", "runtime up"].slice(0, calls.length)
    );
  },
  SPAWN_TIMEOUT_MS
);

test(
  "the same adaptation lets native restart reach its own preflight",
  async () => {
    const f = await fixture(HACK_DEV_COMPOSE);
    const path = await adaptation(f, {
      version: 1,
      isolatedNetworks: ["hack-dev"],
    });
    const result = await cli(f, ["restart"], {
      HACK_NATIVE_SHARED_SOURCE: "1",
      HACK_NATIVE_ADAPTATION: path,
    });
    // Restart preflight refuses a project with no run, after the check.
    expectOneClosedLine(
      result,
      "Native restart has no existing run; use hack up for initial startup."
    );
    expect(await f.calls()).toEqual([]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "an adaptation that isolates a different network still refuses the external one",
  async () => {
    const f = await fixture(HACK_DEV_COMPOSE);
    f.env({});
    const path = await adaptation(f, {
      version: 1,
      isolatedNetworks: ["other-net"],
    });
    const before = await tree(f.root);
    const result = await cli(f, ["up"], {
      HACK_NATIVE_SHARED_SOURCE: "1",
      HACK_NATIVE_ADAPTATION: path,
    });
    expectOneClosedLine(
      result,
      `E_NATIVE_PROJECT_UNSUPPORTED: Native \`hack up\` does not support an external Compose network; ${SELECTION}`
    );
    expect(await f.calls()).toEqual([]);
    expect(await tree(f.root)).toEqual(before);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "an invalid adaptation refuses with native start's closed line before any request",
  async () => {
    const f = await fixture(HACK_DEV_COMPOSE);
    f.env({});
    const path = await adaptation(f, {
      version: 2,
      isolatedNetworks: ["hack-dev"],
    });
    const before = await tree(f.root);
    const result = await cli(f, ["up"], {
      HACK_NATIVE_SHARED_SOURCE: "1",
      HACK_NATIVE_ADAPTATION: path,
    });
    expectOneClosedLine(
      result,
      "E_CONFIG_INVALID: Native project adaptation is invalid or conflicts with declared configuration; values omitted."
    );
    expect(await f.calls()).toEqual([]);
    expect(await tree(f.root)).toEqual(before);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native doctor applies the same adaptation before reporting",
  async () => {
    const f = await fixture(HACK_DEV_COMPOSE);
    const path = await adaptation(f, {
      version: 1,
      isolatedNetworks: ["hack-dev"],
    });
    const result = await cli(f, ["doctor", "--json"], {
      HACK_NATIVE_ADAPTATION: path,
    });
    const envelope: unknown = JSON.parse(
      result.output.slice(result.output.indexOf("{"))
    );
    expect(envelope).toMatchObject({
      data: {
        checks: expect.arrayContaining([
          expect.objectContaining({
            id: "compose backend features",
            status: "ok",
            composeBackend: { features: [] },
          }),
        ]),
      },
    });
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native doctor reports the same features for the current project, value-free",
  async () => {
    const f = await fixture({
      services: { web: { image: IMAGE, platform: "linux/amd64" } },
      networks: { "shared-dev-net": { external: true } },
    });
    const result = await cli(f, ["doctor", "--json"], {});
    const envelope: unknown = JSON.parse(
      result.output.slice(result.output.indexOf("{"))
    );
    expect(envelope).toMatchObject({
      ok: true,
      data: {
        checks: expect.arrayContaining([
          expect.objectContaining({
            id: "compose backend features",
            status: "warn",
            composeBackend: {
              features: ["external_network", "foreign_platform"],
            },
          }),
        ]),
      },
    });
    expect(result.output).toContain("HACK_RUNTIME_BACKEND=compose");
    expect(result.output).not.toContain("shared-dev-net");
    expect(result.output).not.toContain("linux/amd64");
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native up --detach keeps its one-line foreground-only refusal",
  async () => {
    const f = await fixture({ services: { web: { image: IMAGE } } });
    const result = await cli(f, ["up", "--detach"]);
    expectOneClosedLine(
      result,
      "E_USAGE: Native `hack up` runs in the foreground only, so --detach is not supported. Run `hack up` without --detach in its own terminal and keep it open; use `hack ps` and `hack logs` from another terminal, and press Ctrl-C to stop it."
    );
    expect(await f.calls()).toEqual([]);
  },
  SPAWN_TIMEOUT_MS
);
