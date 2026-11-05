import { afterEach, expect, test } from "bun:test";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectNativeEnvFile } from "../src/backends/native-project-selection.ts";
import {
  nativeAdaptationCandidates,
  nativeMachineSettingsDirectory,
  resolveNativeAdaptationSelection,
  resolveNativeHostSettings,
} from "../src/backends/native-project-settings.ts";
import { readComposeBackendFeatures } from "../src/lib/native-compose-backend-features.ts";
import { expectCodedRefusal } from "./helpers/closed-refusal.ts";

/**
 * Native project settings: committed adaptation discovery, per-machine settings
 * outside the project share, and per-setting environment precedence. Every
 * fixture is synthetic and lives under a private temporary root; no test reads
 * the contributor's HOME (each passes HOME and XDG_CONFIG_HOME explicitly).
 */

const roots: string[] = [];
const SHA = "a".repeat(64);
const UID = typeof process.getuid === "function" ? process.getuid() : 0;

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "native-project-settings-"))
  );
  roots.push(root);
  const projectRoot = join(root, "project");
  const projectDir = join(projectRoot, ".hack");
  const nativeDir = join(projectDir, "native");
  const home = join(root, "home");
  await mkdir(projectDir, { recursive: true });
  await mkdir(home, { mode: 0o700 });
  const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config") };
  const machineDir = join(
    home,
    ".config",
    "hack",
    "native",
    "settings-fixture"
  );
  async function machine(value: unknown, mode = 0o600): Promise<string> {
    await mkdir(machineDir, { recursive: true, mode: 0o700 });
    await chmod(machineDir, 0o700);
    const file = join(machineDir, "settings.json");
    await writeFile(file, JSON.stringify(value), { mode });
    await chmod(file, mode);
    return file;
  }
  async function committed(name: string, value: unknown): Promise<string> {
    await mkdir(nativeDir, { recursive: true });
    const file = join(nativeDir, name);
    await writeFile(file, JSON.stringify(value));
    return file;
  }
  const host = (extra: Record<string, string | undefined> = {}) =>
    resolveNativeHostSettings({
      env: { ...env, ...extra },
      projectName: "settings-fixture",
      projectRoot,
      uid: UID,
    });
  return {
    root,
    projectRoot,
    projectDir,
    nativeDir,
    home,
    env,
    machineDir,
    machine,
    committed,
    host,
  };
}

test("no committed files and no machine directory leave every setting unset", async () => {
  const f = await fixture();
  expect(
    await resolveNativeAdaptationSelection({
      env: f.env,
      projectDir: f.projectDir,
    })
  ).toEqual({ origin: "unset", fileByEnv: {} });
  const host = await f.host();
  expect(host).toEqual({
    sharedSource: false,
    dependencyFileByEnv: {},
    allowedHosts: [],
    origins: {
      sharedSource: "unset",
      dependencies: "unset",
      allowHosts: "unset",
      preparedBase: "unset",
      https: "unset",
      aws: "unset",
    },
  });
});

test("committed adaptation and per-env files are discovered; other names are not", async () => {
  const f = await fixture();
  const base = await f.committed("adaptation.json", { version: 1 });
  const qa = await f.committed("adaptation.qa.json", { version: 1 });
  await f.committed("settings.json", { version: 1, sharedSource: true });
  await f.committed("adaptation.QA.json", { version: 1 });
  const selection = await resolveNativeAdaptationSelection({
    env: f.env,
    projectDir: f.projectDir,
  });
  expect(selection).toEqual({
    origin: "project",
    file: base,
    fileByEnv: { qa },
  });
  // The env-specific file replaces the base; other envs and no env use the base.
  expect(selectNativeEnvFile({ selection, envName: "qa" })).toBe(qa);
  expect(selectNativeEnvFile({ selection, envName: "staging" })).toBe(base);
  expect(selectNativeEnvFile({ selection, envName: null })).toBe(base);
  expect(
    nativeAdaptationCandidates({ selection, requestedEnvName: "qa" })
  ).toEqual([qa]);
  expect(
    nativeAdaptationCandidates({ selection, requestedEnvName: undefined })
  ).toEqual([base, qa]);
});

test("a per-env file without a base applies only to its env", async () => {
  const f = await fixture();
  const qa = await f.committed("adaptation.qa.json", { version: 1 });
  const selection = await resolveNativeAdaptationSelection({
    env: f.env,
    projectDir: f.projectDir,
  });
  expect(selectNativeEnvFile({ selection, envName: "qa" })).toBe(qa);
  expect(selectNativeEnvFile({ selection, envName: null })).toBeUndefined();
  expect(
    nativeAdaptationCandidates({ selection, requestedEnvName: undefined })
  ).toEqual([undefined, qa]);
});

test("HACK_NATIVE_ADAPTATION replaces the committed files whole", async () => {
  const f = await fixture();
  await f.committed("adaptation.json", { version: 1 });
  await f.committed("adaptation.qa.json", { version: 1 });
  const explicit = join(f.root, "explicit.json");
  expect(
    await resolveNativeAdaptationSelection({
      env: { ...f.env, HACK_NATIVE_ADAPTATION: explicit },
      projectDir: f.projectDir,
    })
  ).toEqual({ origin: "env", file: explicit, fileByEnv: {} });
  // A set but empty variable still selects (and native start refuses it), as before.
  expect(
    await resolveNativeAdaptationSelection({
      env: { ...f.env, HACK_NATIVE_ADAPTATION: "" },
      projectDir: f.projectDir,
    })
  ).toEqual({ origin: "env", file: "", fileByEnv: {} });
});

test("a .hack/native that is not a real directory refuses", async () => {
  const f = await fixture();
  const elsewhere = join(f.root, "elsewhere");
  await mkdir(elsewhere);
  await symlink(elsewhere, f.nativeDir);
  await expectCodedRefusal(
    resolveNativeAdaptationSelection({ env: f.env, projectDir: f.projectDir }),
    "E_CONFIG_INVALID",
    "Native project settings in .hack/native/ must be a real directory"
  );
  await rm(f.nativeDir);
  await writeFile(f.nativeDir, "{}");
  await expectCodedRefusal(
    resolveNativeAdaptationSelection({ env: f.env, projectDir: f.projectDir }),
    "E_CONFIG_INVALID",
    "Native project settings in .hack/native/ must be a real directory"
  );
});

test("the Compose-backend pre-check isolates a network only when every candidate does", async () => {
  const f = await fixture();
  const compose = join(f.projectDir, "docker-compose.yml");
  await writeFile(
    compose,
    JSON.stringify({
      services: { web: { image: "registry.example/app:1" } },
      networks: { shared: { external: true } },
    })
  );
  const isolating = await f.committed("adaptation.json", {
    version: 1,
    isolatedNetworks: ["shared"],
  });
  const other = await f.committed("adaptation.qa.json", { version: 1 });
  expect(
    await readComposeBackendFeatures(compose, {
      adaptationCandidates: [isolating],
    })
  ).toEqual([]);
  expect(
    await readComposeBackendFeatures(compose, {
      adaptationCandidates: [isolating, other],
    })
  ).toEqual(["external_network"]);
  expect(
    await readComposeBackendFeatures(compose, {
      adaptationCandidates: [isolating, undefined],
    })
  ).toEqual(["external_network"]);
  // A committed adaptation that is a symlink refuses as an explicit one does.
  const target = join(f.root, "target.json");
  await writeFile(
    target,
    JSON.stringify({ version: 1, isolatedNetworks: ["shared"] })
  );
  await rm(isolating);
  await symlink(target, isolating);
  await expectCodedRefusal(
    readComposeBackendFeatures(compose, { adaptationCandidates: [isolating] }),
    "E_CONFIG_INVALID",
    "Native selection requires a bounded, unchanged regular JSON file"
  );
});

test("machine settings supply every grant and host setting", async () => {
  const f = await fixture();
  const file = await f.machine({
    version: 1,
    sharedSource: true,
    dependencies: "dependencies.json",
    dependenciesByEnv: { qa: "dependencies.qa.json" },
    allowHosts: ["registry.example.com"],
    preparedBase: { mode: "prefer" },
    https: { caddyBinary: "/opt/caddy/bin/caddy", caddySha256: SHA, port: 443 },
    aws: { profile: "synthetic-profile", region: "eu-west-1" },
  });
  const canonical = await realpath(f.machineDir);
  expect(await f.host()).toEqual({
    sharedSource: true,
    dependencyFile: join(canonical, "dependencies.json"),
    dependencyFileByEnv: { qa: join(canonical, "dependencies.qa.json") },
    allowedHosts: ["registry.example.com"],
    preparedBase: { mode: "prefer" },
    https: {
      caddyBinary: "/opt/caddy/bin/caddy",
      caddySha256: SHA,
      httpsPort: 443,
    },
    aws: { profile: "synthetic-profile", region: "eu-west-1" },
    origins: {
      sharedSource: "machine",
      dependencies: "machine",
      allowHosts: "machine",
      preparedBase: "machine",
      https: "machine",
      aws: "machine",
    },
    machineFile: join(canonical, "settings.json"),
  });
  expect(file).toBe(join(f.machineDir, "settings.json"));
});

test("a set variable wins its whole setting over the machine value", async () => {
  const f = await fixture();
  await f.machine({
    version: 1,
    sharedSource: true,
    dependencies: "dependencies.json",
    dependenciesByEnv: { qa: "dependencies.qa.json" },
    allowHosts: ["registry.example.com"],
    preparedBase: { mode: "require" },
    https: { caddyBinary: "/opt/caddy/bin/caddy", caddySha256: SHA, port: 443 },
    aws: { profile: "machine-profile", region: "eu-west-1" },
  });
  const explicit = join(f.root, "deps.json");
  const host = await f.host({
    HACK_NATIVE_SHARED_SOURCE: "0",
    HACK_NATIVE_DEPENDENCIES: explicit,
    HACK_NATIVE_ALLOW_HOSTS: "mirror.example.org",
    HACK_NATIVE_PREPARED_BASE: "off",
    HACK_NATIVE_CADDY_BINARY: "/usr/local/bin/caddy",
    HACK_NATIVE_CADDY_SHA256: SHA,
    HACK_NATIVE_HTTPS_PORT: "8443",
    HACK_NATIVE_AWS_PROFILE: "env-profile",
  });
  expect(host).toMatchObject({
    sharedSource: false,
    dependencyFile: explicit,
    dependencyFileByEnv: {},
    allowedHosts: ["mirror.example.org"],
    https: { caddyBinary: "/usr/local/bin/caddy", httpsPort: 8443 },
    aws: { profile: "env-profile", region: undefined },
    origins: {
      sharedSource: "env",
      dependencies: "env",
      allowHosts: "env",
      preparedBase: "env",
      https: "env",
      aws: "env",
    },
  });
  expect(host.preparedBase).toBeUndefined();
  // HACK_NATIVE_AWS_REGION alone does not select the AWS variables.
  expect((await f.host({ HACK_NATIVE_AWS_REGION: "us-west-2" })).aws).toEqual({
    profile: "machine-profile",
    region: "eu-west-1",
  });
});

test("an invalid machine value refuses even when a variable overrides it", async () => {
  const f = await fixture();
  await f.machine({ version: 1, allowHosts: ["*.example.com"] });
  await expectCodedRefusal(
    f.host({ HACK_NATIVE_ALLOW_HOSTS: "registry.example.com" }),
    "E_CONFIG_INVALID",
    "Native machine settings field allowHosts is invalid; values omitted."
  );
});

test("machine settings refuse unsupported fields, grants in other shapes and partial HTTPS", async () => {
  const cases: readonly [unknown, string][] = [
    [{ version: 2 }, "require version 1"],
    [
      { version: 1, gcloud: { applicationDefault: true } },
      "contain an unsupported field",
    ],
    [
      { version: 1, isolatedNetworks: ["shared"] },
      "contain an unsupported field",
    ],
    [{ version: 1, sharedSource: "1" }, "field sharedSource is invalid"],
    [
      { version: 1, dependencies: "../escape.json" },
      "field dependencies is invalid",
    ],
    [
      { version: 1, dependencies: "/abs/deps.json" },
      "field dependencies is invalid",
    ],
    [
      { version: 1, dependencies: "settings.json" },
      "field dependencies is invalid",
    ],
    [
      { version: 1, dependenciesByEnv: { QA: "deps.json" } },
      "field dependenciesByEnv is invalid",
    ],
    [
      { version: 1, https: { caddyBinary: "/opt/caddy", port: 443 } },
      "field https is invalid",
    ],
    [
      { version: 1, preparedBase: { mode: "always" } },
      "field preparedBase is invalid",
    ],
    [{ version: 1, aws: { region: "eu-west-1" } }, "field aws is invalid"],
  ];
  for (const [value, text] of cases) {
    const f = await fixture();
    await f.machine(value);
    await expectCodedRefusal(f.host(), "E_CONFIG_INVALID", text);
  }
});

test("machine settings require a private directory and an owner-only regular file", async () => {
  const f = await fixture();
  await f.machine({ version: 1, sharedSource: true }, 0o644);
  await expectCodedRefusal(
    f.host(),
    "E_CONFIG_INVALID",
    "Native machine settings file must be a bounded owner-only (mode 0600) regular JSON file; values omitted."
  );
  await chmod(join(f.machineDir, "settings.json"), 0o600);
  await chmod(f.machineDir, 0o755);
  await expectCodedRefusal(
    f.host(),
    "E_CONFIG_INVALID",
    "Native machine settings directory must be a real directory owned by the current user with mode 0700; values omitted."
  );
  await chmod(f.machineDir, 0o700);
  // Another user's directory refuses (simulated with an injected uid).
  await expectCodedRefusal(
    resolveNativeHostSettings({
      env: f.env,
      projectName: "settings-fixture",
      projectRoot: f.projectRoot,
      uid: UID + 1,
    }),
    "E_CONFIG_INVALID",
    "owned by the current user"
  );
  // A hard link or symlink to the settings file refuses.
  const original = join(f.root, "settings-original.json");
  await writeFile(original, JSON.stringify({ version: 1 }), { mode: 0o600 });
  await rm(join(f.machineDir, "settings.json"));
  await link(original, join(f.machineDir, "settings.json"));
  await expectCodedRefusal(f.host(), "E_CONFIG_INVALID", "owner-only");
  await rm(join(f.machineDir, "settings.json"));
  await symlink(original, join(f.machineDir, "settings.json"));
  await expectCodedRefusal(f.host(), "E_CONFIG_INVALID", "owner-only");
});

test("machine settings inside the project root refuse, so no project share can reach them", async () => {
  const f = await fixture();
  const env = { HOME: f.home, XDG_CONFIG_HOME: join(f.projectRoot, "config") };
  const directory = nativeMachineSettingsDirectory({
    env,
    projectName: "settings-fixture",
  });
  expect(directory).toBe(
    join(f.projectRoot, "config", "hack", "native", "settings-fixture")
  );
  await mkdir(directory ?? "", { recursive: true, mode: 0o700 });
  await writeFile(
    join(directory ?? "", "settings.json"),
    JSON.stringify({ version: 1, sharedSource: true }),
    { mode: 0o600 }
  );
  await expectCodedRefusal(
    resolveNativeHostSettings({
      env,
      projectName: "settings-fixture",
      projectRoot: f.projectRoot,
      uid: UID,
    }),
    "E_CONFIG_INVALID",
    "Native machine settings directory must be outside the project root; values omitted."
  );
});

test("the machine directory follows XDG_CONFIG_HOME, then HOME, and a sanitized project name", () => {
  expect(
    nativeMachineSettingsDirectory({
      env: { HOME: "/home/dev", XDG_CONFIG_HOME: "/cfg" },
      projectName: "My App",
    })
  ).toBe("/cfg/hack/native/my-app");
  expect(
    nativeMachineSettingsDirectory({
      env: { HOME: "/home/dev", XDG_CONFIG_HOME: "relative" },
      projectName: "app",
    })
  ).toBe("/home/dev/.config/hack/native/app");
});

test("a machine preparedBase of off is a machine choice that selects nothing", async () => {
  const f = await fixture();
  await f.machine({ version: 1, preparedBase: { mode: "off" } });
  const host = await f.host();
  expect(host.preparedBase).toBeUndefined();
  expect(host.origins.preparedBase).toBe("machine");
});
