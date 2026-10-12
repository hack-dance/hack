import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  buildInitAssistantReport,
  type InitAssistantReport,
  renderInitAssistantPrompt,
} from "../src/agents/init-assistant.ts";

const ALWAYS_PRESENT_LIMITATION =
  "Inventory reads file names and manifest keys only; env files, secrets, lockfile contents, and pin values were not read.";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "hack-init-assistant-"));
  tempDirs.push(repoRoot);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(repoRoot, rel);
    await mkdir(dirname(abs), { recursive: true });
    await Bun.write(abs, content);
  }
  return repoRoot;
}

function packageJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, null, 2);
}

async function inventory(files: Record<string, string>): Promise<{
  readonly report: InitAssistantReport;
  readonly prompt: string;
}> {
  const repoRoot = await createRepo(files);
  const report = await buildInitAssistantReport({ repoRoot });
  return { report, prompt: renderInitAssistantPrompt({ report }) };
}

test("bun.lock-only repo is detected as a Bun repo without conflicts", async () => {
  const { report, prompt } = await inventory({
    "package.json": packageJson({ name: "app", scripts: { dev: "vite" } }),
    "bun.lock": "{}\n",
  });

  expect(report.packageManagers).toEqual(["bun.lock"]);
  expect(report.nestedLockfiles).toEqual([]);
  expect(report.packageManagerConflicts).toEqual([]);
  expect(report.runtimeManifests).toEqual([]);
  expect(report.limitations).toContain(ALWAYS_PRESENT_LIMITATION);
  expect(prompt).toContain("- Package managers: bun.lock");
  expect(prompt).toContain("- Package manager conflicts: none detected");
  expect(prompt).toContain("Discovery limitations");
  expect(prompt).toContain(`- ${ALWAYS_PRESENT_LIMITATION}`);
});

test("Bun monorepo with current and legacy lockfiles is one package manager", async () => {
  const { report, prompt } = await inventory({
    "package.json": packageJson({
      name: "mono",
      private: true,
      workspaces: ["apps/*", "packages/*"],
      packageManager: "bun@1.3.9",
      engines: { node: ">=22.11.0" },
    }),
    "bun.lock": "{}\n",
    "bun.lockb": "binary",
    "apps/web/package.json": packageJson({
      name: "web",
      scripts: { dev: "vite" },
    }),
    "packages/ui/package.json": packageJson({ name: "ui" }),
    ".nvmrc": "22\n",
    "mise.toml": '[tools]\nbun = "1.3.9"\n',
  });

  expect(report.isMonorepo).toBe(true);
  expect(report.packageManagers).toEqual(["bun.lock", "bun.lockb"]);
  expect(report.nestedLockfiles).toEqual([]);
  expect(report.packageManagerConflicts).toEqual([]);
  expect(report.runtimePins).toEqual([
    ".nvmrc",
    "mise.toml",
    "package.json#engines",
    "package.json#packageManager",
  ]);
  expect(prompt).toContain(
    "- Runtime pins: .nvmrc, mise.toml, package.json#engines, package.json#packageManager"
  );
  // Pins are reported by name only.
  expect(prompt).not.toContain("bun@1.3.9");
  expect(prompt).not.toContain(">=22.11.0");
  expect(prompt).not.toContain('bun = "1.3.9"');
});

test("pnpm workspace reports a nested npm lockfile as a package-manager conflict", async () => {
  const { report, prompt } = await inventory({
    "package.json": packageJson({ name: "mono", private: true }),
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "packages/api/package.json": packageJson({
      name: "api",
      scripts: { dev: "tsx watch src/index.ts" },
    }),
    "packages/legacy/package.json": packageJson({ name: "legacy" }),
    "packages/legacy/package-lock.json": "{}\n",
    "packages/tool/package.json": packageJson({ name: "tool" }),
    "packages/tool/pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
  });

  expect(report.packageManagers).toEqual(["pnpm-lock.yaml"]);
  expect(report.nestedLockfiles).toEqual([
    { path: "packages/legacy/package-lock.json", manager: "npm" },
    { path: "packages/tool/pnpm-lock.yaml", manager: "pnpm" },
  ]);
  expect(report.packageManagerConflicts).toEqual(["npm", "pnpm"]);
  expect(
    report.limitations.some((entry) =>
      entry.startsWith(
        "Lockfiles from more than one package manager (npm, pnpm)"
      )
    )
  ).toBe(true);
  expect(
    report.limitations.some((entry) => entry.startsWith("Nested lockfiles"))
  ).toBe(true);
  expect(prompt).toContain(
    "- Nested lockfiles: packages/legacy/package-lock.json, packages/tool/pnpm-lock.yaml"
  );
  expect(prompt).toContain("- Package manager conflicts: npm, pnpm");
  expect(prompt).toContain(
    "Which package manager and lockfile does CI install with?"
  );
});

test("mixed Rust + TypeScript repo reports Rust manifests and pins by name", async () => {
  const { report, prompt } = await inventory({
    "package.json": packageJson({
      name: "mixed",
      scripts: { dev: "bun run src/server.ts" },
    }),
    "bun.lock": "{}\n",
    "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n',
    "Cargo.lock": "version = 4\n",
    "crates/core/Cargo.toml": '[package]\nname = "core"\n',
    "rust-toolchain.toml": '[toolchain]\nchannel = "1.88.0"\n',
  });

  expect(report.packageManagers).toEqual(["bun.lock"]);
  expect(report.runtimeManifests).toEqual([
    { path: "Cargo.lock", ecosystem: "rust" },
    { path: "Cargo.toml", ecosystem: "rust" },
    { path: "crates/core/Cargo.toml", ecosystem: "rust" },
  ]);
  expect(report.runtimePins).toEqual(["rust-toolchain.toml"]);
  expect(report.limitations).toContain(
    "Service candidates and setup scripts come from package.json scripts only; entrypoints, ports, and setup steps for rust were not inferred."
  );
  expect(prompt).toContain(
    "- Non-JS runtimes: rust (Cargo.lock, Cargo.toml, crates/core/Cargo.toml)"
  );
  expect(prompt).not.toContain("1.88.0");
  expect(prompt).toContain(
    "Which commands build and start the non-JS services, and which ports do they use?"
  );
});

test("Python-only repo reports manifests and the missing package.json", async () => {
  const { report, prompt } = await inventory({
    "pyproject.toml": '[project]\nname = "svc"\n',
    "uv.lock": "version = 1\n",
    "requirements.txt": "fastapi\n",
    ".python-version": "3.13\n",
    ".env": "DATABASE_PASSWORD=do-not-leak\n",
  });

  expect(report.packageManagers).toEqual([]);
  expect(report.candidates).toEqual([]);
  expect(report.runtimeManifests.map((entry) => entry.path)).toEqual([
    "pyproject.toml",
    "requirements.txt",
    "uv.lock",
  ]);
  expect(
    report.runtimeManifests.every((entry) => entry.ecosystem === "python")
  ).toBe(true);
  expect(report.runtimePins).toEqual([".python-version"]);
  expect(report.envFiles).toEqual([".env"]);
  expect(report.limitations).toContain(
    "No root package.json: JavaScript workspace, script, and service discovery found nothing at the root."
  );
  expect(prompt).toContain(
    "- Non-JS runtimes: python (pyproject.toml, requirements.txt, uv.lock)"
  );
  expect(prompt).not.toContain("do-not-leak");
  expect(prompt).not.toContain("DATABASE_PASSWORD");
  expect(prompt).not.toContain("3.13");
});

test("other ecosystems are recognized by manifest and project-file names", async () => {
  const { report } = await inventory({
    "go.mod": "module example.com/svc\n",
    "services/billing/Gemfile.lock": "GEM\n",
    "services/realtime/mix.exs": "defmodule Realtime.MixProject do end\n",
    "App.sln": "",
    "src/Api/Api.csproj": "<Project />\n",
    "node_modules/dep/Cargo.toml": "[package]\n",
    ".tool-versions": "golang 1.24.0\n",
  });

  expect(report.runtimeManifests).toEqual([
    { path: "App.sln", ecosystem: "dotnet" },
    { path: "go.mod", ecosystem: "go" },
    { path: "services/billing/Gemfile.lock", ecosystem: "ruby" },
    { path: "services/realtime/mix.exs", ecosystem: "elixir" },
    { path: "src/Api/Api.csproj", ecosystem: "dotnet" },
  ]);
  expect(report.runtimePins).toEqual([".tool-versions"]);
  expect(report.limitations).toContain(
    "Service candidates and setup scripts come from package.json scripts only; entrypoints, ports, and setup steps for dotnet, elixir, go, ruby were not inferred."
  );
});

test("prompt embeds the canonical onboarding guidance after the inventory", async () => {
  const { prompt } = await inventory({
    "package.json": packageJson({ name: "app" }),
    "bun.lock": "{}\n",
  });

  const inventoryIndex = prompt.indexOf("Discovery limitations");
  const onboardingIndex = prompt.indexOf("## Phase 1 — Inventory the repo");
  expect(inventoryIndex).toBeGreaterThan(0);
  expect(onboardingIndex).toBeGreaterThan(inventoryIndex);
  expect(prompt).toContain("bun install --frozen-lockfile");
});
