import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptNativeProject } from "../src/backends/native-project-adaptation.ts";
import {
  nativeProjectBranchArgs,
  prepareNativeProjectBranch,
} from "../src/backends/native-project-branch.ts";
import { prepareNativeProjectInput } from "../src/backends/native-project-input.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture(
  options: { hosts?: string; devHost?: string; list?: boolean } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "native-branch-plan-"));
  roots.push(root);
  const projectDir = join(root, ".hack");
  await mkdir(projectDir);
  const composeFile = join(projectDir, "docker-compose.yml");
  const hosts =
    options.hosts ??
    "app.hack.local, api.app.hack.local app.hack, app.hack.gy, foreign.example";
  const labels = options.list
    ? [
        `caddy=${hosts}`,
        "caddy.tls=internal",
        "caddy.reverse_proxy={{upstreams 3000}}",
      ]
    : {
        caddy: hosts,
        "caddy.tls": "internal",
        "caddy.reverse_proxy": "{{upstreams 3000}}",
      };
  await writeFile(
    composeFile,
    JSON.stringify({
      services: {
        web: { image: "example", labels, environment: ["KEEP=public"] },
      },
    })
  );
  const configFile = join(projectDir, "hack.config.json");
  await writeFile(
    configFile,
    JSON.stringify({
      dev_host: options.devHost ?? "app.hack.local",
      oauth: { enabled: true },
    })
  );
  await writeFile(
    join(projectDir, "hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { global: { TOKEN: "synthetic-private-value" } },
    })
  );
  const input = await prepareNativeProjectInput({
    projectRoot: root,
    projectDir,
    composeFile,
  });
  return {
    input,
    composeFile,
    configFile,
    scope: {
      projectRoot: root,
      projectDir,
      nativeHome: join(root, "unused"),
      branch: "feature-a",
    },
  };
}

for (const list of [false, true]) {
  test(`branch rewrites managed and legacy hosts while preserving original input (list=${list})`, async () => {
    const f = await fixture({ list });
    const before = await readFile(f.composeFile);
    const files = await readdir(f.scope.projectDir);
    const result = await prepareNativeProjectBranch(f);
    const compose = JSON.parse(result.normalizedComposeJson);
    expect(compose.services.web.labels.caddy).toBe(
      "feature-a.app.hack.local, api.feature-a.app.hack.local, feature-a.app.hack, feature-a.app.hack.gy, foreign.example"
    );
    expect(compose.services.web.labels["caddy.reverse_proxy"]).toBe(
      "{{upstreams 3000}}"
    );
    expect(compose.services.web.environment).toEqual({
      KEEP: "public",
      TOKEN: null,
    });
    expect(result.originalSha256).toBe(f.input.originalSha256);
    expect(result.managedEnvironment).toBe(f.input.managedEnvironment);
    expect(result.lifecycleHostEnvironment).toBe(
      f.input.lifecycleHostEnvironment
    );
    expect(result.normalizedComposeJson).not.toContain(
      "synthetic-private-value"
    );
    expect(await readFile(f.composeFile)).toEqual(before);
    expect(await readdir(f.scope.projectDir)).toEqual(files);
    expect(
      JSON.parse(f.input.normalizedComposeJson).services.web.labels
    ).not.toEqual(compose.services.web.labels);
  });
}

test("adaptation-added aliases are branched with the original routes", async () => {
  const f = await fixture({ hosts: "app.hack.local" });
  const input = adaptNativeProject({
    input: f.input,
    selection: {
      version: 1,
      additionalHostnames: { web: ["app.hack.gy"] },
    },
  });
  const result = await prepareNativeProjectBranch({ ...f, input });
  expect(
    JSON.parse(result.normalizedComposeJson).services.web.labels.caddy
  ).toBe("feature-a.app.hack.local, feature-a.app.hack.gy");
});

test("custom hosts branch by the configured base and don't claim foreign names", async () => {
  const f = await fixture({
    devHost: "app.dev.example",
    hosts: "app.dev.example, api.app.dev.example, app.hack.gy",
  });
  const result = await prepareNativeProjectBranch(f);
  expect(
    JSON.parse(result.normalizedComposeJson).services.web.labels.caddy
  ).toBe(
    "feature-a.app.dev.example, api.feature-a.app.dev.example, app.hack.gy"
  );
});

test("base selection is byte-identical and does not require branch configuration", async () => {
  const f = await fixture();
  await rm(f.configFile);
  expect(
    await prepareNativeProjectBranch({
      ...f,
      scope: { ...f.scope, branch: null },
    })
  ).toBe(f.input);
  expect(nativeProjectBranchArgs(null)).toEqual([]);
  expect(nativeProjectBranchArgs()).toEqual([]);
});

test("invalid branch selectors and missing or malformed config refuse", async () => {
  const f = await fixture();
  for (const branch of [
    "",
    "feature/one",
    "UPPER",
    "x.y",
    "-leading",
    "trailing-",
    "x".repeat(64),
  ]) {
    expect(() => nativeProjectBranchArgs(branch)).toThrow("canonical branch");
  }
  await writeFile(f.configFile, "{");
  await expect(prepareNativeProjectBranch(f)).rejects.toThrow(
    "valid project host"
  );
  await rm(f.configFile);
  await expect(prepareNativeProjectBranch(f)).rejects.toThrow(
    "valid project host"
  );
});

test("foreign context and ambiguous route labels refuse", async () => {
  const f = await fixture();
  await expect(
    prepareNativeProjectBranch({
      ...f,
      composeFile: join(f.scope.projectRoot, "other.yml"),
    })
  ).rejects.toThrow("valid project host");
  for (const labels of [
    ["caddy=app.hack.local", "caddy=other.example"],
    { caddy: 123 },
  ]) {
    const compose = JSON.parse(f.input.normalizedComposeJson);
    compose.services.web.labels = labels;
    await expect(
      prepareNativeProjectBranch({
        ...f,
        input: { ...f.input, normalizedComposeJson: JSON.stringify(compose) },
      })
    ).rejects.toThrow("valid project host");
  }
});

test("fresh branch inputs produce different public plans without changing source or private values", async () => {
  const f = await fixture();
  const a = await prepareNativeProjectBranch(f);
  const b = await prepareNativeProjectBranch({
    ...f,
    scope: { ...f.scope, branch: "feature-b" },
  });
  expect(a.originalSha256).toBe(b.originalSha256);
  expect(a.normalizedComposeJson).not.toBe(b.normalizedComposeJson);
  expect(a.managedEnvironment).toBe(b.managedEnvironment);
  expect(nativeProjectBranchArgs("feature-a")).toEqual([
    "--branch",
    "feature-a",
  ]);
});
