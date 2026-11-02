import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { YAML } from "bun";
import { prepareNativeProjectBranch } from "../src/backends/native-project-branch.ts";
import {
  type NativeProjectInput,
  prepareNativeProjectInput,
} from "../src/backends/native-project-input.ts";
import type { NativeProjectRun } from "../src/backends/native-project-run.ts";
import { nativeRuntimeMetadataSelected } from "../src/backends/native-project-start.ts";
import {
  applyNativeRuntimeMetadata,
  verifyNativeRuntimeMetadataRoutes,
} from "../src/backends/native-runtime-metadata.ts";
import { isRecord } from "../src/lib/guards.ts";
import {
  buildRuntimeHostMetadataOverride,
  type RuntimeHostMetadata,
} from "../src/lib/runtime-host-metadata.ts";
import { expectCodedThrow } from "./helpers/closed-refusal.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

const SELECTION = {
  devHost: "app.hack.local",
  aliasHost: "app.hack.gy",
  projectName: "app",
} as const;

function input(services: Record<string, unknown>): NativeProjectInput {
  return {
    originalSha256: "d".repeat(64),
    normalizedComposeJson: JSON.stringify({ services }),
    managedEnvironment: {},
    lifecycleHostEnvironment: {},
    effectiveEnvName: null,
    environmentFiles: [],
    serviceNames: Object.keys(services),
  };
}

function environment(
  result: NativeProjectInput,
  service: string
): Record<string, unknown> {
  const compose: unknown = JSON.parse(result.normalizedComposeJson);
  if (!(isRecord(compose) && isRecord(compose.services))) {
    throw new Error("missing services");
  }
  const selected = compose.services[service];
  if (!(isRecord(selected) && isRecord(selected.environment))) {
    throw new Error(`missing ${service} environment`);
  }
  return selected.environment;
}

function metadata(env: Record<string, unknown>): RuntimeHostMetadata {
  return JSON.parse(String(env.HACK_RUNTIME_METADATA)) as RuntimeHostMetadata;
}

async function project() {
  const root = await mkdtemp(join(tmpdir(), "native-runtime-metadata-"));
  roots.push(root);
  const projectDir = join(root, ".hack");
  await mkdir(projectDir);
  const composeFile = join(projectDir, "docker-compose.yml");
  await writeFile(
    composeFile,
    JSON.stringify({
      services: {
        web: {
          image: "example",
          environment: ["KEEP=public"],
          labels: {
            caddy: "app.hack.local, app.hack.gy",
            "caddy.tls": "internal",
            "caddy.reverse_proxy": "{{upstreams 3000}}",
          },
        },
        api: {
          image: "example",
          environment: { HACK_SERVICE_URL: "author-owned" },
          labels: {
            caddy: "api.app.hack.local",
            "caddy.tls": "internal",
            "caddy.reverse_proxy": "{{upstreams 4000}}",
          },
        },
        worker: { image: "example" },
      },
    })
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    JSON.stringify({ dev_host: "app.hack.local", oauth: { enabled: true } })
  );
  await writeFile(
    join(projectDir, "hack.env.default.yaml"),
    JSON.stringify({
      version: 1,
      environment: "default",
      secretsprovider: "project_key",
      values: { global: { HACK_DEV_URL: "https://project-owned.example" } },
    })
  );
  return { root, projectDir, composeFile };
}

test("native up input for a branch instance carries branch metadata with the HTTPS port", async () => {
  const f = await project();
  const scope = {
    projectRoot: f.root,
    projectDir: f.projectDir,
    nativeHome: join(f.root, "unused"),
    branch: "feature-a",
  };
  const branched = await prepareNativeProjectBranch({
    input: await prepareNativeProjectInput({
      projectRoot: f.root,
      projectDir: f.projectDir,
      composeFile: f.composeFile,
    }),
    composeFile: f.composeFile,
    scope,
  });
  const result = applyNativeRuntimeMetadata({
    input: branched,
    selection: SELECTION,
    branch: "feature-a",
    httpsPort: 8443,
  });

  const web = environment(result.input, "web");
  expect(web).toMatchObject({
    KEEP: "public",
    HACK_BRANCH: "feature-a",
    HACK_COMPOSE_PROJECT: "app--feature-a",
    HACK_DEV_HOST: "feature-a.app.hack.local",
    HACK_ALIAS_HOST: "feature-a.app.hack.gy",
    HACK_ALIAS_URL: "https://feature-a.app.hack.gy:8443",
    HACK_SERVICE_NAME: "web",
    HACK_SERVICE_URL: "https://feature-a.app.hack.local:8443",
    HACK_SERVICE_URLS: JSON.stringify([
      "https://feature-a.app.hack.local:8443",
      "https://feature-a.app.hack.gy:8443",
    ]),
  });
  // Explicit project values win: the managed key stays a private declaration.
  expect(web.HACK_DEV_URL).toBeNull();
  expect(result.input.managedEnvironment.web?.HACK_DEV_URL).toBe(
    "https://project-owned.example"
  );
  expect(result.input.managedEnvironment).toBe(branched.managedEnvironment);
  expect(result.input.normalizedComposeJson).not.toContain(
    "project-owned.example"
  );
  expect(result.input.originalSha256).toBe(branched.originalSha256);

  const api = environment(result.input, "api");
  expect(api.HACK_SERVICE_URL).toBe("author-owned");
  expect(api.HACK_SERVICE_URLS).toBe(
    JSON.stringify(["https://api.feature-a.app.hack.local:8443"])
  );
  const worker = environment(result.input, "worker");
  expect(worker.HACK_SERVICE_URL).toBeUndefined();
  expect(worker.HACK_SERVICE_URLS).toBe("[]");
  expect(metadata(worker)).toEqual({
    version: 1,
    branch: "feature-a",
    composeProject: "app--feature-a",
    hosts: { dev: "feature-a.app.hack.local", alias: "feature-a.app.hack.gy" },
    services: {
      web: {
        urls: [
          "https://feature-a.app.hack.local:8443",
          "https://feature-a.app.hack.gy:8443",
        ],
      },
      api: { urls: ["https://api.feature-a.app.hack.local:8443"] },
    },
  });
  expect(result.routes).toEqual(
    new Map([
      ["web", ["feature-a.app.hack.local", "feature-a.app.hack.gy"]],
      ["api", ["api.feature-a.app.hack.local"]],
    ])
  );
});

test("base instance metadata has an empty branch and portless default HTTPS URLs", () => {
  for (const httpsPort of [null, 443]) {
    const result = applyNativeRuntimeMetadata({
      input: input({
        web: {
          image: "example",
          labels: ["caddy=App.Hack.Local.", "caddy.tls=internal"],
        },
      }),
      selection: { ...SELECTION, aliasHost: null },
      branch: null,
      httpsPort,
    });
    const web = environment(result.input, "web");
    expect(web).toEqual({
      HACK_BRANCH: "",
      HACK_DEV_HOST: "app.hack.local",
      HACK_DEV_URL: "https://app.hack.local",
      HACK_COMPOSE_PROJECT: "app",
      HACK_RUNTIME_METADATA: JSON.stringify({
        version: 1,
        branch: null,
        composeProject: "app",
        hosts: { dev: "app.hack.local", alias: null },
        services: { web: { urls: ["https://app.hack.local"] } },
      }),
      HACK_SERVICE_NAME: "web",
      HACK_SERVICE_URLS: JSON.stringify(["https://app.hack.local"]),
      HACK_SERVICE_URL: "https://app.hack.local",
    });
    expect(web.HACK_ALIAS_HOST).toBeUndefined();
  }
});

test("list environments keep their shape and literal values are escaped for interpolation", () => {
  const result = applyNativeRuntimeMetadata({
    input: input({
      web: { image: "example", environment: ["KEEP=public", "HACK_BRANCH"] },
    }),
    selection: {
      devHost: "app.hack.local",
      aliasHost: null,
      projectName: "a$b",
    },
    branch: null,
    httpsPort: null,
  });
  const compose = JSON.parse(result.input.normalizedComposeJson);
  const entries: string[] = compose.services.web.environment;
  expect(entries.slice(0, 2)).toEqual(["KEEP=public", "HACK_BRANCH"]);
  expect(entries).toContain("HACK_COMPOSE_PROJECT=a$$b");
  expect(entries.filter((entry) => entry.startsWith("HACK_BRANCH"))).toEqual([
    "HACK_BRANCH",
  ]);
});

test("native metadata matches the Compose backend's keys and values", () => {
  const services = {
    web: {
      image: "example",
      environment: { HACK_SERVICE_URL: "author-owned" },
      labels: { caddy: "app.hack.local, app.hack.gy" },
    },
    worker: { image: "example", environment: ["KEEP=public"] },
  };
  const compose = buildRuntimeHostMetadataOverride({
    composeYamls: [JSON.stringify({ services })],
    branch: null,
    devHost: SELECTION.devHost,
    aliasHost: SELECTION.aliasHost,
    composeProject: SELECTION.projectName,
  });
  const parsed = YAML.parse(compose ?? "") as {
    services: Record<string, { environment: Record<string, string> }>;
  };
  const native = applyNativeRuntimeMetadata({
    input: input(services),
    selection: SELECTION,
    branch: null,
    httpsPort: null,
  });
  expect(environment(native.input, "web")).toEqual({
    HACK_SERVICE_URL: "author-owned",
    ...parsed.services.web?.environment,
  });
  const worker = JSON.parse(native.input.normalizedComposeJson).services.worker
    .environment as string[];
  expect(worker).toEqual([
    "KEEP=public",
    ...Object.entries(parsed.services.worker?.environment ?? {}).map(
      ([key, value]) => `${key}=${value}`
    ),
  ]);
});

test("reviewed routes must match the advertised hostnames for active services", () => {
  const routes = new Map([["web", ["b.hack", "a.hack"]]]);
  const plan = (hostnames: unknown, active = true) => ({
    services: {
      web: { active, routing: { hostnames, port: 3000 } },
      worker: { active: true, routing: null },
    },
  });
  verifyNativeRuntimeMetadataRoutes({
    plan: plan(["a.hack", "b.hack"]),
    routes,
  });
  verifyNativeRuntimeMetadataRoutes({
    plan: plan(["other.hack"], false),
    routes,
  });
  for (const changed of [["a.hack"], ["a.hack", "c.hack"], [1], undefined]) {
    expectCodedThrow(
      () => verifyNativeRuntimeMetadataRoutes({ plan: plan(changed), routes }),
      "E_NATIVE_PROJECT_UNSUPPORTED",
      "Native runtime metadata"
    );
  }
  expectCodedThrow(
    () =>
      verifyNativeRuntimeMetadataRoutes({
        plan: {
          services: {
            worker: { active: true, routing: { hostnames: ["w.hack"] } },
          },
        },
        routes,
      }),
    "E_NATIVE_PROJECT_UNSUPPORTED",
    "Native runtime metadata"
  );
});

test("retained graphs reproduce exactly the metadata selection they were admitted with", () => {
  const legacy: NativeProjectRun = {
    run: "1".repeat(32),
    owner: "2".repeat(32),
    namespace: "3".repeat(64),
    planId: "4".repeat(64),
    effectiveEnvName: null,
    profiles: [],
    aws: null,
  };
  const current: NativeProjectRun = { ...legacy, runtimeMetadata: true };
  expect(nativeRuntimeMetadataSelected({ selection: SELECTION })).toBe(
    SELECTION
  );
  expect(nativeRuntimeMetadataSelected({})).toBeUndefined();
  expect(
    nativeRuntimeMetadataSelected({ selection: SELECTION, restore: legacy })
  ).toBeUndefined();
  expect(
    nativeRuntimeMetadataSelected({ selection: SELECTION, restore: current })
  ).toBe(SELECTION);
  expect(() => nativeRuntimeMetadataSelected({ restore: current })).toThrow(
    "runtime metadata selection"
  );
});
