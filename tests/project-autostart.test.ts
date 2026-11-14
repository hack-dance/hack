import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claimProjectAutostart,
  readProjectsRegistry,
  readProjectsRegistryStrict,
  recordProjectAutostartResult,
  removeProjectAutostart,
  setProjectAutostart,
  setProjectAutostartPaused,
  upsertProjectRegistration,
} from "../src/lib/projects-registry.ts";
import { restoreEnv } from "./helpers/env.ts";

let root = "";
let registryPath = "";
let previousHome: string | undefined;
let previousConfig: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "hack-autostart-registry-"));
  registryPath = join(root, ".hack", "projects.json");
  previousHome = process.env.HOME;
  previousConfig = process.env.HACK_GLOBAL_CONFIG_PATH;
  process.env.HOME = root;
  process.env.HACK_GLOBAL_CONFIG_PATH = join(root, ".hack", "hack.config.json");
  await mkdir(join(root, ".hack"), { recursive: true });
  await writeFile(
    registryPath,
    JSON.stringify({ version: 1, projects: [entry("alpha"), entry("beta")] })
  );
});

afterEach(async () => {
  restoreEnv("HOME", previousHome);
  restoreEnv("HACK_GLOBAL_CONFIG_PATH", previousConfig);
  await rm(root, { recursive: true, force: true });
});

function entry(name: string) {
  return {
    id: name,
    name,
    repoRoot: join(root, name),
    projectDir: join(root, name, ".hack"),
    projectDirName: ".hack",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

async function read(id = "alpha") {
  return (await readProjectsRegistry({ registryPath })).projects.find(
    (item) => item.id === id
  );
}

test("old registries have no intent; explicit opt-in migrates only the selected entry", async () => {
  expect((await read())?.autostart).toBeUndefined();
  const marked = await setProjectAutostart({
    id: "alpha",
    branch: "preview",
    registryPath,
  });
  expect(marked.autostart).toEqual({
    branch: "preview",
    paused: false,
    lastResult: null,
    lastAttemptBootId: null,
  });
  expect((await read("beta"))?.autostart).toBeUndefined();
  expect((await read())?.autostart).toEqual(marked.autostart);
  await removeProjectAutostart({ id: "alpha", registryPath });
  expect((await read())?.autostart).toBeUndefined();
  expect((await read())?.name).toBe("alpha");
});

test("pause all changes only marked entries; up resume cannot create intent", async () => {
  await setProjectAutostart({ id: "alpha", registryPath });
  await setProjectAutostartPaused({ paused: true, registryPath });
  expect((await read())?.autostart?.paused).toBe(true);
  expect((await read("beta"))?.autostart).toBeUndefined();
  await setProjectAutostartPaused({ id: "beta", paused: false, registryPath });
  expect((await read("beta"))?.autostart).toBeUndefined();
  await setProjectAutostartPaused({ paused: false, registryPath });
  expect((await read())?.autostart?.paused).toBe(false);
});

test("claims persist once per boot across concurrent schedulers and registry rereads", async () => {
  await setProjectAutostart({ id: "alpha", registryPath });
  const attempts = await Promise.all(
    Array.from({ length: 4 }, () =>
      claimProjectAutostart({ id: "alpha", bootId: "boot-a", registryPath })
    )
  );
  expect(attempts.filter(Boolean)).toHaveLength(1);
  expect(
    await claimProjectAutostart({ id: "alpha", bootId: "boot-a", registryPath })
  ).toBeNull();
  expect(
    (
      await claimProjectAutostart({
        id: "alpha",
        bootId: "boot-b",
        registryPath,
      })
    )?.autostart?.lastAttemptBootId
  ).toBe("boot-b");
});

test("down pause survives daemon restart and a new boot until an explicit up", async () => {
  await setProjectAutostart({ id: "alpha", registryPath });
  await setProjectAutostartPaused({ id: "alpha", paused: true, registryPath });
  expect(
    await claimProjectAutostart({ id: "alpha", bootId: "boot-a", registryPath })
  ).toBeNull();
  expect(
    await claimProjectAutostart({ id: "alpha", bootId: "boot-b", registryPath })
  ).toBeNull();
  await setProjectAutostartPaused({ id: "alpha", paused: false, registryPath });
  expect(
    await claimProjectAutostart({ id: "alpha", bootId: "boot-b", registryPath })
  ).not.toBeNull();
});

test("late results preserve pause and cannot recreate removed intent or overwrite another boot", async () => {
  await setProjectAutostart({ id: "alpha", registryPath });
  await claimProjectAutostart({ id: "alpha", bootId: "boot-a", registryPath });
  await setProjectAutostartPaused({ id: "alpha", paused: true, registryPath });
  const result = {
    status: "skipped" as const,
    reason: "interaction_required",
    at: "2026-01-01T00:00:00.000Z",
  };
  expect(
    await recordProjectAutostartResult({
      id: "alpha",
      bootId: "boot-a",
      result,
      registryPath,
    })
  ).toBe(true);
  expect((await read())?.autostart).toMatchObject({
    paused: true,
    lastResult: result,
  });
  await setProjectAutostartPaused({ id: "alpha", paused: false, registryPath });
  await claimProjectAutostart({ id: "alpha", bootId: "boot-b", registryPath });
  expect(
    await recordProjectAutostartResult({
      id: "alpha",
      bootId: "boot-a",
      result,
      registryPath,
    })
  ).toBe(false);
  await removeProjectAutostart({ id: "alpha", registryPath });
  expect(
    await recordProjectAutostartResult({
      id: "alpha",
      bootId: "boot-b",
      result,
      registryPath,
    })
  ).toBe(false);
  expect((await read())?.autostart).toBeUndefined();
});

test("ordinary registration refresh preserves intent and startup result", async () => {
  const projectDir = join(root, "alpha", ".hack");
  await mkdir(projectDir, { recursive: true });
  const configFile = join(projectDir, "hack.config.json");
  const composeFile = join(projectDir, "docker-compose.yml");
  const envFile = join(projectDir, ".env");
  await writeFile(configFile, JSON.stringify({ name: "alpha" }));
  await writeFile(composeFile, "services: {}\n");
  await writeFile(envFile, "");
  await setProjectAutostart({ id: "alpha", registryPath });
  await claimProjectAutostart({ id: "alpha", bootId: "boot-a", registryPath });
  await recordProjectAutostartResult({
    id: "alpha",
    bootId: "boot-a",
    registryPath,
    result: { status: "started", reason: null, at: "2026-01-01T00:00:00.000Z" },
  });
  const marked = await read();
  await upsertProjectRegistration({
    project: {
      projectRoot: join(root, "alpha"),
      projectDir,
      projectDirName: ".hack",
      composeFile,
      envFile,
      configFile,
    },
  });
  expect((await read())?.autostart).toEqual(marked?.autostart);
});

test("malformed intent disables only autostart and removal repairs it", async () => {
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      projects: [{ ...entry("alpha"), autostart: { paused: "false" } }],
    })
  );
  const before = await readFile(registryPath, "utf8");
  expect((await read())?.name).toBe("alpha");
  expect((await read())?.autostart).toMatchObject({
    paused: true,
    invalid: true,
    lastResult: {
      status: "skipped",
      reason: "invalid_marker",
      at: "1970-01-01T00:00:00.000Z",
    },
  });
  expect(await readProjectsRegistryStrict({ registryPath })).toMatchObject({
    kind: "valid",
    rejected: 0,
    invalidAutostart: 1,
  });
  expect(
    await claimProjectAutostart({ id: "alpha", bootId: "boot-a", registryPath })
  ).toBeNull();
  await setProjectAutostartPaused({ id: "alpha", paused: false, registryPath });
  expect(await readFile(registryPath, "utf8")).toBe(before);
  await expect(
    setProjectAutostart({ id: "alpha", registryPath })
  ).rejects.toThrow("Remove the marker");
  await removeProjectAutostart({ id: "alpha", registryPath });
  expect((await read())?.autostart).toBeUndefined();
  await setProjectAutostart({ id: "alpha", registryPath });
  expect((await read())?.autostart?.paused).toBe(false);
});

test("unrelated intent writes preserve invalid and future markers exactly", async () => {
  const future = {
    branch: "preview",
    paused: false,
    lastAttemptBootId: "previous-boot",
    lastResult: {
      status: "future_status",
      reason: null,
      at: "2026-01-01T00:00:00.000Z",
      extra: { keep: true },
    },
    futureField: "keep",
  };
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      projects: [{ ...entry("alpha"), autostart: future }, entry("beta")],
    })
  );
  expect((await read())?.autostart?.paused).toBe(true);
  expect(
    await claimProjectAutostart({
      id: "alpha",
      bootId: "new-boot",
      registryPath,
    })
  ).toBeNull();
  await setProjectAutostart({ id: "beta", registryPath });
  const persisted = JSON.parse(await readFile(registryPath, "utf8"));
  expect(persisted.projects[0].autostart).toEqual(future);
  await removeProjectAutostart({ id: "alpha", registryPath });
  expect((await read())?.autostart).toBeUndefined();
});

test("ordinary upsert preserves an invalid marker without blocking the project", async () => {
  const raw = { paused: "invalid", future: [1, 2, 3] };
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      projects: [{ ...entry("alpha"), autostart: raw }],
    })
  );
  const projectDir = join(root, "alpha", ".hack");
  await mkdir(projectDir, { recursive: true });
  const configFile = join(projectDir, "hack.config.json");
  const composeFile = join(projectDir, "docker-compose.yml");
  const envFile = join(projectDir, ".env");
  await writeFile(configFile, JSON.stringify({ name: "alpha" }));
  await writeFile(composeFile, "services: {}\n");
  await writeFile(envFile, "");
  await upsertProjectRegistration({
    project: {
      projectRoot: join(root, "alpha"),
      projectDir,
      projectDirName: ".hack",
      composeFile,
      envFile,
      configFile,
    },
  });
  const persisted = JSON.parse(await readFile(registryPath, "utf8"));
  expect(persisted.projects[0].autostart).toEqual(raw);
  expect((await read())?.name).toBe("alpha");
});

test("known markers roundtrip unknown fields through pause and start claims", async () => {
  const marker = {
    branch: null,
    paused: false,
    lastAttemptBootId: null,
    lastResult: {
      status: "started",
      reason: null,
      at: "2026-01-01T00:00:00.000Z",
      futureResult: 42,
    },
    futureMarker: { keep: true },
  };
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      projects: [{ ...entry("alpha"), autostart: marker }],
    })
  );
  await setProjectAutostartPaused({ id: "alpha", paused: true, registryPath });
  await setProjectAutostartPaused({ id: "alpha", paused: false, registryPath });
  await claimProjectAutostart({
    id: "alpha",
    bootId: "new-boot",
    registryPath,
  });
  const persisted = JSON.parse(await readFile(registryPath, "utf8"));
  expect(persisted.projects[0].autostart).toEqual({
    ...marker,
    lastAttemptBootId: "new-boot",
  });
});

test("no mutation loses invalid root registry entries", async () => {
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      projects: [entry("alpha"), { invalid: true }],
    })
  );
  await expect(
    setProjectAutostart({ id: "alpha", registryPath })
  ).rejects.toThrow("registry is invalid");
});

test("unknown and ambiguous ids cannot opt in a different project", async () => {
  await setProjectAutostart({ id: "alpha", registryPath });
  await expect(setProjectAutostart({ id: "", registryPath })).rejects.toThrow(
    "not registered"
  );
  await expect(
    setProjectAutostart({ id: "absent", registryPath })
  ).rejects.toThrow("not registered");
  await writeFile(
    registryPath,
    JSON.stringify({
      version: 1,
      projects: [entry("alpha"), { ...entry("beta"), id: "alpha" }],
    })
  );
  await expect(
    setProjectAutostart({ id: "alpha", registryPath })
  ).rejects.toThrow("Ambiguous project ID");
});
