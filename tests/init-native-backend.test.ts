import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { YAML } from "bun";

import {
  buildDiscoveredComposeAuto,
  initNextSteps,
  resolveInitComposeBackend,
} from "../src/commands/project.ts";
import {
  type ComposePlan,
  INIT_NATIVE_HTTP_PROBE,
  renderCompose,
} from "../src/init/compose.ts";
import { discoverRepo } from "../src/init/discovery.ts";
import { findComposeBackendFeatures } from "../src/lib/native-compose-backend-features.ts";
import { privateCliEnv } from "./helpers/private-cli-env.ts";

/**
 * HACK-1916: `hack init` with the native backend selected writes a project
 * native `up` accepts and prints only commands that backend accepts. The
 * Compose scaffold and its next steps stay byte-for-byte as before.
 */

const REPO_ROOT = resolve(import.meta.dir, "..");
const tempDirs = new Set<string>();

afterEach(async () => {
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs.clear();
});

async function createTempDir(): Promise<string> {
  // realpath avoids /var vs /private/var mismatches in registry paths.
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), "hack-init-native-"))
  );
  tempDirs.add(dir);
  return dir;
}

type ParsedCompose = {
  services: Record<
    string,
    {
      labels?: Record<string, string>;
      healthcheck?: { "x-hack-http"?: Record<string, unknown> };
      networks?: string[];
    }
  >;
  networks: Record<string, Record<string, unknown>>;
};

function parseCompose(yaml: string): ParsedCompose {
  return YAML.parse(yaml) as ParsedCompose;
}

function upstreamPort(labels: Record<string, string> | undefined): number {
  const match = /\{\{upstreams (\d+)\}\}/.exec(
    labels?.["caddy.reverse_proxy"] ?? ""
  );
  if (!match?.[1]) {
    throw new Error("routed service has no upstream port");
  }
  return Number(match[1]);
}

const PLAN: ComposePlan = {
  name: "synthetic",
  services: [
    {
      name: "web",
      role: "http",
      image: "imbios/bun-node:latest",
      workingDir: "/app",
      command: "bun run dev -- --port 4100 --host 0.0.0.0",
      env: new Map(),
      labels: new Map([
        ["caddy", "synthetic.hack.local"],
        ["caddy.reverse_proxy", "{{upstreams 4100}}"],
        ["caddy.tls", "internal"],
      ]),
      networks: ["hack-dev", "default"],
      httpPort: 4100,
    },
    {
      name: "worker",
      role: "internal",
      image: "imbios/bun-node:latest",
      workingDir: "/app",
      command: "bun run worker",
      env: new Map(),
      labels: new Map(),
      networks: [],
    },
  ],
};

test("resolveInitComposeBackend selects native only for an explicit native backend", () => {
  expect(resolveInitComposeBackend({ HACK_RUNTIME_BACKEND: "native" })).toBe(
    "native"
  );
  expect(resolveInitComposeBackend({ HACK_RUNTIME_BACKEND: "compose" })).toBe(
    "compose"
  );
  expect(resolveInitComposeBackend({})).toBe("compose");
});

test("the Compose scaffold is unchanged when the backend is compose or omitted", () => {
  const omitted = renderCompose(PLAN);
  expect(renderCompose({ ...PLAN, backend: "compose" })).toBe(omitted);
  expect(omitted).not.toContain("x-hack");
  expect(omitted).not.toContain("healthcheck");
  expect(parseCompose(omitted).networks["hack-dev"]).toEqual({
    external: true,
  });
  expect(findComposeBackendFeatures(parseCompose(omitted))).toEqual([
    "external_network",
  ]);
});

test("the native scaffold isolates the ingress network and probes each route at its upstream port", () => {
  const yaml = renderCompose({ ...PLAN, backend: "native" });
  const parsed = parseCompose(yaml);

  // Still external for Compose, which ignores the extension; native replaces it.
  expect(parsed.networks["hack-dev"]).toEqual({
    external: true,
    "x-hack-isolated": true,
  });
  expect(findComposeBackendFeatures(parsed)).toEqual([]);

  expect(parsed.services.web?.healthcheck).toEqual({
    "x-hack-http": { port: 4100, ...INIT_NATIVE_HTTP_PROBE },
  });
  // Native never invents a probe for an unrouted service.
  expect(parsed.services.worker?.healthcheck).toBeUndefined();
  expect(yaml).toMatch(
    /# Native readiness: GET \/ on port 4100 inside the container must return 2xx\.\n(.*\n)? {2}web:/
  );
  expect(renderCompose({ ...PLAN, backend: "native" })).toBe(yaml);
});

test("a discovered native scaffold gives every routed service a probe on its own route port", async () => {
  const dir = await createTempDir();
  const repoRoot = join(dir, "repo");
  await mkdir(join(repoRoot, "apps/web"), { recursive: true });
  await mkdir(join(repoRoot, "apps/api"), { recursive: true });
  await writeFile(
    join(repoRoot, "package.json"),
    JSON.stringify({ name: "root", private: true, workspaces: ["apps/*"] })
  );
  await writeFile(
    join(repoRoot, "apps/web/package.json"),
    JSON.stringify({ name: "web", scripts: { dev: "vite" } })
  );
  await writeFile(
    join(repoRoot, "apps/api/package.json"),
    JSON.stringify({ name: "api", scripts: { dev: "bun index.ts" } })
  );
  const discovery = await discoverRepo(repoRoot);
  const parsed = parseCompose(
    await buildDiscoveredComposeAuto({
      repoRoot,
      devHost: "synthetic.hack.local",
      projectSlug: "synthetic",
      candidates: discovery.candidates,
      oauth: { enabled: false, tld: "gy" },
      backend: "native",
    })
  );

  const routed = Object.entries(parsed.services).filter(
    ([, service]) => service.labels?.caddy !== undefined
  );
  expect(routed.length).toBeGreaterThan(0);
  for (const [, service] of routed) {
    expect(service.healthcheck?.["x-hack-http"]?.port).toBe(
      upstreamPort(service.labels)
    );
  }
  expect(findComposeBackendFeatures(parsed)).toEqual([]);
});

test("native next steps name only commands the native backend accepts", () => {
  const native = initNextSteps({
    backend: "native",
    devHost: "synthetic.hack.local",
  });
  const text = [...native.commands, native.autoCommand, native.routing].join(
    "\n"
  );
  expect(text).toContain("HACK_NATIVE_SHARED_SOURCE=1 hack up");
  expect(text).not.toContain("--detach");
  expect(text).not.toContain("global install");
  expect(native.routing).toContain(
    "hack doctor --browser-url https://synthetic.hack.local"
  );

  expect(
    initNextSteps({ backend: "compose", devHost: "synthetic.hack.local" })
  ).toEqual({
    commands: ["hack up", "hack open"],
    autoCommand: "hack up --detach && hack open",
    routing:
      "Check DNS/TLS for synthetic.hack.local; hack global install configures managed global domains (needs sudo).",
  });
});

async function runInitAuto(opts: {
  readonly root: string;
  readonly repo: string;
  readonly backend: string | undefined;
}): Promise<{ exitCode: number; output: string }> {
  const proc = Bun.spawn({
    cmd: [
      process.execPath,
      join(REPO_ROOT, "index.ts"),
      "init",
      "--auto",
      "--no-discovery",
      "--name",
      "synthetic",
      "--path",
      opts.repo,
    ],
    cwd: opts.repo,
    env: privateCliEnv({
      root: opts.root,
      env: {
        HACK_HOME: join(opts.root, "hack-home"),
        HACK_NO_INTERACTIVE: "1",
        HACK_LOGGER: "console",
        NO_COLOR: "1",
        HACK_RUNTIME_BACKEND: opts.backend,
      },
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, output: `${stdout}\n${stderr}` };
}

test("hack init --auto on the native backend writes a native-startable scaffold and native next steps", async () => {
  const root = await createTempDir();
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });

  const result = await runInitAuto({ root, repo, backend: "native" });
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("HACK_NATIVE_SHARED_SOURCE=1 hack up");
  expect(result.output).not.toContain("--detach");
  expect(result.output).not.toContain("global install");

  const parsed = parseCompose(
    await Bun.file(join(repo, ".hack", "docker-compose.yml")).text()
  );
  expect(findComposeBackendFeatures(parsed)).toEqual([]);
  expect(parsed.services.app?.healthcheck?.["x-hack-http"]?.port).toBe(
    upstreamPort(parsed.services.app?.labels)
  );
}, 30_000);

test("hack init --auto on the Compose backend keeps the Compose scaffold and next steps", async () => {
  const root = await createTempDir();
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });

  const result = await runInitAuto({ root, repo, backend: undefined });
  expect(result.exitCode).toBe(0);
  expect(result.output).toContain("Next: hack up --detach && hack open");
  expect(result.output).toContain("hack global install configures");

  const yaml = await Bun.file(join(repo, ".hack", "docker-compose.yml")).text();
  expect(yaml).not.toContain("x-hack");
  expect(findComposeBackendFeatures(parseCompose(yaml))).toEqual([
    "external_network",
  ]);
}, 30_000);
