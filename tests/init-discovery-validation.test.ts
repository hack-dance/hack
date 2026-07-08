import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { YAML } from "bun";

import {
  buildDiscoveredComposeAuto,
  type ComposeWizardInput,
} from "../src/commands/project.ts";
import type { ComposePlan } from "../src/init/compose.ts";
import { renderCompose, TODO_IMAGE_PLACEHOLDER } from "../src/init/compose.ts";
import type { ServiceCandidate } from "../src/init/discovery.ts";
import { discoverRepo } from "../src/init/discovery.ts";
import {
  dedupeAggregatorCandidates,
  dedupeCandidates,
  dedupeCandidatesByPackage,
  detectBackingServices,
  detectPackageRuntime,
  findExistingComposeFiles,
  reassignCollidingPorts,
} from "../src/init/validation.ts";

let tempDir: string | null = null;

afterEach(async () => {
  if (tempDir) {
    await rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeText(path: string, value: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
}

function candidate(overrides: Partial<ServiceCandidate>): ServiceCandidate {
  return {
    id: "pkg:dev",
    packageId: "pkg",
    packageRelativeDir: "apps/x",
    packageName: "@repo/x",
    scriptName: "dev",
    scriptCommand: "vite",
    ...overrides,
  };
}

/**
 * Scaffolds the polyglot fixture used throughout this file:
 * - root package.json (workspaces [apps/*, backend]) with aggregator
 *   scripts `dev:web` (turbo filter) and `dev:backend` (dotnet run
 *   --project) that delegate to package-local dev scripts.
 * - apps/web: vite package with both `dev` and `start` scripts (same-
 *   package duplicate) plus a `PORT=3000` reference nowhere — port comes
 *   from the default guess.
 * - apps/api: bun http package with a plain `dev` script (no port flags).
 * - backend/: package.json wrapper (`dev: dotnet watch`) plus an
 *   `Api.csproj` marker file (dotnet runtime).
 * - root .env.example with DATABASE_URL + TEMPORAL_ADDRESS placeholders.
 * - root package.json also declares `pg` + `@temporalio/client` deps.
 */
async function writePolyglotFixture(repoRoot: string): Promise<void> {
  await writeJson(join(repoRoot, "package.json"), {
    name: "root",
    private: true,
    workspaces: ["apps/*", "backend"],
    dependencies: {
      pg: "^8.0.0",
      "@temporalio/client": "^1.0.0",
    },
    scripts: {
      "dev:web": "turbo run dev --filter=web",
      "dev:backend": "dotnet run --project backend/Api.csproj",
    },
  });

  await writeJson(join(repoRoot, "apps/web/package.json"), {
    name: "web",
    scripts: {
      dev: "vite",
      start: "vite preview",
    },
  });

  await writeJson(join(repoRoot, "apps/api/package.json"), {
    name: "api",
    scripts: {
      dev: "bun index.ts",
    },
  });

  await writeJson(join(repoRoot, "backend/package.json"), {
    name: "backend",
    scripts: {
      dev: "dotnet watch",
    },
  });
  await writeText(join(repoRoot, "backend/Api.csproj"), "<Project></Project>");

  await writeText(
    join(repoRoot, ".env.example"),
    [
      "DATABASE_URL=postgres://user:pass@localhost:5432/app",
      "TEMPORAL_ADDRESS=localhost:7233",
      "",
    ].join("\n")
  );
}

test("dedupeCandidatesByPackage keeps the highest-scored script per package", () => {
  const dev = candidate({ id: "web:dev", scriptName: "dev" });
  const start = candidate({ id: "web:start", scriptName: "start" });

  const result = dedupeCandidatesByPackage({ candidates: [dev, start] });

  expect(result.selected).toEqual([dev]);
  expect(result.dropped).toEqual([{ candidate: start, keptScriptName: "dev" }]);
});

test("dedupeCandidatesByPackage preserves distinct dev:* services in a single package", () => {
  const web = candidate({ id: "root:dev:web", scriptName: "dev:web" });
  const api = candidate({ id: "root:dev:api", scriptName: "dev:api" });

  const result = dedupeCandidatesByPackage({ candidates: [web, api] });

  expect(result.selected).toEqual([web, api]);
  expect(result.dropped).toEqual([]);
});

test("dedupeAggregatorCandidates drops a root --filter aggregator in favor of the package's own script", () => {
  const webDev = candidate({
    id: "apps/web/package.json:dev",
    packageId: "apps/web/package.json",
    packageRelativeDir: "apps/web",
    packageName: "web",
    scriptName: "dev",
    scriptCommand: "vite",
  });
  const rootAggregator = candidate({
    id: "package.json:dev:web",
    packageId: "package.json",
    packageRelativeDir: ".",
    packageName: "root",
    scriptName: "dev:web",
    scriptCommand: "turbo run dev --filter=web",
  });

  const result = dedupeAggregatorCandidates({
    candidates: [rootAggregator, webDev],
  });

  expect(result.selected).toEqual([webDev]);
  expect(result.dropped).toEqual([
    { candidate: rootAggregator, keptScriptName: "dev" },
  ]);
});

test("dedupeAggregatorCandidates drops a root --project aggregator targeting a package with its own dev script", () => {
  const backendDev = candidate({
    id: "backend/package.json:dev",
    packageId: "backend/package.json",
    packageRelativeDir: "backend",
    packageName: "backend",
    scriptName: "dev",
    scriptCommand: "dotnet watch",
  });
  const rootAggregator = candidate({
    id: "package.json:dev:backend",
    packageId: "package.json",
    packageRelativeDir: ".",
    packageName: "root",
    scriptName: "dev:backend",
    scriptCommand: "dotnet run --project backend/Api.csproj",
  });

  const result = dedupeAggregatorCandidates({
    candidates: [rootAggregator, backendDev],
  });

  expect(result.selected).toEqual([backendDev]);
  expect(result.dropped).toEqual([
    { candidate: rootAggregator, keptScriptName: "dev" },
  ]);
});

test("dedupeCandidates full pipeline on the polyglot fixture yields exactly one candidate per package", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-validation-dedupe-"));
  const repoRoot = join(tempDir, "repo");
  await mkdir(repoRoot, { recursive: true });
  await writePolyglotFixture(repoRoot);

  const discovery = await discoverRepo(repoRoot);
  const result = dedupeCandidates({ candidates: discovery.candidates });

  const byPackage = new Map<string, number>();
  for (const c of result.selected) {
    byPackage.set(c.packageId, (byPackage.get(c.packageId) ?? 0) + 1);
  }
  for (const count of byPackage.values()) {
    expect(count).toBe(1);
  }

  // 3 packages have qualifying dev scripts: apps/web, apps/api, backend.
  // The root package's dev:web / dev:backend aggregators are dropped.
  expect(result.selected.length).toBe(3);
  const packageDirs = result.selected.map((c) => c.packageRelativeDir).sort();
  expect(packageDirs).toEqual(["apps/api", "apps/web", "backend"]);

  const findingKinds = result.findings.map((f) => f.kind);
  expect(findingKinds.every((k) => k === "duplicate-script")).toBe(true);
  // web/start dropped (same-package) + dev:web + dev:backend aggregators dropped.
  expect(result.findings.length).toBe(3);
});

test("reassignCollidingPorts reassigns duplicates ascending from the collision and rewrites the command", () => {
  const webCandidate = candidate({
    id: "web",
    packageRelativeDir: "apps/web",
    scriptName: "dev",
    scriptCommand: "vite",
  });
  const apiCandidate = candidate({
    id: "api",
    packageRelativeDir: "apps/api",
    scriptName: "dev",
    scriptCommand: "bun index.ts",
  });
  const adminCandidate = candidate({
    id: "admin",
    packageRelativeDir: "apps/admin",
    scriptName: "dev",
    scriptCommand: "vite",
  });

  const result = reassignCollidingPorts({
    drafts: [
      { name: "web", role: "http", port: 3000, candidate: webCandidate },
      { name: "api", role: "http", port: 3000, candidate: apiCandidate },
      { name: "admin", role: "http", port: 3000, candidate: adminCandidate },
    ],
  });

  expect(result.reassignments.has("web")).toBe(false);
  expect(result.reassignments.get("api")?.port).toBe(3001);
  expect(result.reassignments.get("admin")?.port).toBe(3002);
  expect(result.reassignments.get("api")?.command).toContain("3001");
  expect(result.findings.length).toBe(2);
  expect(result.findings.every((f) => f.kind === "port-reassigned")).toBe(true);
});

test("detectPackageRuntime finds dotnet via a *.csproj marker file", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-validation-runtime-"));
  const dir = join(tempDir, "backend");
  await mkdir(dir, { recursive: true });
  await writeText(join(dir, "Api.csproj"), "<Project></Project>");

  const runtime = await detectPackageRuntime({ dir });
  expect(runtime).toBe("dotnet");
});

test("detectPackageRuntime resolves a root aggregator's --project reference to the target dir's runtime", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-validation-runtime-root-"));
  const repoRoot = join(tempDir, "repo");
  await mkdir(repoRoot, { recursive: true });
  await mkdir(join(repoRoot, "backend"), { recursive: true });
  await writeText(join(repoRoot, "backend/Api.csproj"), "<Project></Project>");

  const runtime = await detectPackageRuntime({
    dir: repoRoot,
    scriptCommand: "dotnet run --project backend/Api.csproj",
    repoRoot,
  });
  expect(runtime).toBe("dotnet");
});

test("detectPackageRuntime returns null for a plain JS/TS package", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-validation-runtime-js-"));
  const dir = join(tempDir, "web");
  await mkdir(dir, { recursive: true });
  await writeJson(join(dir, "package.json"), { name: "web" });

  const runtime = await detectPackageRuntime({
    dir,
    scriptCommand: "vite",
  });
  expect(runtime).toBeNull();
});

test("detectBackingServices finds postgres + temporal from deps and .env.example keys (values excluded)", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-validation-backing-"));
  const repoRoot = join(tempDir, "repo");
  await mkdir(repoRoot, { recursive: true });
  await writePolyglotFixture(repoRoot);

  const discovery = await discoverRepo(repoRoot);
  const detections = await detectBackingServices({
    repoRoot,
    packages: discovery.packages,
  });

  const kinds = detections.map((d) => d.kind).sort();
  expect(kinds).toEqual(["postgres", "temporal"]);

  const postgres = detections.find((d) => d.kind === "postgres");
  expect(postgres?.evidence.some((e) => e.includes("pg"))).toBe(true);
  expect(postgres?.evidence.some((e) => e.includes("DATABASE_URL"))).toBe(true);
  // Evidence must never leak the secret value, only the key name.
  for (const detection of detections) {
    for (const e of detection.evidence) {
      expect(e).not.toContain("user:pass");
      expect(e).not.toContain("localhost:5432");
      expect(e).not.toContain("localhost:7233");
    }
  }
});

test("findExistingComposeFiles finds a root docker-compose.yml", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-validation-compose-"));
  const repoRoot = join(tempDir, "repo");
  await mkdir(repoRoot, { recursive: true });
  await writeText(
    join(repoRoot, "docker-compose.yml"),
    "services:\n  db:\n    image: postgres:16\n  temporal:\n    image: temporalio/auto-setup:latest\n"
  );

  const found = await findExistingComposeFiles({ repoRoot });
  expect(found.length).toBe(1);
  expect(found[0]?.endsWith("docker-compose.yml")).toBe(true);
});

test("buildDiscoveredComposeAuto on the polyglot fixture: one service per package, distinct ports, dotnet TODO image, backing-service + existing-compose findings", async () => {
  tempDir = await mkdtemp(join(tmpdir(), "hack-validation-auto-"));
  const repoRoot = join(tempDir, "repo");
  await mkdir(repoRoot, { recursive: true });
  await writePolyglotFixture(repoRoot);

  // Root docker-compose.yml with postgres + temporal — should surface an
  // "existing-compose-found" finding and mark those backing services as
  // already containerized.
  await writeText(
    join(repoRoot, "docker-compose.yml"),
    [
      "services:",
      "  db:",
      "    image: postgres:16",
      "  temporal:",
      "    image: temporalio/auto-setup:latest",
      "",
    ].join("\n")
  );

  const discovery = await discoverRepo(repoRoot);

  const input: ComposeWizardInput = {
    repoRoot,
    devHost: "polyglot.hack",
    projectSlug: "polyglot",
    candidates: discovery.candidates,
    oauth: { enabled: false, tld: "gy" },
  };

  const composeYaml = await buildDiscoveredComposeAuto(input);
  const parsed = YAML.parse(
    composeYaml
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n")
  ) as {
    services: Record<
      string,
      { image: string; command: string; labels?: Record<string, string> }
    >;
  };

  const serviceNames = Object.keys(parsed.services).sort();
  // web, api, backend — no web-2/backend-2 duplicates and no separate
  // dev:web/dev:backend aggregator services.
  expect(serviceNames).toEqual(["api", "backend", "web"]);

  const ports = new Set<string>();
  for (const name of serviceNames) {
    const label = parsed.services[name]?.labels?.["caddy.reverse_proxy"];
    if (label) {
      expect(ports.has(label)).toBe(false);
      ports.add(label);
    }
  }

  // The dotnet-backed "backend" service must not silently get the default
  // bun-node image.
  expect(parsed.services.backend?.image).toBe(TODO_IMAGE_PLACEHOLDER);
  expect(composeYaml).toContain(
    "TODO(hack-init): backend looks like a dotnet service"
  );

  // Backing services + existing-compose pointer surfaced as header comments.
  expect(composeYaml).toContain("hack-init discovery notes");
  expect(composeYaml).toContain("postgres");
  expect(composeYaml).toContain("temporal");
  expect(composeYaml).toContain("already containerized elsewhere");
  expect(composeYaml).toContain("docker-compose.yml");
});

test("renderCompose header + service comment injection is stable and idempotent across repeated renders", () => {
  const plan: ComposePlan = {
    name: "idempotent-test",
    headerComments: ["backing service notes", "- postgres: add a service"],
    services: [
      {
        name: "backend",
        role: "internal",
        image: TODO_IMAGE_PLACEHOLDER,
        workingDir: "/app/backend",
        command: "dotnet watch",
        env: new Map(),
        labels: new Map(),
        networks: [],
        comments: ["TODO(hack-init): backend looks like a dotnet service"],
      },
      {
        name: "web",
        role: "http",
        image: "imbios/bun-node:latest",
        workingDir: "/app/apps/web",
        command: "bun run dev -- --port 3000 --host 0.0.0.0",
        env: new Map(),
        labels: new Map([["caddy", "web.myapp.hack"]]),
        networks: ["hack-dev", "default"],
      },
    ],
  };

  const first = renderCompose(plan);
  const second = renderCompose(plan);
  expect(first).toBe(second);

  // Header block appears exactly once.
  const headerOccurrences = first.split("hack-init discovery notes").length - 1;
  expect(headerOccurrences).toBe(1);

  // Service comment appears exactly once and directly above the service key.
  const commentOccurrences =
    first.split("TODO(hack-init): backend looks like a dotnet service").length -
    1;
  expect(commentOccurrences).toBe(1);
  expect(first).toMatch(
    /# TODO\(hack-init\): backend looks like a dotnet service\n {2}backend:/
  );

  // Re-rendering against already-commented output (simulated by rendering
  // twice) does not duplicate the injected lines.
  const parsed = YAML.parse(
    first
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n")
  ) as Record<string, unknown>;
  expect(parsed.services).toBeDefined();
});
