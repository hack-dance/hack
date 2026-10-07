import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  requireNativeComposeBackend,
  selectNativeComposeProject,
} from "../src/lib/native-compose-selection.ts";
import { restoreEnv } from "./helpers/env.ts";

let root: string;
let oldHome: string | undefined;
beforeEach(async () => {
  oldHome = process.env.HOME;
  root = await mkdtemp(join(tmpdir(), "hack-native-compose-selection-"));
  process.env.HOME = root;
});
afterEach(async () => {
  restoreEnv("HOME", oldHome);
  await rm(root, { recursive: true, force: true });
});

async function file(relative: string, text: string): Promise<void> {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}
async function native(relative: string): Promise<string> {
  await file(`${relative}/.hack/hack.project.json`, "{broken-native-input");
  return join(root, relative);
}
async function registry(entries: readonly { name: string; path: string }[]) {
  const text = JSON.stringify({
    version: 1,
    projects: entries.map((entry, index) => ({
      id: `fixture-${index}`,
      name: entry.name,
      repoRoot: join(root, entry.path),
      projectDir: join(root, entry.path, ".hack"),
      projectDirName: ".hack",
      createdAt: "2026-01-01T00:00:00Z",
    })),
  });
  await file(".hack/projects.json", text);
  await file(".hack/projects.json.lock", "not-a-lock-owned-by-this-selector");
  return text;
}

test("native selection stops at the authored boundary before parsing or touching registration", async () => {
  await file("outer/.hack/docker-compose.yml", "services: {}\n");
  const inner = await native("outer/native");
  await mkdir(join(inner, "nested"));
  expect(
    await selectNativeComposeProject({ cwd: join(inner, "nested") })
  ).toEqual({
    kind: "native",
    projectRoot: inner,
  });
  expect(await Bun.file(join(root, ".hack/projects.json")).exists()).toBe(
    false
  );
  expect(await Bun.file(join(inner, ".hack/.internal")).exists()).toBe(false);
});

test("explicit relative path selects the same exact family and conflicting options refuse", async () => {
  const projectRoot = await native("selected");
  expect(
    await selectNativeComposeProject({ cwd: root, path: "selected" })
  ).toEqual({
    kind: "native",
    projectRoot,
  });
  await expect(
    selectNativeComposeProject({
      cwd: root,
      path: "selected",
      project: "named",
    })
  ).rejects.toThrow("Use either --path or --project");
});

test("legacy and absent inputs keep the legacy handler while mixed authored families refuse", async () => {
  await file("legacy/.hack/docker-compose.yml", "services: {}\n");
  expect(
    await selectNativeComposeProject({ cwd: join(root, "legacy") })
  ).toBeNull();
  expect(await selectNativeComposeProject({ cwd: root })).toBeNull();
  const mixed = await native("mixed");
  await file("mixed/.hack/hack.config.json", "{also-broken");
  await expect(selectNativeComposeProject({ cwd: mixed })).rejects.toThrow(
    "E_NATIVE_PROJECT_CONFLICT"
  );
});

test("registered native roots are read-only even with an existing exclusive lock", async () => {
  const projectRoot = await native("registered");
  const before = await registry([{ name: "registered", path: "registered" }]);
  expect(
    await selectNativeComposeProject({ cwd: root, project: "registered" })
  ).toEqual({
    kind: "native",
    projectRoot,
  });
  expect(await readFile(join(root, ".hack/projects.json"), "utf8")).toBe(
    before
  );
  expect(await readFile(join(root, ".hack/projects.json.lock"), "utf8")).toBe(
    "not-a-lock-owned-by-this-selector"
  );
});

test("registered exact-root absence never discovers an ancestor native or legacy project", async () => {
  await native("ancestor");
  await mkdir(join(root, "ancestor/empty"));
  await registry([{ name: "empty", path: "ancestor/empty" }]);
  expect(
    await selectNativeComposeProject({ cwd: root, project: "empty" })
  ).toBeNull();
  await expect(
    selectNativeComposeProject({ cwd: root, project: "unknown" })
  ).rejects.toThrow("The selected project is not registered");
});

test("ambiguous registered names refuse before choosing the one live path", async () => {
  await native("live");
  await registry([
    { name: "duplicate", path: "live" },
    { name: "duplicate", path: "missing" },
  ]);
  await expect(
    selectNativeComposeProject({ cwd: root, project: "duplicate" })
  ).rejects.toThrow("Ambiguous project name");
});

test("authored format never silently changes an explicitly selected runtime", () => {
  for (const backend of [undefined, "compose"]) {
    expect(() => requireNativeComposeBackend({ backend })).not.toThrow();
  }
  for (const backend of ["native", "smol", "", "COMPOSE"]) {
    expect(() => requireNativeComposeBackend({ backend })).toThrow(
      "Native project configuration currently requires the Compose backend"
    );
  }
});
