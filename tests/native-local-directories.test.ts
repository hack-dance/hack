import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyLocalDirectoriesPlan,
  applyNativeLocalDirectories,
} from "../src/backends/native-local-directories.ts";
import { prepareNativeProjectAdaptation } from "../src/backends/native-project-adaptation.ts";
import {
  type NativeProjectInput,
  prepareNativeProjectInput,
} from "../src/backends/native-project-input.ts";
import {
  localDirectoryVolumeName,
  planLocalDirectories,
} from "../src/lib/local-directories.ts";
import {
  reportNativeLocalDirectories,
  warnLocalDirectoriesNotApplied,
} from "../src/lib/local-directories-project.ts";
import { findProjectContextAtRoot } from "../src/lib/project.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const NODE_MODULES = localDirectoryVolumeName("node_modules");
const NEXT = localDirectoryVolumeName("apps/web/.next");

function compose(): Record<string, unknown> {
  return {
    services: {
      deps: { image: "oven/bun:1", volumes: ["..:/app"] },
      web: {
        image: "node:22",
        volumes: ["..:/app:ro", "../node_modules:/app/node_modules"],
      },
      db: { image: "postgres:17", volumes: ["data:/var/lib/postgresql/data"] },
    },
    volumes: { data: {} },
  };
}

test("the native model gets one declared volume per entry, mounted at each planned path", () => {
  const model = compose();
  applyLocalDirectoriesPlan({
    compose: model,
    plan: planLocalDirectories({
      compose: model,
      composeDir: "/work/app/.hack",
      projectRoot: "/work/app",
      entries: ["node_modules", "apps/web/.next"],
    }),
  });
  const services = model.services as Record<string, { volumes: unknown[] }>;
  expect(services.deps?.volumes).toEqual([
    "..:/app",
    { type: "volume", source: NODE_MODULES, target: "/app/node_modules" },
    { type: "volume", source: NEXT, target: "/app/apps/web/.next" },
  ]);
  // web's bind of node_modules itself is replaced (one mount per target),
  // keeping that bind's writable mode; .next inherits the read-only source.
  expect(services.web?.volumes).toEqual([
    "..:/app:ro",
    { type: "volume", source: NODE_MODULES, target: "/app/node_modules" },
    {
      type: "volume",
      source: NEXT,
      target: "/app/apps/web/.next",
      read_only: true,
    },
  ]);
  expect(services.db?.volumes).toEqual(["data:/var/lib/postgresql/data"]);
  // Plain declarations, no labels (native never applies volume labels).
  expect(model.volumes).toEqual({ data: {}, [NODE_MODULES]: {}, [NEXT]: {} });
});

test("an invalid setting refuses on native too", async () => {
  await expect(
    applyNativeLocalDirectories({
      compose: compose(),
      selection: {
        projectRoot: "/work/app",
        composeFile: "/work/app/.hack/docker-compose.yml",
        entries: [],
        error: "Project localDirectories must be a list.",
      },
    })
  ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });
});

async function project(config: unknown): Promise<{
  root: string;
  projectDir: string;
  composeFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "hack-native-local-dirs-"));
  roots.push(root);
  const projectDir = join(root, ".hack");
  await mkdir(projectDir, { recursive: true });
  const composeFile = join(projectDir, "docker-compose.yml");
  await writeFile(
    composeFile,
    "services:\n  web:\n    image: node:22\n    volumes:\n      - ..:/app\n"
  );
  await writeFile(
    join(projectDir, "hack.config.json"),
    `${JSON.stringify({ name: "native-local-dirs", dev_host: "native-local-dirs.hack", ...(config as object) })}\n`
  );
  return { root, projectDir, composeFile };
}

test("prepared native input records the setting and adaptation applies it with or without an adaptation file", async () => {
  const fixture = await project({ localDirectories: ["node_modules"] });
  const input = await prepareNativeProjectInput({
    projectRoot: fixture.root,
    projectDir: fixture.projectDir,
    composeFile: fixture.composeFile,
  });
  expect(input.localDirectories).toEqual({
    projectRoot: fixture.root,
    composeFile: fixture.composeFile,
    entries: ["node_modules"],
  });
  const adapted = await prepareNativeProjectAdaptation({ input });
  const model = JSON.parse(adapted.normalizedComposeJson) as {
    services: { web: { volumes: unknown[] } };
    volumes: Record<string, unknown>;
  };
  expect(model.services.web.volumes).toEqual([
    "..:/app",
    { type: "volume", source: NODE_MODULES, target: "/app/node_modules" },
  ]);
  expect(model.volumes).toEqual({ [NODE_MODULES]: {} });

  const adaptationFile = join(fixture.projectDir, "native-adaptation.json");
  await writeFile(adaptationFile, JSON.stringify({ version: 1 }));
  const withFile = await prepareNativeProjectAdaptation({
    input,
    path: adaptationFile,
  });
  expect(withFile.normalizedComposeJson).toBe(adapted.normalizedComposeJson);
});

test("a project without the setting is left exactly as it was", async () => {
  const fixture = await project({});
  const input: NativeProjectInput = await prepareNativeProjectInput({
    projectRoot: fixture.root,
    projectDir: fixture.projectDir,
    composeFile: fixture.composeFile,
  });
  expect(input.localDirectories).toBeUndefined();
  expect(await prepareNativeProjectAdaptation({ input })).toBe(input);
});

test("adopted, authored and imported projects say the setting is not applied", async () => {
  const declared = await project({ localDirectories: ["node_modules"] });
  const lines: string[] = [];
  await warnLocalDirectoriesNotApplied({
    projectRoot: declared.root,
    kind: "authored or imported",
    warn: (line) => lines.push(line),
  });
  expect(lines).toEqual([
    "localDirectories is not applied to authored or imported projects on the native backend; services keep those directories on the shared source.",
  ]);
  const none = await project({});
  await warnLocalDirectoriesNotApplied({
    projectRoot: none.root,
    kind: "adopted",
    warn: (line) => lines.push(line),
  });
  expect(lines).toHaveLength(1);
});

test("native up refuses an invalid setting and prints the plan's notices in the foreground", async () => {
  const invalid = await project({ localDirectories: ["../outside"] });
  const invalidContext = await findProjectContextAtRoot({
    projectRoot: invalid.root,
  });
  await expect(
    reportNativeLocalDirectories({ project: invalidContext!, warn: () => {} })
  ).rejects.toMatchObject({ code: "E_CONFIG_INVALID" });

  const fixture = await project({ localDirectories: ["node_modules"] });
  await writeFile(
    fixture.composeFile,
    "services:\n  web:\n    image: node:22\n    volumes:\n      - ..:/app\n      - deps:/app/node_modules\nvolumes:\n  deps: {}\n"
  );
  const context = await findProjectContextAtRoot({ projectRoot: fixture.root });
  const lines: string[] = [];
  await reportNativeLocalDirectories({
    project: context!,
    warn: (line) => lines.push(line),
  });
  expect(lines).toEqual([
    "localDirectories: service web already mounts /app/node_modules; that mount is kept for node_modules.",
  ]);
});
