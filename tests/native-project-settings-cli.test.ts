import { afterEach, expect, test } from "bun:test";
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
import { NATIVE_SHARED_SOURCE_REFUSAL } from "../src/backends/native-project-start.ts";
import { privateCliEnv, privateCliHome } from "./helpers/private-cli-env.ts";

/**
 * Native project settings through the real CLI: a committed
 * `.hack/native/adaptation.json` and per-machine settings under the private
 * HOME select what the `HACK_NATIVE_*` variables select, and `hack doctor`
 * reports where each setting came from without its value.
 *
 * The stub runtime records every request and answers only the scripted
 * `runtime check-project-share` reply, so nothing here starts a real runtime,
 * Docker or a VM. Every name and value is synthetic.
 */

const roots: string[] = [];
const entrypoint = resolve("index.ts");
const SPAWN_TIMEOUT_MS = 60_000;
const IMAGE = `sha256:${"e".repeat(64)}`;
const PROJECT = "settings-cli-fixture";
const SELECTION =
  "this project runs on the Compose backend. Set HACK_RUNTIME_BACKEND=compose (hack-next and hack-v5 accept it too) and run the command again. Nothing was started or stopped.";
const EXTERNAL_COMPOSE = {
  services: { web: { image: IMAGE, networks: ["shared-dev"] } },
  networks: { "shared-dev": { external: true } },
};
/** Reachable only after the Compose-backend check and the share grant passed. */
const RUNTIME_REQUEST_LINE =
  /^ERROR: Native runtime (request failed \(runtime_not_running\)|request timed out); inspect owned state before retrying\.$|^ERROR: Native runtime returned an invalid control response\.$/m;

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(compose: Record<string, unknown>) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-settings-cli-"))
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
    JSON.stringify({ name: PROJECT })
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
  const committed = async (name: string, value: unknown) => {
    await mkdir(join(projectDir, "native"), { recursive: true });
    await writeFile(join(projectDir, "native", name), JSON.stringify(value));
  };
  const machine = async (value: unknown, mode = 0o600) => {
    env({});
    const directory = join(
      privateCliHome(root),
      ".config",
      "hack",
      "native",
      PROJECT
    );
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const file = join(directory, "settings.json");
    // Granted to this checkout's root unless the record names its own roots.
    const bound =
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value) &&
      !Object.hasOwn(value, "projectRoots")
        ? { ...value, projectRoots: [project] }
        : value;
    await writeFile(file, JSON.stringify(bound), { mode });
    await chmod(file, mode);
  };
  return { root, project, calls, env, committed, machine };
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

function errorLines(output: string): string[] {
  return output.split("\n").filter((text) => text.startsWith("ERROR:"));
}

test(
  "a committed adaptation keeps an external network on native up without HACK_NATIVE_ADAPTATION",
  async () => {
    const f = await fixture(EXTERNAL_COMPOSE);
    await f.committed("adaptation.json", {
      version: 1,
      isolatedNetworks: ["shared-dev"],
    });
    const result = await cli(f, ["up"], { HACK_NATIVE_SHARED_SOURCE: "1" });
    expect(result.output).not.toContain("E_NATIVE_PROJECT_UNSUPPORTED");
    expect(result.output).toMatch(RUNTIME_REQUEST_LINE);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "HACK_NATIVE_ADAPTATION replaces the committed adaptation whole",
  async () => {
    const f = await fixture(EXTERNAL_COMPOSE);
    await f.committed("adaptation.json", {
      version: 1,
      isolatedNetworks: ["shared-dev"],
    });
    const explicit = join(f.root, "explicit-adaptation.json");
    await writeFile(explicit, JSON.stringify({ version: 1 }));
    const result = await cli(f, ["up"], {
      HACK_NATIVE_SHARED_SOURCE: "1",
      HACK_NATIVE_ADAPTATION: explicit,
    });
    expect(errorLines(result.output)).toEqual([
      `ERROR: E_NATIVE_PROJECT_UNSUPPORTED: Native \`hack up\` does not support an external Compose network; ${SELECTION}`,
    ]);
    expect(await f.calls()).toEqual([]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "a per-env adaptation applies with its --env and is not assumed without one",
  async () => {
    const f = await fixture(EXTERNAL_COMPOSE);
    await f.committed("adaptation.qa.json", {
      version: 1,
      isolatedNetworks: ["shared-dev"],
    });
    const without = await cli(f, ["up"], { HACK_NATIVE_SHARED_SOURCE: "1" });
    expect(errorLines(without.output)).toEqual([
      `ERROR: E_NATIVE_PROJECT_UNSUPPORTED: Native \`hack up\` does not support an external Compose network; ${SELECTION}`,
    ]);
    expect(await f.calls()).toEqual([]);
    const withEnv = await cli(f, ["up", "--env", "qa"], {
      HACK_NATIVE_SHARED_SOURCE: "1",
    });
    expect(withEnv.output).not.toContain("E_NATIVE_PROJECT_UNSUPPORTED");
  },
  SPAWN_TIMEOUT_MS
);

test(
  "an invalid committed adaptation refuses with the closed line before any request",
  async () => {
    const f = await fixture(EXTERNAL_COMPOSE);
    await f.committed("adaptation.json", {
      version: 1,
      isolatedNetworks: "shared-dev",
    });
    const result = await cli(f, ["up"], { HACK_NATIVE_SHARED_SOURCE: "1" });
    expect(errorLines(result.output)).toEqual([
      "ERROR: E_CONFIG_INVALID: Native project adaptation is invalid or conflicts with declared configuration; values omitted.",
    ]);
    expect(await f.calls()).toEqual([]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "machine settings grant the project share; without a grant up refuses before any request",
  async () => {
    const f = await fixture({ services: { web: { image: IMAGE } } });
    const refused = await cli(f, ["up"]);
    expect(errorLines(refused.output)).toEqual([
      `ERROR: E_PERMISSION: ${NATIVE_SHARED_SOURCE_REFUSAL}`,
    ]);
    expect(await f.calls()).toEqual([]);
    await f.machine({ version: 1, sharedSource: true });
    const granted = await cli(f, ["up"]);
    expect(granted.output).not.toContain("E_PERMISSION");
    expect(granted.output).toMatch(RUNTIME_REQUEST_LINE);
    // An explicit variable still wins over the machine grant.
    const revoked = await cli(f, ["up"], { HACK_NATIVE_SHARED_SOURCE: "0" });
    expect(errorLines(revoked.output)).toEqual([
      `ERROR: E_PERMISSION: ${NATIVE_SHARED_SOURCE_REFUSAL}`,
    ]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "a machine grant applies only to its project root; another checkout of the same name runs no hook",
  async () => {
    const f = await fixture({ services: { web: { image: IMAGE } } });
    await f.machine({ version: 1, sharedSource: true });
    // A second checkout claims the same project name and authors an up hook.
    const other = join(f.root, "other-checkout");
    const marker = join(f.root, "hook-ran");
    await mkdir(join(other, ".hack"), { recursive: true });
    await writeFile(
      join(other, ".hack", "docker-compose.yml"),
      JSON.stringify({ services: { web: { image: IMAGE } } })
    );
    await writeFile(
      join(other, ".hack", "hack.config.json"),
      JSON.stringify({
        name: PROJECT,
        lifecycle: { up: { before: [`touch '${marker}'`] } },
      })
    );
    const refused = await cli({ ...f, project: other }, ["up"]);
    expect(errorLines(refused.output)).toEqual([
      'ERROR: E_PERMISSION: Native machine settings do not grant this project root. To grant this checkout, add its absolute path to "projectRoots" in ${XDG_CONFIG_HOME:-$HOME/.config}/hack/native/<project>/settings.json; values omitted.',
    ]);
    expect(await Bun.file(marker).exists()).toBe(false);
    expect(await f.calls()).toEqual([]);
    // The granted root, also through a symbolic link, still reaches the runtime.
    const linked = join(f.root, "linked-project");
    await symlink(f.project, linked);
    const granted = await cli({ ...f, project: linked }, ["up"]);
    expect(granted.output).not.toContain("E_PERMISSION");
    expect(granted.output).toMatch(RUNTIME_REQUEST_LINE);
    // A record without a binding grants nothing.
    await f.machine({
      version: 1,
      sharedSource: true,
      projectRoots: undefined,
    });
    const unbound = await cli(f, ["up"]);
    expect(errorLines(unbound.output)).toEqual([
      expect.stringMatching(
        /^ERROR: E_PERMISSION: Native machine settings are not bound to a project root\./
      ),
    ]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "a machine settings file readable by others refuses before any request",
  async () => {
    const f = await fixture({ services: { web: { image: IMAGE } } });
    await f.machine({ version: 1, sharedSource: true }, 0o644);
    const result = await cli(f, ["up"]);
    expect(errorLines(result.output)).toEqual([
      "ERROR: E_CONFIG_INVALID: Native machine settings file must be a bounded owner-only (mode 0600) regular JSON file; values omitted.",
    ]);
    expect(await f.calls()).toEqual([]);
  },
  SPAWN_TIMEOUT_MS
);

test(
  "native doctor reports setting origins and native warnings, never values",
  async () => {
    const f = await fixture({
      services: {
        web: { image: IMAGE, labels: { caddy: "web.example.test" } },
        api: { image: IMAGE, labels: { caddy: "api.example.test" } },
      },
    });
    await writeFile(
      join(f.project, ".hack", "hack.config.json"),
      JSON.stringify({
        name: PROJECT,
        internal: { extra_hosts: { "upstream.example.test": "host-gateway" } },
      })
    );
    await f.committed("adaptation.json", {
      version: 1,
      httpProbes: { web: { port: 3000, path: "/health" } },
    });
    await f.committed("dependencies.json", { version: 1, dependencies: [] });
    await f.machine({
      version: 1,
      sharedSource: true,
      aws: { profile: "synthetic-secret-profile" },
    });
    const result = await cli(f, ["doctor", "--json"], {
      HACK_NATIVE_AWS_REGION: "eu-west-1",
      HACK_NATIVE_ALLOW_HOSTS: "registry.example.com",
    });
    const envelope: unknown = JSON.parse(
      result.output.slice(result.output.indexOf("{"))
    );
    expect(envelope).toMatchObject({
      data: {
        checks: expect.arrayContaining([
          expect.objectContaining({
            id: "native settings",
            status: "warn",
            nativeSettings: {
              origins: {
                adaptation: "project",
                sharedSource: "machine",
                dependencies: "unset",
                allowHosts: "env",
                preparedBase: "unset",
                https: "unset",
                aws: "machine",
              },
              adaptationFiles: [join(".hack", "native", "adaptation.json")],
              machineSettings: {
                path: `~/.config/hack/native/${PROJECT}/settings.json`,
                present: true,
              },
              warnings: [
                "internal_dns_tls_not_applied",
                "internal_extra_hosts_not_applied",
                "routes_without_probes",
                "aws_region_without_profile",
                "unread_project_settings_files",
              ],
              routesWithoutProbes: 1,
            },
          }),
        ]),
      },
    });
    for (const value of [
      "synthetic-secret-profile",
      "registry.example.com",
      "upstream.example.test",
      "api.example.test",
      f.root,
    ]) {
      expect(result.output).not.toContain(value);
    }
  },
  SPAWN_TIMEOUT_MS
);
