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
import { join } from "node:path";
import { prepareNativeProjectInput } from "../src/backends/native-project-input.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});
async function fixture(compose: unknown) {
  const projectRoot = await realpath(
    await mkdtemp(join(tmpdir(), "native-input-"))
  );
  roots.push(projectRoot);
  const projectDir = join(projectRoot, ".hack");
  await mkdir(projectDir);
  const composeFile = join(projectDir, "docker-compose.yml");
  await writeFile(composeFile, JSON.stringify(compose));
  return { projectRoot, projectDir, composeFile };
}
async function env(dir: string, name: string, values: unknown) {
  await writeFile(
    join(dir, `hack.env.${name}.yaml`),
    JSON.stringify({
      version: 1,
      environment: name,
      secretsprovider: "project_key",
      values,
    })
  );
}
test("modern values stay private while original contracts and exact input hash survive", async () => {
  const original = {
    name: "demo",
    services: {
      api: {
        image: "bun:1",
        environment: ["KEEP=tracked", "TOKEN=placeholder"],
        volumes: ["../:/app:ro"],
        extra_hosts: ["db:host-gateway"],
        build: { context: ".." },
        ports: ["3000:3000"],
      },
    },
    networks: { default: { internal: true } },
  };
  const opts = await fixture(original);
  await env(opts.projectDir, "default", {
    global: { TOKEN: "synthetic-private" },
    host: { HOST_ONLY: "host-private" },
  });
  const before = await readFile(opts.composeFile);
  const names = await readdir(opts.projectDir);
  const result = await prepareNativeProjectInput(opts);
  const parsed = JSON.parse(result.normalizedComposeJson);
  expect(parsed.services.api).toEqual({
    ...original.services.api,
    environment: { KEEP: "tracked", TOKEN: null },
  });
  expect(parsed.networks).toEqual(original.networks);
  expect(result.originalSha256).toBe(
    createHash("sha256").update(before).digest("hex")
  );
  expect(result.normalizedComposeJson).not.toContain("synthetic-private");
  expect(result.normalizedComposeJson).not.toContain("host-private");
  expect(result.managedEnvironment.api?.TOKEN).toBe("synthetic-private");
  expect(result.lifecycleHostEnvironment.HOST_ONLY).toBe("host-private");
  expect(await readFile(opts.composeFile)).toEqual(before);
  expect(await readdir(opts.projectDir)).toEqual(names);
});
test("fourteen services and 110 managed variables each preserve overlay selection", async () => {
  const services = Object.fromEntries(
    Array.from({ length: 14 }, (_, i) => [`service${i}`, { image: "bun:1" }])
  );
  const opts = await fixture({ services });
  const values = Object.fromEntries(
    Array.from({ length: 110 }, (_, i) => [`KEY_${i}`, `synthetic-${i}`])
  );
  await env(opts.projectDir, "default", { global: values });
  await env(opts.projectDir, "qa", { global: { KEY_0: "overlay-value" } });
  const result = await prepareNativeProjectInput({ ...opts, envName: "qa" });
  expect(result.effectiveEnvName).toBe("qa");
  expect(Object.keys(result.managedEnvironment)).toHaveLength(14);
  for (const value of Object.values(result.managedEnvironment)) {
    expect(Object.keys(value)).toHaveLength(110);
    expect(value.KEY_0).toBe("overlay-value");
  }
  expect(result.normalizedComposeJson).not.toContain("synthetic-");
  expect(result.normalizedComposeJson).not.toContain("overlay-value");
});
test("env_file and malformed modern input refuse without diagnostic contents", async () => {
  const opts = await fixture({
    services: { api: { env_file: "private-source", image: "bun:1" } },
  });
  await env(opts.projectDir, "default", {
    global: { TOKEN: { secure: "invalid-secret-canary" } },
  });
  await expect(prepareNativeProjectInput(opts)).rejects.toThrow(
    "values omitted"
  );
  await writeFile(opts.composeFile, '{"services":{"api":{"image":"bun:1"}}}');
  await writeFile(
    join(opts.projectDir, "hack.env.default.yaml"),
    "secret-canary: ["
  );
  try {
    await prepareNativeProjectInput(opts);
    throw new Error("unexpected success");
  } catch (error) {
    expect(String(error)).not.toContain("secret-canary");
    expect(String(error)).toContain("values omitted");
  }
});
test("legacy dotenv refuses and unmanaged public projects preserve original fields", async () => {
  const original = {
    services: { api: { image: "bun:1", environment: { STATIC: "tracked" } } },
  };
  const opts = await fixture(original);
  expect(
    JSON.parse((await prepareNativeProjectInput(opts)).normalizedComposeJson)
  ).toEqual(original);
  await writeFile(join(opts.projectDir, ".env"), "PRIVATE=synthetic\n");
  await expect(prepareNativeProjectInput(opts)).rejects.toThrow(
    "values omitted"
  );
});

test("linked worktree inherits primary local environment and observes checkout overrides", async () => {
  const oldCI = process.env.CI;
  const oldMode = process.env.HACK_EXECUTION_MODE;
  const opts = await fixture({ services: { api: { image: "bun:1" } } });
  const git = async (args: string[]) => {
    const child = Bun.spawn(["git", ...args], {
      cwd: opts.projectRoot,
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await child.exited).toBe(0);
  };
  const linked = `${opts.projectRoot}-linked`;
  roots.push(linked);
  try {
    process.env.CI = undefined;
    process.env.HACK_EXECUTION_MODE = undefined;
    await writeFile(
      join(opts.projectDir, "hack.config.json"),
      '{"name":"native-test"}'
    );
    await env(opts.projectDir, "default", { global: { VALUE: "tracked" } });
    await git(["init", "-b", "main"]);
    await git(["add", "."]);
    await git([
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    await git(["worktree", "add", "-b", "linked", linked]);
    await env(opts.projectDir, "local", {
      global: { VALUE: "inherited-private" },
    });
    const childOpts = {
      projectRoot: linked,
      projectDir: join(linked, ".hack"),
      composeFile: join(linked, ".hack/docker-compose.yml"),
    };
    expect(
      (await prepareNativeProjectInput(childOpts)).managedEnvironment.api?.VALUE
    ).toBe("inherited-private");
    await env(opts.projectDir, "local", {
      global: { VALUE: "updated-private" },
    });
    expect(
      (await prepareNativeProjectInput(childOpts)).managedEnvironment.api?.VALUE
    ).toBe("updated-private");
    await env(childOpts.projectDir, "local", {
      global: { VALUE: "checkout-private" },
    });
    const result = await prepareNativeProjectInput(childOpts);
    expect(result.managedEnvironment.api?.VALUE).toBe("checkout-private");
    expect(result.environmentFiles).toContain(
      join(opts.projectDir, "hack.env.local.yaml")
    );
    expect(result.normalizedComposeJson).not.toContain("private");
  } finally {
    process.env.CI = oldCI;
    process.env.HACK_EXECUTION_MODE = oldMode;
  }
});
