import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  assertGlobalBackendStartAllowed,
  globalDnsRecoveryAllowed,
  globalLoggingUpArguments,
  globalRoutingUpArguments,
} from "../src/commands/global-autostart.ts";
import {
  GLOBAL_ALLOY_FILENAME,
  GLOBAL_BRANCHES_SCHEMA_FILENAME,
  GLOBAL_CADDY_COMPOSE_FILENAME,
  GLOBAL_CADDY_DIR_NAME,
  GLOBAL_CONFIG_SCHEMA_FILENAME,
  GLOBAL_COREDNS_FILENAME,
  GLOBAL_ENV_SCHEMA_FILENAME,
  GLOBAL_GRAFANA_DASHBOARD_FILENAME,
  GLOBAL_GRAFANA_DASHBOARDS_DIR,
  GLOBAL_GRAFANA_DASHBOARDS_PROVISIONING_FILENAME,
  GLOBAL_GRAFANA_DATASOURCE_FILENAME,
  GLOBAL_LOGGING_COMPOSE_FILENAME,
  GLOBAL_LOGGING_DIR_NAME,
  GLOBAL_LOKI_CONFIG_FILENAME,
  GLOBAL_MANAGED_ENV_SCHEMA_FILENAME,
  GLOBAL_SCHEMAS_DIR_NAME,
} from "../src/constants.ts";
import { secureAutostartRoutingAssets } from "../src/lib/autostart-routing-assets.ts";
import {
  renderGlobalAlloyConfig,
  renderGlobalCaddyCompose,
  renderGlobalCoreDnsConfig,
  renderGlobalGrafanaDashboardsProvisioningYaml,
  renderGlobalGrafanaDatasourceYaml,
  renderGlobalGrafanaLogsDashboardJson,
  renderGlobalLoggingCompose,
  renderGlobalLokiConfigYaml,
  renderProjectBranchesSchemaJson,
  renderProjectConfigSchemaJson,
  renderProjectEnvSchemaJson,
  renderProjectManagedEnvSchemaJson,
} from "../src/templates.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

let root = "";
let assets: Map<string, string>;
const defaultDomain = "example.test";
const bindAddress = "127.0.0.1";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-routing-assets-"));
  const caddy = join(root, GLOBAL_CADDY_DIR_NAME);
  const logging = join(root, GLOBAL_LOGGING_DIR_NAME);
  const schemas = join(root, GLOBAL_SCHEMAS_DIR_NAME);
  assets = new Map([
    [
      join(caddy, GLOBAL_CADDY_COMPOSE_FILENAME),
      renderGlobalCaddyCompose({ bindAddress }),
    ],
    [
      join(caddy, GLOBAL_COREDNS_FILENAME),
      renderGlobalCoreDnsConfig({ defaultDomain }),
    ],
    [
      join(logging, GLOBAL_LOGGING_COMPOSE_FILENAME),
      renderGlobalLoggingCompose(),
    ],
    [join(logging, GLOBAL_ALLOY_FILENAME), renderGlobalAlloyConfig()],
    [join(logging, GLOBAL_LOKI_CONFIG_FILENAME), renderGlobalLokiConfigYaml()],
    [
      join(logging, GLOBAL_GRAFANA_DATASOURCE_FILENAME),
      renderGlobalGrafanaDatasourceYaml(),
    ],
    [
      join(logging, GLOBAL_GRAFANA_DASHBOARDS_PROVISIONING_FILENAME),
      renderGlobalGrafanaDashboardsProvisioningYaml(),
    ],
    [
      join(logging, GLOBAL_GRAFANA_DASHBOARD_FILENAME),
      renderGlobalGrafanaLogsDashboardJson(),
    ],
    [
      join(schemas, GLOBAL_CONFIG_SCHEMA_FILENAME),
      renderProjectConfigSchemaJson(),
    ],
    [join(schemas, GLOBAL_ENV_SCHEMA_FILENAME), renderProjectEnvSchemaJson()],
    [
      join(schemas, GLOBAL_MANAGED_ENV_SCHEMA_FILENAME),
      renderProjectManagedEnvSchemaJson(),
    ],
    [
      join(schemas, GLOBAL_BRANCHES_SCHEMA_FILENAME),
      renderProjectBranchesSchemaJson(),
    ],
  ]);
  for (const [path, text] of assets) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, text, { mode: 0o664 });
    await chmod(path, 0o664);
  }
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function secure(): Promise<void> {
  await secureAutostartRoutingAssets({ root, bindAddress, defaultDomain });
}

function caddyCompose() {
  return join(root, GLOBAL_CADDY_DIR_NAME, GLOBAL_CADDY_COMPOSE_FILENAME);
}

test("login routing recreates mounts and ignores env files while manual routing keeps its arguments", () => {
  const manual = [
    "docker",
    "compose",
    "-f",
    "/example/compose.yml",
    "up",
    "-d",
    "--remove-orphans",
  ];
  expect(
    globalRoutingUpArguments({
      composeFile: "/example/compose.yml",
      login: false,
    })
  ).toEqual(manual);
  const login = globalRoutingUpArguments({
    composeFile: "/example/compose.yml",
    login: true,
  });
  expect(login).toContain("--force-recreate");
  expect(login.slice(2, 4)).toEqual(["--env-file", "/dev/null"]);
});

test("source global up refuses poisoned login assets before any Docker effect", async () => {
  await writeFile(
    caddyCompose(),
    "services:\n  attack:\n    image: attacker.invalid/example\n"
  );
  const config = join(root, "hack.config.json");
  await writeFile(
    config,
    JSON.stringify({
      default_domain: defaultDomain,
      proxy: { bind_address: bindAddress },
    })
  );
  const bin = join(root, "bin");
  await mkdir(bin, { mode: 0o700 });
  const docker = join(bin, "docker");
  await writeFile(
    docker,
    '#!/bin/sh\n: > "$HACK_TEST_DOCKER_SENTINEL"\nexit 0\n',
    { mode: 0o700 }
  );
  const sentinel = join(root, "docker-was-called");
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      resolve("index.ts"),
      "global",
      "up",
      "--no-interactive",
    ],
    {
      env: privateCliEnv({
        root,
        env: {
          PATH: bin,
          HACK_GLOBAL_CONFIG_PATH: config,
          HACK_AUTOSTART_LOGIN: "1",
          HACK_TEST_DOCKER_SENTINEL: sentinel,
        },
      }),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    }
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(code).not.toBe(0);
    expect(stdout + stderr).toContain("Automatic routing refused");
    expect(await Bun.file(sentinel).exists()).toBe(false);
  } finally {
    clearTimeout(timer);
  }
});

test("canonical nonsecret assets use fresh read-only-to-others inodes readable by container service users", async () => {
  const previous = new Map<string, number>();
  for (const path of assets.keys()) {
    previous.set(path, (await lstat(path)).ino);
  }
  await secure();
  for (const [path, text] of assets) {
    expect(await readFile(path, "utf8")).toBe(text);
    expect((await lstat(path)).mode & 0o777).toBe(0o644);
    expect((await lstat(path)).ino).not.toBe(previous.get(path));
  }
});

test("publication stages outside mounted directories and preserves their exact entries throughout", async () => {
  const mounted = [
    join(root, GLOBAL_SCHEMAS_DIR_NAME),
    join(root, GLOBAL_LOGGING_DIR_NAME, GLOBAL_GRAFANA_DASHBOARDS_DIR),
  ];
  const expected = await Promise.all(
    mounted.map(async (path) => (await readdir(path)).sort())
  );
  const staged: string[] = [];
  await secureAutostartRoutingAssets({
    root,
    bindAddress,
    defaultDomain,
    beforePublish: async ({ stagingPath, targetPath }) => {
      staged.push(stagingPath);
      expect(dirname(stagingPath)).toBe(root);
      expect((await lstat(stagingPath)).dev).toBe(
        (await lstat(targetPath)).dev
      );
      for (const [index, path] of mounted.entries()) {
        const expectedNames = expected[index];
        if (!expectedNames) {
          throw new Error("Missing mounted-directory expectation");
        }
        expect((await readdir(path)).sort()).toEqual(expectedNames);
      }
    },
  });
  expect(staged).toHaveLength(assets.size);
  for (const path of staged) {
    expect(await Bun.file(path).exists()).toBe(false);
  }
});

test("SIGKILL during schema staging leaves only an ignored root file and the next login can authenticate", async () => {
  const schemas = join(root, GLOBAL_SCHEMAS_DIR_NAME);
  const dashboards = join(
    root,
    GLOBAL_LOGGING_DIR_NAME,
    GLOBAL_GRAFANA_DASHBOARDS_DIR
  );
  const schemaEntries = (await readdir(schemas)).sort();
  const dashboardEntries = (await readdir(dashboards)).sort();
  const marker = join(root, "staging-interruption-observed");
  const script = `import { secureAutostartRoutingAssets } from ${JSON.stringify(resolve("src/lib/autostart-routing-assets.ts"))};\nawait secureAutostartRoutingAssets({root:${JSON.stringify(root)},bindAddress:${JSON.stringify(bindAddress)},defaultDomain:${JSON.stringify(defaultDomain)},beforePublish:async({stagingPath,targetPath})=>{if(targetPath===${JSON.stringify(join(schemas, GLOBAL_CONFIG_SCHEMA_FILENAME))}){await Bun.write(${JSON.stringify(marker)},stagingPath);process.kill(process.pid,"SIGKILL");}}});`;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", script], {
    env: privateCliEnv({ root }),
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    const [code, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);
    expect(code, stderr).toBe(137);
    expect(child.signalCode).toBe("SIGKILL");
  } finally {
    clearTimeout(timer);
  }
  const staging = await Bun.file(marker).text();
  expect(dirname(staging)).toBe(root);
  expect(await Bun.file(staging).exists()).toBe(true);
  const stagedBytes = await Bun.file(staging).text();
  expect((await readdir(schemas)).sort()).toEqual(schemaEntries);
  expect((await readdir(dashboards)).sort()).toEqual(dashboardEntries);
  await secure();
  expect(await Bun.file(staging).text()).toBe(stagedBytes);
  expect((await readdir(schemas)).sort()).toEqual(schemaEntries);
  expect((await readdir(dashboards)).sort()).toEqual(dashboardEntries);
});

test("current renderer static address variants and IPv6 bind settings are authenticated", async () => {
  for (const useStaticCoreDnsIp of [false, true]) {
    for (const useStaticCaddyIp of [false, true]) {
      await writeFile(
        caddyCompose(),
        renderGlobalCaddyCompose({
          bindAddress: "::1",
          useStaticCoreDnsIp,
          useStaticCaddyIp,
        })
      );
      await writeFile(
        join(root, GLOBAL_CADDY_DIR_NAME, GLOBAL_COREDNS_FILENAME),
        renderGlobalCoreDnsConfig({ defaultDomain, useStaticCaddyIp })
      );
      await secureAutostartRoutingAssets({
        root,
        bindAddress: "::1",
        defaultDomain,
      });
    }
  }
});

test("poisoned Compose refuses before any matching asset is republished and errors omit values", async () => {
  const untouched = join(root, GLOBAL_LOGGING_DIR_NAME, GLOBAL_ALLOY_FILENAME);
  const before = (await lstat(untouched)).ino;
  await writeFile(
    caddyCompose(),
    "services: { injected: { image: private-sentinel } }"
  );
  let error: unknown;
  try {
    await secure();
  } catch (failure) {
    error = failure;
  }
  expect(error).toMatchObject({
    code: "E_PERMISSION",
    detail: { reason: "routing_assets_untrusted" },
  });
  expect(String(error)).not.toContain("private-sentinel");
  expect(String(error)).not.toContain(root);
  expect((await lstat(untouched)).ino).toBe(before);
});

test("a descriptor retained on an old writable inode cannot alter the authenticated replacement", async () => {
  const path = caddyCompose();
  const original = assets.get(path);
  if (original === undefined) {
    throw new Error("Missing fixture asset");
  }
  const old = await open(path, "r+");
  try {
    await secure();
    await old.write(
      Buffer.from("untrusted retained descriptor"),
      0,
      "untrusted retained descriptor".length,
      0
    );
    await old.sync();
    expect(await readFile(path, "utf8")).toBe(original);
    expect((await old.stat()).ino).not.toBe((await lstat(path)).ino);
  } finally {
    await old.close();
  }
});

test("file and mounted directory symlinks are refused without modifying their targets", async () => {
  const path = caddyCompose();
  const target = join(root, "saved-compose");
  await writeFile(target, assets.get(path) ?? "");
  await rm(path);
  await symlink(target, path);
  await expect(secure()).rejects.toMatchObject({ code: "E_PERMISSION" });
  expect(await readFile(target, "utf8")).toBe(assets.get(path) ?? "");
  await rm(path);
  await writeFile(path, assets.get(path) ?? "");
  const schemas = join(root, GLOBAL_SCHEMAS_DIR_NAME);
  const moved = join(root, "saved-schemas");
  await mkdir(moved, { mode: 0o700 });
  await rm(schemas, { recursive: true });
  await symlink(moved, schemas);
  await expect(secure()).rejects.toMatchObject({ code: "E_PERMISSION" });
  expect(await readdir(moved)).toEqual([]);
});

test("unsafe directory modes refuse read-only with no automatic chmod", async () => {
  const schemas = join(root, GLOBAL_SCHEMAS_DIR_NAME);
  await chmod(schemas, 0o777);
  await expect(secure()).rejects.toMatchObject({ code: "E_PERMISSION" });
  expect((await lstat(schemas)).mode & 0o777).toBe(0o777);
});

test("a mismatched current owner cannot authenticate the installed assets", async () => {
  const getuid = process.getuid;
  if (!getuid) {
    throw new Error("UID unavailable");
  }
  try {
    process.getuid = () => getuid() + 1;
    await expect(secure()).rejects.toMatchObject({ code: "E_PERMISSION" });
  } finally {
    process.getuid = getuid;
  }
});

test("missing assets are never created and unknown mounted content is refused", async () => {
  const missing = join(root, GLOBAL_LOGGING_DIR_NAME, GLOBAL_ALLOY_FILENAME);
  await rm(missing);
  await expect(secure()).rejects.toMatchObject({ code: "E_PERMISSION" });
  expect(await Bun.file(missing).exists()).toBe(false);
  await writeFile(missing, assets.get(missing) ?? "");
  await writeFile(join(root, GLOBAL_SCHEMAS_DIR_NAME, "unknown.json"), "{}");
  await expect(secure()).rejects.toMatchObject({ code: "E_PERMISSION" });
  await rm(root, { recursive: true });
  await expect(secure()).rejects.toMatchObject({ code: "E_PERMISSION" });
  expect(await Bun.file(root).exists()).toBe(false);
});

test("login plans routing without starting default-credential logging services", () => {
  const composeFile = "/example/logging/compose.yml";
  expect(globalLoggingUpArguments({ composeFile, login: true })).toBeNull();
  expect(
    globalRoutingUpArguments({
      composeFile: "/example/caddy/compose.yml",
      login: true,
    })
  ).toContain("--force-recreate");
  expect(globalLoggingUpArguments({ composeFile, login: false })).toEqual([
    "docker",
    "compose",
    "-f",
    composeFile,
    "up",
    "-d",
    "--remove-orphans",
  ]);
});

test("login refuses passwordless DNS recovery while manual starts retain it", () => {
  expect(globalDnsRecoveryAllowed({ login: true })).toBe(false);
  expect(globalDnsRecoveryAllowed({ login: false })).toBe(true);
});

test("an unavailable engine at login refuses backend startup while manual startup remains allowed", () => {
  expect(() => assertGlobalBackendStartAllowed({ login: true })).toThrow(
    "start the engine manually"
  );
  expect(() => assertGlobalBackendStartAllowed({ login: false })).not.toThrow();
});
