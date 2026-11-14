import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import {
  type AutostartStartPolicyOptions,
  assertAutostartStartPolicy,
  autostartStartPolicyRefusal,
} from "../src/lib/autostart-start-policy.ts";

let root = "";
let opts: AutostartStartPolicyOptions;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-start-policy-"));
  const repoRoot = join(root, "project");
  const projectDir = join(repoRoot, ".hack");
  await mkdir(projectDir, { recursive: true, mode: 0o700 });
  opts = {
    repoRoot,
    projectDir,
    projectDirName: ".hack",
    globalConfigPath: join(root, "global.json"),
  };
  await writeFile(
    join(projectDir, "docker-compose.yml"),
    YAML.stringify({
      services: { web: { image: "example/web:1", command: ["serve"] } },
    }),
    { mode: 0o600 }
  );
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function config(value: unknown) {
  await writeFile(
    join(opts.projectDir, "hack.config.json"),
    JSON.stringify(value),
    { mode: 0o600 }
  );
}
async function compose(value: unknown) {
  await writeFile(
    join(opts.projectDir, "docker-compose.yml"),
    YAML.stringify(value),
    { mode: 0o600 }
  );
}
async function layer(value: unknown, name = "hack.env.default.yaml") {
  await writeFile(join(opts.projectDir, name), YAML.stringify(value), {
    mode: 0o600,
  });
}
async function snapshot(directory: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name)
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      result.push(
        ...(await snapshot(path)).map((value) => `${entry.name}/${value}`)
      );
    } else {
      result.push(
        `${entry.name}:${(await stat(path)).mode}:${await readFile(path, "base64")}`
      );
    }
  }
  return result;
}

test("simple image-only Compose and local encrypted app env pass without changing any input", async () => {
  await config({ name: "example", lifecycle: {} });
  await layer({
    version: 1,
    environment: "default",
    secretsprovider: "project_key",
    values: {
      global: {
        APP_MODE: "local",
        APP_TOKEN: { secure: "opaque-ciphertext-not-resolved" },
      },
      web: { PORT: 3000 },
    },
  });
  await writeFile(join(opts.projectDir, ".env.state.json"), "{}", {
    mode: 0o600,
  });
  const before = await snapshot(root);
  expect(await autostartStartPolicyRefusal(opts)).toBeNull();
  await expect(assertAutostartStartPolicy(opts)).resolves.toBeUndefined();
  expect(await snapshot(root)).toEqual(before);
});

test("startup aliases, lifecycle phases, processes and shared helpers require manual starts", async () => {
  for (const value of [
    { startup: [{ run: "synthetic-command" }] },
    { lifecycle: { up: { before: ["synthetic-command"] } } },
    { lifecycle: { down: { after: ["synthetic-command"] } } },
    {
      lifecycle: {
        processes: [{ name: "tunnel", command: "synthetic-command" }],
      },
    },
    {
      lifecycle: {
        sharedHelpers: [
          {
            name: "helper",
            command: "synthetic-command",
            port: 1234,
            upstream: "http://127.0.0.1:1234",
          },
        ],
      },
    },
  ]) {
    await config(value);
    expect(await autostartStartPolicyRefusal(opts)).not.toBeNull();
    await expect(assertAutostartStartPolicy(opts)).rejects.toMatchObject({
      code: "E_PERMISSION",
    });
  }
});

test("legacy TOML startup is checked by the same canonical parser", async () => {
  await writeFile(
    join(opts.projectDir, "hack.toml"),
    'name = "example"\n[[startup]]\nrun = "synthetic-command"\n',
    { mode: 0o600 }
  );
  expect(await autostartStartPolicyRefusal(opts)).toBe(
    "host_commands_require_manual_start"
  );
});

test("builds, ambiguous Compose graph sources, external providers and env files never start unattended", async () => {
  for (const [service, reason] of [
    [
      { image: "example/web:1", build: "." },
      "image_build_requires_manual_start",
    ],
    [
      { extends: { file: "other.yml", service: "web" } },
      "compose_inputs_require_manual_start",
    ],
    [
      { image: "example/web:1", env_file: ["app.env"] },
      "compose_inputs_require_manual_start",
    ],
    [
      { provider: { type: "command", command: "synthetic-command" } },
      "command_provider_requires_manual_start",
    ],
    [
      {
        image: "example/web:1",
        labels: { "hack.dependencies.bootstrap": "true" },
      },
      "host_commands_require_manual_start",
    ],
    [
      { image: "example/web:1", command: "npm install" },
      "host_commands_require_manual_start",
    ],
  ] as const) {
    await compose({ services: { web: service } });
    expect(await autostartStartPolicyRefusal(opts)).toBe(reason);
  }
  await compose({
    include: ["other.yml"],
    services: { web: { image: "example/web:1" } },
  });
  expect(await autostartStartPolicyRefusal(opts)).toBe(
    "compose_inputs_require_manual_start"
  );
});

test("global and project command/cloud provider declarations refuse without invocation", async () => {
  for (const value of [
    { env: { provider: { command: "synthetic-command" } } },
    {
      controlPlane: {
        secrets: { backend: "cloud", cloud: { provider: "aws" } },
      },
    },
  ]) {
    await config(value);
    expect(await autostartStartPolicyRefusal(opts)).toBe(
      "command_provider_requires_manual_start"
    );
  }
  await config({});
  await writeFile(
    opts.globalConfigPath ?? "",
    JSON.stringify({
      controlPlane: {
        secrets: { backend: "command", command: "synthetic-command" },
      },
    }),
    { mode: 0o600 }
  );
  expect(await autostartStartPolicyRefusal(opts)).toBe(
    "command_provider_requires_manual_start"
  );
});

test("unattended mounts allow default engine storage but refuse host files and indirect sources", async () => {
  await writeFile(join(opts.repoRoot, "start.sh"), "synthetic-code", {
    mode: 0o600,
  });
  await chmod(join(opts.repoRoot, "start.sh"), 0o666);
  for (const volumes of [
    ["../start.sh:/start.sh:ro"],
    [`${opts.repoRoot}/start.sh:/start.sh:ro`],
    [
      {
        type: "bind",
        source: "../start.sh",
        target: "/start.sh",
        read_only: true,
      },
    ],
    ["${MOUNT_SOURCE}:/start.sh"],
    [{ type: "image", source: "unverified/image", target: "/start.sh" }],
  ]) {
    await compose({
      services: {
        web: {
          image: "example/web:1",
          volumes,
          entrypoint: ["sh", "/start.sh"],
        },
      },
    });
    expect(await autostartStartPolicyRefusal(opts)).toBe(
      "compose_inputs_require_manual_start"
    );
  }
  for (const settings of [
    {
      volumes: {
        data: {
          driver_opts: { type: "none", o: "bind", device: opts.repoRoot },
        },
      },
    },
    { volumes: { data: { external: true } } },
    { volumes: { data: { name: "unverified-existing-volume" } } },
    { configs: { script: { file: "../start.sh" } } },
    { secrets: { script: { file: "../start.sh" } } },
  ]) {
    await compose({
      ...settings,
      services: { web: { image: "example/web:1" } },
    });
    expect(await autostartStartPolicyRefusal(opts)).toBe(
      "compose_inputs_require_manual_start"
    );
  }
  for (const settings of [
    { volumes_from: ["other"] },
    { label_file: "../labels" },
    { configs: ["script"] },
    { secrets: ["script"] },
  ]) {
    await compose({
      services: { web: { image: "example/web:1", ...settings } },
    });
    expect(await autostartStartPolicyRefusal(opts)).toBe(
      "compose_inputs_require_manual_start"
    );
  }
  await compose({
    volumes: { data: {}, cache: { driver: "local" } },
    services: {
      web: {
        image: "example/web:1",
        volumes: [
          "data:/data:ro",
          "/scratch",
          { type: "volume", source: "cache", target: "/cache" },
          { type: "tmpfs", target: "/tmp" },
        ],
      },
    },
  });
  expect(await autostartStartPolicyRefusal(opts)).toBeNull();
  expect((await stat(join(opts.repoRoot, "start.sh"))).mode & 0o777).toBe(
    0o666
  );
});

test("managed graph and process-control keys refuse by name even when ciphertext is opaque", async () => {
  for (const key of [
    "COMPOSE_PROFILES",
    "COMPOSE_FILE",
    "GIT_CONFIG_COUNT",
    "GIT_CONFIG_GLOBAL",
    "GIT_SSH_COMMAND",
    "DOCKER_HOST",
    "HOME",
    "XDG_CONFIG_HOME",
    "PYTHONHOME",
    "PATH",
    "LD_PRELOAD",
    "HACK_RUNTIME_BACKEND",
  ]) {
    await layer({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { global: { [key]: { secure: "opaque-never-decrypted" } } },
    });
    expect(await autostartStartPolicyRefusal(opts)).toBe(
      "compose_inputs_require_manual_start"
    );
  }
  await layer({
    version: 1,
    environment: "default",
    secretsprovider: "command",
    command: "synthetic-command",
    values: { global: {} },
  });
  expect(await autostartStartPolicyRefusal(opts)).toBe(
    "command_provider_requires_manual_start"
  );
});

test("invalid, oversized, symlinked and unsafe inputs refuse with value-free errors", async () => {
  await writeFile(
    join(opts.projectDir, "hack.config.json"),
    "private-sentinel",
    { mode: 0o600 }
  );
  await expect(assertAutostartStartPolicy(opts)).rejects.toMatchObject({
    code: "E_PERMISSION",
    detail: { reason: "compose_inputs_require_manual_start" },
  });
  try {
    await assertAutostartStartPolicy(opts);
  } catch (error) {
    expect(String(error)).not.toContain("private-sentinel");
    expect(String(error)).not.toContain(root);
  }
  await writeFile(
    join(opts.projectDir, "hack.config.json"),
    " ".repeat(1024 * 1024 + 1),
    { mode: 0o600 }
  );
  expect(await autostartStartPolicyRefusal(opts)).toBe(
    "compose_inputs_require_manual_start"
  );
  await rm(join(opts.projectDir, "hack.config.json"));
  const outside = join(root, "other.json");
  await writeFile(outside, "{}", { mode: 0o600 });
  await symlink(outside, join(opts.projectDir, "hack.config.json"));
  expect(await autostartStartPolicyRefusal(opts)).toBe(
    "compose_inputs_require_manual_start"
  );
  await rm(join(opts.projectDir, "hack.config.json"));
  await chmod(opts.projectDir, 0o777);
  expect(await autostartStartPolicyRefusal(opts)).toBe("checkout_untrusted");
});

test("legacy dotenv and contracts preserve the fixed pending migration refusal without changes", async () => {
  for (const name of [".env", "hack.env.json"]) {
    const path = join(opts.projectDir, name);
    const text =
      name === ".env"
        ? "SAMPLE_VALUE=private-sentinel"
        : JSON.stringify({ version: 1, vars: [] });
    await writeFile(path, text, { mode: 0o600 });
    expect(await autostartStartPolicyRefusal(opts)).toBe(
      "pending_env_migration"
    );
    await expect(assertAutostartStartPolicy(opts)).rejects.toMatchObject({
      code: "E_CONFIG_INVALID",
      message:
        "Autostart skipped: pending env migration. Run hack doctor --migrate-env-config.",
      detail: { reason: "pending_env_migration" },
    });
    expect(await readFile(path, "utf8")).toBe(text);
    await rm(path);
  }
});
